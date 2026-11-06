import assert from "node:assert/strict";
import test from "node:test";

import { autoStartCompanion, COMPANION_AUTOSTART_RETRY_DELAYS_MS, startCompanionWithRetries } from "./companion-autostart.mjs";

const up = { enabled: true };
const timedOut = { enabled: false, error: "the companion did not come up in time" };

function run(states, { wanted = () => true } = {}) {
  const starts = [];
  const slept = [];
  const lines = [];
  const promise = startCompanionWithRetries({
    start: async () => {
      starts.push(starts.length);
      const next = states.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    wanted,
    log: (line) => lines.push(line),
    sleep: async (ms) => { slept.push(ms); },
  });
  return { promise, starts, slept, lines };
}

test("a start that comes up the first time is not retried and logs nothing", async () => {
  const { promise, starts, slept, lines } = run([up]);
  assert.deepEqual(await promise, up);
  assert.equal(starts.length, 1);
  assert.deepEqual(slept, []);
  assert.deepEqual(lines, []);
});

test("a start that times out after an update is tried again and the companion comes up", async () => {
  const { promise, starts, slept, lines } = run([timedOut, timedOut, up]);
  assert.deepEqual(await promise, up);
  assert.equal(starts.length, 3);
  assert.deepEqual(slept, COMPANION_AUTOSTART_RETRY_DELAYS_MS.slice(0, 2));
  assert.deepEqual(lines, [
    "companion start failed: the companion did not come up in time; trying again in 5s (1 of 3)",
    "companion start failed: the companion did not come up in time; trying again in 15s (2 of 3)",
  ]);
});

test("after every retry fails, the last failure is returned and the log says it gave up", async () => {
  const { promise, starts, slept, lines } = run([timedOut, timedOut, timedOut, timedOut]);
  assert.deepEqual(await promise, timedOut);
  assert.equal(starts.length, 1 + COMPANION_AUTOSTART_RETRY_DELAYS_MS.length);
  assert.deepEqual(slept, [...COMPANION_AUTOSTART_RETRY_DELAYS_MS]);
  assert.equal(lines.at(-1), "companion start failed: the companion did not come up in time; giving up until the app restarts");
});

test("a retry waiting while the companion stops being wanted does not start it", async () => {
  let wanted = true;
  const { promise, starts, lines } = run([timedOut, up], { wanted: () => wanted });
  // The person turns the phone off during the first wait.
  wanted = false;
  assert.deepEqual(await promise, timedOut);
  assert.equal(starts.length, 1);
  assert.equal(lines.at(-1), "companion start retry skipped: the companion is no longer wanted");
});

test("a refusal thrown by the start is never retried", async () => {
  const { promise, starts } = run([new Error("remote access is turned off by your organisation")]);
  await assert.rejects(promise, /turned off by your organisation/);
  assert.equal(starts.length, 1);
});

test("the delays grow and stay within a minute", () => {
  const delays = [...COMPANION_AUTOSTART_RETRY_DELAYS_MS];
  assert.deepEqual(delays, [...delays].sort((a, b) => a - b));
  assert.ok(delays.every((ms) => ms > 0 && ms <= 60_000));
  assert.throws(() => COMPANION_AUTOSTART_RETRY_DELAYS_MS.push(1));
});

test("the launch start waits for the organisation policy before the first start", async () => {
  const order = [];
  let restore;
  const restored = new Promise((resolve) => { restore = resolve; });
  const done = autoStartCompanion({
    restored,
    start: async () => { order.push("start"); return up; },
    wanted: () => true,
    sleep: async () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, []);
  order.push("restored");
  restore();
  assert.deepEqual(await done, up);
  assert.deepEqual(order, ["restored", "start"]);
});

test("the launch start retries a failed start, as startCompanionWithRetries does", async () => {
  const states = [timedOut, up];
  const lines = [];
  const state = await autoStartCompanion({
    start: async () => states.shift(),
    wanted: () => true,
    log: (line) => lines.push(line),
    sleep: async () => {},
  });
  assert.deepEqual(state, up);
  assert.deepEqual(lines, ["companion start failed: the companion did not come up in time; trying again in 5s (1 of 3)"]);
});

test("a refusal or a policy that could not be restored is logged as a skipped auto-start and never rejects", async () => {
  for (const [restored, start] of [
    [undefined, async () => { throw new Error("remote access is turned off by your organisation"); }],
    [Promise.reject(new Error("policy unreadable")), async () => up],
  ]) {
    const lines = [];
    let starts = 0;
    const state = await autoStartCompanion({ restored, start: async () => { starts++; return start(); }, wanted: () => true, log: (line) => lines.push(line) });
    assert.equal(state, null);
    assert.match(lines.at(-1), /^companion auto-start skipped: (remote access is turned off by your organisation|policy unreadable)$/);
    assert.equal(starts, restored ? 0 : 1);
  }
});
