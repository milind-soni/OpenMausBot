import assert from "node:assert/strict";
import test from "node:test";

import { createRestartCoordinator } from "./restart-coordinator.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("restart waits for the drain to become idle before handing off to the installer", async () => {
  let status = { activeTurns: 1, activeWorkers: 1 };
  const calls = [];
  const coordinator = createRestartCoordinator({
    prepare: async () => calls.push("prepare"),
    status: async () => status,
    abort: async () => calls.push("abort"),
    sleep: async () => {
      calls.push("sleep");
      status = { activeTurns: 0, activeWorkers: 0 };
    },
    pollMs: 1,
    timeoutMs: 100,
  });

  const handoff = coordinator.waitForIdle();
  assert.deepEqual(calls, ["prepare"]);
  assert.equal(await handoff, true);
  assert.deepEqual(calls, ["prepare", "sleep"]);
});

test("restart checkpoints after closing admission and before waiting for idle", async () => {
  const order = [];
  const coordinator = createRestartCoordinator({
    prepare: async () => order.push("prepare"),
    checkpoint: async () => order.push("checkpoint"),
    status: async () => {
      order.push("status");
      return { idle: true };
    },
  });

  assert.equal(await coordinator.waitForIdle(), true);
  assert.deepEqual(order, ["prepare", "checkpoint", "status"]);
});

test("a failed checkpoint aborts the drain and never reports readiness", async () => {
  const calls = [];
  const coordinator = createRestartCoordinator({
    prepare: async () => calls.push("prepare"),
    checkpoint: async () => {
      calls.push("checkpoint");
      throw new Error("checkpoint failed");
    },
    status: async () => {
      calls.push("status");
      return { idle: true };
    },
    abort: async () => calls.push("abort"),
  });

  await assert.rejects(coordinator.waitForIdle(), /checkpoint failed/);
  assert.deepEqual(calls, ["prepare", "checkpoint", "abort"]);
});

test("restart timeout aborts the drain and never reports readiness", async () => {
  const calls = [];
  const coordinator = createRestartCoordinator({
    prepare: async () => calls.push("prepare"),
    status: async () => ({ activeTurns: 1, activeWorkers: 0 }),
    abort: async () => calls.push("abort"),
    sleep: async () => {},
    pollMs: 1,
    timeoutMs: 2,
    now: (() => {
      let value = 0;
      return () => (value += 1);
    })(),
  });

  await assert.rejects(coordinator.waitForIdle(), /active work did not become idle/);
  assert.deepEqual(calls, ["prepare", "abort"]);
});

test("a concurrent request shares one drain operation", async () => {
  const gate = deferred();
  let prepares = 0;
  const coordinator = createRestartCoordinator({
    prepare: async () => {
      prepares += 1;
      await gate.promise;
    },
    status: async () => ({ activeTurns: 0, activeWorkers: 0 }),
    abort: async () => {},
  });

  const first = coordinator.waitForIdle();
  const second = coordinator.waitForIdle();
  assert.strictEqual(first, second);
  assert.equal(prepares, 1);
  gate.resolve();
  assert.equal(await first, true);
});
