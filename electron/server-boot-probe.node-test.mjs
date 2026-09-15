import assert from "node:assert/strict";
import test from "node:test";

import { pollServerIdentity } from "./server-boot-probe.mjs";
import { createRestoreStartupProgress } from "./workspace-restore-startup.mjs";

test("a progressing restore exceeds 60 seconds, then gets a fresh normal boot budget", async () => {
  let now = 0;
  const progress = createRestoreStartupProgress(() => now);
  let sequence = 0;
  const outcome = await pollServerIdentity({
    port: 8799, pid: () => 4242, bootTimeoutMs: 60_000,
    now: () => now, sleep: async ms => { now += ms; }, restoreProgress: progress.get,
    fetchImpl: async () => {
      if (now < 120_000) {
        progress.receive({ type: "workspace-restore-progress", phase: "copying", bytes: now, sequence: ++sequence });
        throw new Error("Not listening while restoring");
      }
      if (now === 120_000) progress.receive({ type: "workspace-restore-progress", phase: "done", bytes: now, sequence: ++sequence });
      if (now < 150_000) throw new Error("Starting server");
      return { ok: true, json: async () => ({ app: "openmausbot", pid: 4242, static: true }) };
    },
  });
  assert.equal(outcome.outcome, "ready"); assert.equal(now, 150_000);
});

test("stalled restoration remains bounded and replayed progress does not extend it", async () => {
  let now = 0;
  const progress = createRestoreStartupProgress(() => now);
  const packet = { type: "workspace-restore-progress", phase: "checking", bytes: 0, sequence: 1 };
  assert.equal(progress.receive(packet), true);
  const outcome = await pollServerIdentity({
    port: 8799, pid: () => 4242, bootTimeoutMs: 60_000,
    now: () => now, sleep: async ms => { now += ms; }, restoreProgress: progress.get,
    fetchImpl: async () => { assert.equal(progress.receive(packet), false); throw new Error("stalled"); },
  });
  assert.equal(outcome.outcome, "timeout"); assert.equal(now, 300_000);
  assert.equal(progress.receive({ ...packet, sequence: 2, phase: "done" }), true);
  assert.equal(progress.receive({ ...packet, sequence: 3 }), false);
  const completed = await pollServerIdentity({ port: 8799, pid: () => 4242, bootTimeoutMs: 60_000,
    now: () => now, sleep: async ms => { now += ms; }, restoreProgress: progress.get,
    fetchImpl: async () => { throw new Error("boot stuck after restore"); },
  });
  assert.equal(completed.outcome, "timeout"); assert.equal(now, 360_000);
});

const OUR_BODY = () => ({ app: "openmausbot", pid: 4242, static: true });

function okFetch({ body = OUR_BODY(), status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

test("returns ready when our own child answers with its identity", async () => {
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "ready");
});

test("a never-completing /api/health cannot wedge the launcher past the boot budget", async () => {
  // Hangs until the probe aborts it, exactly like a server that accepts the
  // connection but never writes a response.
  const hangUntilAborted = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  const startedAt = Date.now();
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 300,
    fetchImpl: hangUntilAborted,
  });
  assert.equal(outcome.outcome, "timeout");
  assert.ok(Date.now() - startedAt < 5_000, "must bail out well before an unbounded wait");
});

test("a non-2xx health response is a foreign owner, reported without waiting out the budget", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return { ok: false, status: 503, json: async () => null };
  };
  const startedAt = Date.now();
  const outcome = await pollServerIdentity({
    port: 18799,
    pid: () => 4242,
    bootTimeoutMs: 60_000,
    fetchImpl,
  });
  assert.equal(outcome.outcome, "foreign-owner");
  assert.equal(attempts, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a non-JSON body on an HTTP response counts as a foreign owner too", async () => {
  const outcome = await pollServerIdentity({
    port: 28799,
    pid: () => 4242,
    bootTimeoutMs: 60_000,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => "not json-shaped" }),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});

test("an incomplete response body that reaches the deadline is a timeout", async () => {
  let atDeadline = false;
  const outcome = await pollServerIdentity({
    port: 28799,
    pid: () => 4242,
    bootTimeoutMs: 1_000,
    now: () => (atDeadline ? 1_000 : 0),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        atDeadline = true;
        throw new DOMException("body aborted", "AbortError");
      },
    }),
  });
  assert.equal(outcome.outcome, "timeout");
});

test("an identity mismatch (same payload shape, wrong pid) stays foreign", async () => {
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch({ body: { app: "openmausbot", pid: 999, static: true } }),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});

test("a response that lands after the deadline never returns ready", async () => {
  // The clock crosses the budget while the matching response is in flight.
  let reads = 0;
  const now = () => [0, 0, 1_001][Math.min(reads++, 2)];
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 1_000,
    now,
    sleep: async () => {},
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "timeout");
});

test("connection failures keep retrying until the budget runs out", async () => {
  let attempts = 0;
  const refused = async () => {
    attempts += 1;
    throw new Error("ECONNREFUSED");
  };
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 1_500,
    fetchImpl: refused,
    sleep: async () => {},
  });
  assert.equal(outcome.outcome, "timeout");
  assert.ok(attempts >= 2, `expected several polls, saw ${attempts}`);
});

test("reports exit instead of polling after the child has died", async () => {
  let attempts = 0;
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 5_000,
    isExited: () => true,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("should not be reached");
    },
  });
  assert.equal(outcome.outcome, "exited");
  assert.equal(attempts, 0);
});

test("regression: a pid read before the spawn event must not doom our own child", async () => {
  // Mirrors the packaged-app smoke failure: Electron's utilityProcess assigns
  // proc.pid on the async `spawn` event, so a value captured at fork() time is
  // undefined while the child is already binding its port. The first probe is
  // refused (still booting), the second gets our child's real identity — and
  // the pid getter now reports the spawned pid. A pid *value* captured at
  // fork time turned this exact sequence into "foreign-owner" + a reaped
  // healthy child.
  let spawned = false;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({ app: "openmausbot", pid: 4242, static: true }) };
  };
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => (spawned ? 4242 : undefined),
    bootTimeoutMs: 5_000,
    sleep: async () => {
      spawned = true; // the spawn event lands while we back off between polls
    },
    fetchImpl,
  });
  assert.equal(outcome.outcome, "ready");
  assert.equal(calls, 2);
});

test("an answer that arrives while the pid is still unknown is a foreign owner", async () => {
  // A child that has not spawned yet cannot be listening; if somebody
  // answers anyway, it is genuinely not ours.
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => undefined,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});
