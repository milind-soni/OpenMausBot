import assert from "node:assert/strict";
import test from "node:test";
import { ASLEEP_HOLD_MS, CloudAsleepError, SIGNED_IN_MS, WAKING_SHOWN_AFTER_MS, WAKING_SIGNED_IN_MS, asleepAnswer, createCloudPowerGate, openSleepingCloud } from "./cloud-power.mjs";

const AT = 1_792_355_000_000;
function clockTimers() {
  const pending = new Set();
  return {
    pending,
    setTimer: (work, ms) => { const timer = { work, ms }; pending.add(timer); return timer; },
    clearTimer: timer => pending.delete(timer),
    fire: () => { for (const timer of Array.from(pending)) { pending.delete(timer); timer.work(); } },
  };
}

test("without the Admin's cloud.power nothing is ever asleep, and nothing waits", async () => {
  const gate = createCloudPowerGate();
  assert.equal(gate.asleep(), false);
  assert.equal(gate.awaiting(), false);
  assert.equal(gate.signal().aborted, false);
  await gate.wait();
  gate.changed();
  gate.woke();
  assert.equal(gate.asleep(), false);
});

test("asleep while the Admin says so; work held open is cut and waiting work resumes once it is awake or waking", async () => {
  let power = { state: "awake", since: AT, sleeps: true };
  let wanted = true;
  const gate = createCloudPowerGate({ power: () => power, wanted: () => wanted });
  assert.equal(gate.asleep(), false);
  const held = gate.signal();
  power = { state: "asleep", since: AT + 1, sleeps: true };
  gate.changed();
  assert.equal(gate.asleep(), true);
  assert.equal(gate.awaiting(), true);
  wanted = false;
  assert.equal(gate.awaiting(), false, "the session is read faster only while Files or lending waits");
  assert.ok(held.aborted);
  assert.ok(held.reason instanceof CloudAsleepError);
  let resumed = false;
  const waiting = gate.wait().then(() => { resumed = true; });
  gate.changed();
  await new Promise(setImmediate);
  assert.equal(resumed, false);
  power = { state: "waking", since: AT + 2, sleeps: true };
  gate.changed();
  await waiting;
  assert.equal(resumed, true);
  assert.equal(gate.signal().aborted, false, "a fresh signal for the next held call");
});

test("a call answered asleep holds work until the Admin reports a new power state, the person opens My Cloud, or the sleep never came", async () => {
  let power = { state: "awake", since: AT, sleeps: true }, now = AT + 10_000;
  const timers = clockTimers();
  const gate = createCloudPowerGate({ power: () => power, now: () => now, ...timers });
  gate.hold();
  assert.equal(gate.asleep(), true);
  gate.changed();
  assert.equal(gate.asleep(), true, "the same awake word as before the answer is not a wake");
  power = { state: "asleep", since: AT + 20_000, sleeps: true };
  assert.equal(gate.asleep(), true);
  power = { state: "awake", since: AT + 30_000, sleeps: true };
  assert.equal(gate.asleep(), false);

  power = { state: "awake", since: AT + 30_000, sleeps: true };
  gate.hold();
  assert.equal(gate.asleep(), true);
  gate.woke();
  assert.equal(gate.asleep(), false);

  gate.hold();
  const waiting = gate.wait();
  now += ASLEEP_HOLD_MS;
  timers.fire();
  await waiting;
  assert.equal(gate.asleep(), false);

  const quiet = createCloudPowerGate({ now: () => now, ...clockTimers() });
  quiet.hold();
  assert.equal(quiet.asleep(), true, "a home on a plan the Admin says nothing about is held too, until the hold runs out");
  now += ASLEEP_HOLD_MS;
  assert.equal(quiet.asleep(), false);
});

test("waiting ends when its own work is cancelled", async () => {
  const gate = createCloudPowerGate({ power: () => ({ state: "asleep", since: AT, sleeps: true }) });
  const stop = new AbortController();
  const waiting = gate.wait(stop.signal);
  stop.abort();
  await waiting;
  await gate.wait(stop.signal);
});

test("only a 503 that says asleep is My Cloud going to sleep", () => {
  const answer = (status, headers = {}) => new Response(null, { status, headers });
  assert.equal(asleepAnswer(answer(503, { "x-omb-cloud-power": "asleep" })), true);
  assert.equal(asleepAnswer(answer(503)), false);
  assert.equal(asleepAnswer(answer(503, { "x-omb-cloud-power": "awake" })), false);
  assert.equal(asleepAnswer(answer(200, { "x-omb-cloud-power": "asleep" })), false);
  assert.equal(asleepAnswer({ status: 503 }), false);
  assert.equal(asleepAnswer(null), false);
});

test("opening My Cloud: as before without power; a sleeping one is woken first and given 30 s to answer", async () => {
  const calls = [];
  const signedIn = async ms => { calls.push(["signed-in", ms]); return true; };
  const wake = async () => { calls.push(["wake"]); return "awake"; };
  const waking = on => calls.push(["waking", on]);
  assert.equal(await openSleepingCloud({ power: null, wake, signedIn, waking }), true);
  assert.equal(await openSleepingCloud({ power: { state: "awake", since: AT, sleeps: true }, wake, signedIn, waking }), true);
  assert.deepEqual(calls, [["signed-in", SIGNED_IN_MS], ["signed-in", SIGNED_IN_MS]]);
  calls.length = 0;
  const timers = clockTimers();
  assert.equal(await openSleepingCloud({ power: { state: "asleep", since: AT, sleeps: true }, wake, signedIn, waking, ...timers }), true);
  assert.deepEqual(calls, [["wake"], ["signed-in", WAKING_SIGNED_IN_MS]], "a quick wake shows no waking state");
  assert.equal(timers.pending.size, 0);
});

test("a slow wake says so after a moment and stops saying it when done, even when the Admin can't be reached", async () => {
  const calls = [];
  const timers = clockTimers();
  let finish;
  const opening = openSleepingCloud({
    power: { state: "asleep", since: AT, sleeps: true }, ...timers,
    wake: () => new Promise((resolve, reject) => { finish = () => reject(new Error("offline")); }),
    signedIn: async ms => { calls.push(["signed-in", ms]); return false; },
    waking: on => calls.push(["waking", on]),
  });
  await new Promise(setImmediate);
  assert.deepEqual([...timers.pending].map(timer => timer.ms), [WAKING_SHOWN_AFTER_MS]);
  timers.fire();
  finish();
  assert.equal(await opening, false);
  assert.deepEqual(calls, [["waking", true], ["signed-in", WAKING_SIGNED_IN_MS], ["waking", false]]);
});
