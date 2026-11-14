import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOT_PROBE_FAST_INTERVAL_MS,
  BOOT_PROBE_FAST_WINDOW_MS,
  BOOT_PROBE_INTERVAL_MS,
  bootFailureMessage,
  listeningSignal,
  pollServerIdentity,
} from "./server-boot-probe.mjs";

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
  // Hangs until the probe aborts it, like a server that accepts the connection but never responds.
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
      spawned = true;
    },
    fetchImpl,
  });
  assert.equal(outcome.outcome, "ready");
  assert.equal(calls, 2);
});

test("an answer that arrives while the pid is still unknown is a foreign owner", async () => {
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => undefined,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});

// A fake clock that moves only when the probe sleeps or a fetch costs time, so the poll schedule is asserted exactly.
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.sleeps.push({ at: clock.t, ms });
    clock.t += ms;
  };
  return clock;
}

test("a server that binds shortly after fork is noticed within one fast poll", async () => {
  // A typical packaged boot: the child listens a couple hundred ms after fork.
  const listensAt = 215;
  const clock = fakeClock();
  const fetchImpl = async () => {
    clock.t += 1;
    if (clock.t < listensAt) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => OUR_BODY() };
  };
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 60_000,
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl,
  });
  assert.equal(outcome.outcome, "ready");
  assert.ok(
    outcome.latencyMs - listensAt <= BOOT_PROBE_FAST_INTERVAL_MS + 1,
    `noticed ${outcome.latencyMs - listensAt} ms after the server listened`,
  );
});

test("polls fast during the usual boot window, then falls back to the slow interval", async () => {
  const clock = fakeClock();
  const bootTimeoutMs = BOOT_PROBE_FAST_WINDOW_MS + 3 * BOOT_PROBE_INTERVAL_MS;
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs,
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(outcome.outcome, "timeout");
  const early = clock.sleeps.filter(({ at }) => at < BOOT_PROBE_FAST_WINDOW_MS);
  const late = clock.sleeps.filter(({ at }) => at >= BOOT_PROBE_FAST_WINDOW_MS);
  assert.ok(early.length > 0 && early.every(({ ms }) => ms === BOOT_PROBE_FAST_INTERVAL_MS));
  assert.deepEqual(
    late.map(({ ms }) => ms),
    [BOOT_PROBE_INTERVAL_MS, BOOT_PROBE_INTERVAL_MS, BOOT_PROBE_INTERVAL_MS],
  );
});

test("each probe's abort timer is the remaining boot budget, not the poll interval", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout");
  const clock = fakeClock();
  const bootTimeoutMs = 1_000;
  const remainingAtFetch = [];
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs,
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async () => {
      remainingAtFetch.push(bootTimeoutMs - clock.t);
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(outcome.outcome, "timeout");
  assert.ok(remainingAtFetch.length > 1);
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments[0]),
    remainingAtFetch,
  );
});

test("a child that says it is listening gets the grace before it times out", async () => {
  const startedAt = Date.now();
  // Answers only after the plain budget, like a listening server too loaded to reply.
  const lateFetch = async (...args) => {
    if (Date.now() - startedAt < 400) throw new Error("ECONNREFUSED");
    return okFetch()(...args);
  };
  const probe = (listening) => pollServerIdentity({
    port: 8799, pid: () => 4242, bootTimeoutMs: 200, listeningGraceMs: 2_000,
    isListening: () => listening, fetchImpl: lateFetch,
  });
  const plain = await probe(false);
  assert.equal(plain.outcome, "timeout");
  assert.ok(plain.waitedMs >= 200);
  assert.equal(
    bootFailureMessage(8799, { outcome: "timeout", waitedMs: 240_000 }),
    "child on port 8799 did not answer /api/health within 240s",
  );
  assert.equal((await probe(true)).outcome, "ready");
});

test("the listening line is heard when stdout splits it across chunks", () => {
  const listening = listeningSignal();
  listening.hear("boot… openmausbot ser");
  assert.equal(listening.heard(), false);
  listening.hear("ver on http://127.0.0.1:8799\n");
  assert.equal(listening.heard(), true);
  listening.hear("later output");
  assert.equal(listening.heard(), true);
  const quiet = listeningSignal();
  quiet.hear("nothing to see");
  assert.equal(quiet.heard(), false);
});

test("an answer in flight when the child starts listening gets the grace", async () => {
  let listening = false;
  // The answer lands after the plain budget; the child says it is listening meanwhile.
  const slowAnswer = async (...args) => {
    setTimeout(() => { listening = true; }, 50);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return okFetch()(...args);
  };
  const outcome = await pollServerIdentity({
    port: 8799, pid: () => 4242, bootTimeoutMs: 1_000, listeningGraceMs: 2_000,
    isListening: () => listening, fetchImpl: slowAnswer,
    now: (() => { const t0 = Date.now(); return () => t0 + (Date.now() - t0) * 5; })(),
  });
  assert.equal(outcome.outcome, "ready");
});
