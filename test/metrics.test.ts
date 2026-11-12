import assert from "node:assert/strict";
import test from "node:test";
import { watchMetrics } from "../src/metrics.ts";
import { Sandbox } from "../src/runtime.ts";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("metrics polling doesn't overlap and disposal aborts in-flight stats without rendering again", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0, updates = 0;
  let signal: AbortSignal | undefined;
  let complete!: () => void;
  const s = new Sandbox("/project");
  s.name = "mock-only";
  s.refreshMetrics = async (arg) => {
    signal = arg; calls++;
    await new Promise<void>((r) => { complete = r; });
  };
  const dispose = watchMetrics(s, () => { updates++; });
  assert.equal(calls, 1);
  t.mock.timers.tick(20_000);
  assert.equal(calls, 1);
  complete(); await flush();
  assert.equal(updates, 1);
  t.mock.timers.tick(5_000);
  assert.equal(calls, 2);
  dispose(); dispose();
  assert.equal(signal?.aborted, true);
  complete(); await flush();
  assert.equal(updates, 1);
  t.mock.timers.tick(20_000);
  assert.equal(calls, 2);
});

test("stopped sandboxes are never polled", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const s = new Sandbox("/project");
  s.refreshMetrics = async () => { calls++; };
  const dispose = watchMetrics(s, () => {});
  t.mock.timers.tick(20_000);
  dispose();
  assert.equal(calls, 0);
});
