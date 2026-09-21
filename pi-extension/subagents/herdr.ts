/**
 * herdr surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: split a pane, type a command into it, read its output, close it, and
 * poll for exit. Keeping the herdr calls isolated here means index.ts stays
 * testable without a multiplexer running.
 *
 * Panes are identified by herdr pane ids (e.g. `w1:p12`). Splits never steal
 * keyboard focus (`--no-focus`) and default to the parent pi's pane
 * (`HERDR_PANE_ID`) so they follow the agent rather than the user's focus.
 *
 * herdr has no window re-tiling (no `select-layout` equivalent), so repeated
 * parallel spawns would otherwise collapse into ever-narrower columns. Each
 * split instead targets the largest pane this module owns — a largest-first
 * binary partition that converges on near-even tiling.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

/** herdr binary: Herdr exports its own path in HERDR_BIN_PATH, else PATH lookup. */
const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside a Herdr-managed pane with the herdr binary on PATH.
 * Herdr sets HERDR_ENV=1 in every process it spawns from a managed pane.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand(HERDR_BIN);
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside Herdr (run `herdr`, then start pi from one of its panes).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

interface PaneGeometry {
  pane_id: string;
  width: number;
  height: number;
}

/**
 * Panes this module created in the parent's tab (herdr pane ids, e.g. `w1:p12`).
 * Cleared entries are dropped lazily on the next layout query. Module state,
 * so after a /reload it starts empty and splits target the parent pane again
 * (cosmetic degradation only).
 */
const trackedPanes = new Set<string>();

/** The parent pi's pane id — splits follow the agent, not the user's focus. */
function parentPaneId(): string | null {
  return process.env.HERDR_PANE_ID ?? null;
}

/** Current geometry of every pane in the parent's tab, or null on failure. */
function getTabPanes(): PaneGeometry[] | null {
  const parent = parentPaneId();
  if (!parent) return null;
  try {
    const out = execFileSync(HERDR_BIN, ["pane", "layout", "--pane", parent], {
      encoding: "utf8",
      // Pipe stderr: herdr reports server errors as JSON there — keep them in
      // the thrown error object instead of leaking to the parent's terminal.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const panes = JSON.parse(out)?.result?.layout?.panes;
    if (!Array.isArray(panes)) return null;
    return panes
      .filter((p: any) => typeof p?.pane_id === "string" && typeof p?.rect?.width === "number")
      .map((p: any) => ({ pane_id: p.pane_id, width: p.rect.width, height: p.rect.height }));
  } catch {
    return null;
  }
}

/**
 * Which way to split a w×h pane: Herdr's own guidance is to split wide panes
 * to the right and tall/narrow panes down. Floors keep the halves usable —
 * never split right below ~30 columns or down below ~10 rows while a sane
 * alternative exists.
 */
function chooseSplitDirection(width: number, height: number): "right" | "down" {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const wide = width >= height * 1.6;
  if (halfWidth >= 30 && (wide || halfHeight < 10)) return "right";
  if (halfHeight >= 10 && (!wide || halfWidth < 30)) return "down";
  // Both halves would be cramped — pick the least cramped orientation.
  return halfWidth >= halfHeight ? "right" : "down";
}

/**
 * Pick which pane to split next. Candidates are the parent pane plus every
 * tracked pane still alive in its tab; the largest by area wins so parallel
 * spawns tile the tab evenly instead of repeatedly halving one pane. Area
 * ties prefer the parent — splitting the caller's own pane beats shrinking a
 * live subagent's pane for the same tiling result.
 *
 * Returns null target when the parent pane is unknown (fall back to
 * `--current`), or the target/direction pair otherwise. Layout-query failures
 * degrade to a right split off the parent — spawning must never fail because
 * a cosmetic tiling hint was unavailable.
 */
function chooseSplitTarget(): { target: string | null; direction: "right" | "down" } {
  const parent = parentPaneId();
  if (!parent) return { target: null, direction: "right" };
  const panes = getTabPanes();
  if (!panes) return { target: parent, direction: "right" };

  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  for (const id of trackedPanes) {
    if (!byId.has(id)) trackedPanes.delete(id);
  }

  const owned = [
    byId.get(parent),
    ...[...trackedPanes].map((id) => byId.get(id)),
  ].filter((p): p is PaneGeometry => !!p);
  if (owned.length === 0) return { target: parent, direction: "right" };

  let best = owned[0];
  for (const p of owned) {
    if (p.width * p.height > best.width * best.height) best = p;
  }
  const parentGeom = byId.get(parent);
  if (parentGeom && parentGeom.width * parentGeom.height === best.width * best.height) {
    best = parentGeom;
  }
  return { target: best.pane_id, direction: chooseSplitDirection(best.width, best.height) };
}

// ── Surface primitives ──

/** Split a pane and return the new pane id (e.g. `w1:p12`). */
function splitPane(
  target: string | null,
  direction: "right" | "down",
  cwd: string,
  focus: boolean,
): string {
  requireHerdr();

  const args = ["pane", "split"];
  args.push(target ?? "--current");
  args.push("--direction", direction);
  args.push("--cwd", cwd);
  args.push(focus ? "--focus" : "--no-focus");

  const out = execFileSync(HERDR_BIN, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const paneId = JSON.parse(out)?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(`Unexpected herdr pane split output: ${out}`);
  }

  trackedPanes.add(paneId);
  return paneId;
}

/**
 * Create a new pane for a subagent: a split of the largest pane this module
 * owns (the parent pi's pane, or a previously created subagent pane when that
 * tiles better — see chooseSplitTarget), never stealing keyboard focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `w1:p12`).
 */
export function createSurface(name: string): string {
  void name;
  const { target, direction } = chooseSplitTarget();
  return splitPane(target, direction, process.cwd(), false);
}

/**
 * Create a new split in the given direction from an optional source pane
 * (defaults to the parent pi's pane). Returns the new pane id.
 */
export function createSurfaceSplit(
  name: string,
  direction: "right" | "down",
  fromSurface?: string,
  opts?: { focus?: boolean },
): string {
  void name;
  return splitPane(fromSurface ?? parentPaneId(), direction, process.cwd(), opts?.focus === true);
}

/**
 * Send a command string to a pane and execute it.
 * `herdr pane run` writes the text to the pane's terminal input followed by
 * Enter as one ordered submission — literal bytes, not interpreted keys, so
 * special characters pass through untouched (same contract as tmux's
 * `send-keys -l` + Enter).
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  execFileSync(HERDR_BIN, ["pane", "run", surface, command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the recent output of a pane (sync). Soft-wrapped lines are joined
 * (`recent-unwrapped`) so log and transcript content matches byte-for-byte.
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return execFileSync(
    HERDR_BIN,
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * Read the recent output of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(
    HERDR_BIN,
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  try {
    execFileSync(HERDR_BIN, ["pane", "close", surface], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    trackedPanes.delete(surface);
  }
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal output for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
