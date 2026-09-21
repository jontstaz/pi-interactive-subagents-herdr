/**
 * Integration tests for the herdr spawn/poll/close flow.
 *
 * Drives the herdr surface exactly the way launchSubagent + watchSubagent do —
 * smart split, launch script via sendLongCommand, pollForExit sentinel
 * detection, closeSurface — without LLM calls. Fast and free.
 *
 * Run inside Herdr:
 *   herdr   (then run `npm run test:integration` from a pane)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  untrackSurface,
  sendLongCommand,
  readScreen,
  closeSurface,
  sleep,
  type TestEnv,
} from "./harness.ts";
import { pollForExit } from "../../pi-extension/subagents/herdr.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  Herdr is not available — skipping herdr-flow integration tests");
  console.log("   Run inside Herdr to enable these tests.");
}

for (const backend of backends) {
  describe(`herdr-flow [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("pollForExit detects the terminal sentinel with the shell exit code", async () => {
      const surface = createTrackedSurface(env, "sentinel-ok");
      await sleep(1500);

      // Mirrors the launch command shape: <cmd>; echo '__SUBAGENT_DONE_'$?'__'
      sendLongCommand(surface, `sleep 1 && echo SMOKE_OK; echo '__SUBAGENT_DONE_'$?'__'`);

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 500,
      });
      assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });

      const screen = readScreen(surface, 20);
      assert.ok(screen.includes("SMOKE_OK"), `Expected SMOKE_OK on screen. Got:\n${screen}`);
    });

    it("pollForExit propagates a non-zero exit code from the sentinel", async () => {
      const surface = createTrackedSurface(env, "sentinel-fail");
      await sleep(1500);

      sendLongCommand(surface, `false; echo '__SUBAGENT_DONE_'$?'__'`);

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 500,
      });
      assert.deepEqual(result, { reason: "sentinel", exitCode: 1 });
    });

    it("polls two surfaces in parallel without cross-talk", async () => {
      const surfaceA = createTrackedSurface(env, "parallel-a");
      const surfaceB = createTrackedSurface(env, "parallel-b");
      await sleep(1500);
      assert.notEqual(surfaceA, surfaceB);

      sendLongCommand(surfaceA, `sleep 3; echo '__SUBAGENT_DONE_'$?'__'`);
      sendLongCommand(surfaceB, `sleep 1; echo '__SUBAGENT_DONE_'$?'__'`);

      const [resultA, resultB] = await Promise.all([
        pollForExit(surfaceA, new AbortController().signal, { interval: 500 }),
        pollForExit(surfaceB, new AbortController().signal, { interval: 500 }),
      ]);
      assert.deepEqual(resultA, { reason: "sentinel", exitCode: 0 });
      assert.deepEqual(resultB, { reason: "sentinel", exitCode: 0 });
    });

    it("closeSurface throws when the pane is already gone", async () => {
      const surface = createTrackedSurface(env, "double-close");
      await sleep(1500);

      closeSurface(surface);
      untrackSurface(env, surface);
      assert.throws(() => closeSurface(surface));
    });
  });
}
