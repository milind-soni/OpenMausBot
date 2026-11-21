import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { AppTriggerBroker, BrokerInventory } from "./app-trigger-broker.ts";
import { AppTriggerManager } from "./app-triggers.ts";

// tsconfig.server.json targets ES2023: Promise.withResolvers is ES2024.
function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const inventory: BrokerInventory = {
  triggers: [{ triggerId: "remote", slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", toolkit: "slack", connectedAccountId: "account", enabled: true, remote: { state: "enabled" }, dropped: {} }],
  unbound: [], limits: { plan: "desktop", eventsPerDay: 100 }, usage: { eventsToday: 0 },
};

async function harness(overrides: Partial<AppTriggerBroker>) {
  const dir = mkdtempSync(join(tmpdir(), "omb-trigger-lifecycle-"));
  folders.push(dir);
  const enqueue = vi.fn(() => ({ id: "run" }));
  const broker: AppTriggerBroker = {
    triggerTypes: async () => ({}),
    triggerType: async () => ({ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", toolkit: "slack", name: "Message", description: "", config: {}, payload: {} }),
    create: async () => ({ triggerId: "remote" }), setEnabled: async () => {}, remove: async () => {},
    inventory: async () => inventory, poll: async () => ({ events: [], cursor: 0 }), testEvent: async () => {}, ...overrides,
  };
  const manager = new AppTriggerManager({
    file: join(dir, "triggers.json"), broker, service: () => ({ available: true }),
    connectedApps: async () => ({ slack: { connected: true, accounts: [{ id: "account", status: "ACTIVE" }] } }), botState: () => "ready",
    runs: { enqueue, merge: () => null, receipt: () => null, pending: () => 0, cancelQueued: () => {} },
  });
  await manager.create({ botId: "bot", name: "Watch", prompt: "Summarize", app: "slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED" });
  return { manager, enqueue };
}

it("retires an old loop when restarted during reconciliation and keeps the replacement joinable", async () => {
  const first = withResolvers<BrokerInventory>(), second = withResolvers<BrokerInventory>();
  const entered = withResolvers<void>(), unexpectedPoll = withResolvers<void>();
  let inventories = 0;
  const { manager } = await harness({
    inventory: () => { inventories++; entered.resolve(); return inventories === 1 ? first.promise : second.promise; },
    poll: async ({ signal }) => {
      signal?.throwIfAborted();
      unexpectedPoll.resolve();
      return new Promise((resolve) => signal!.addEventListener("abort", () => resolve({ events: [], cursor: 0 }), { once: true }));
    },
  });
  manager.start();
  await entered.promise;
  const firstStop = manager.stop();
  manager.start();
  try {
    first.resolve(inventory);
    expect(await Promise.race([firstStop.then(() => "stopped"), unexpectedPoll.promise.then(() => "polled")])).toBe("stopped");
    let joined = false;
    const secondStop = manager.stop().then(() => { joined = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(joined).toBe(false);
    second.resolve(inventory);
    await secondStop;
    expect(inventories).toBe(2);
  } finally {
    first.resolve(inventory);
    second.resolve(inventory);
    await manager.stop();
    await firstStop;
  }
});

it("leaves an aborted poll's late events unacknowledged and unstarted", async () => {
  const received = withResolvers<Awaited<ReturnType<AppTriggerBroker["poll"]>>>();
  const seenCursors: number[] = [];
  const { manager, enqueue } = await harness({ poll: ({ after }) => { seenCursors.push(after); return received.promise; } });
  const controller = new AbortController();
  const polled = manager.pollOnce(controller.signal);
  controller.abort();
  received.resolve({ events: [{ id: "event", seq: 1, kind: "message", triggerId: "remote", receivedAt: Date.now(), event: { data: { text: "New message" } } }], cursor: 1 });
  expect(await polled).toBe(0);
  expect(enqueue).not.toHaveBeenCalled();
  expect(manager.attempts()).toEqual([]);
  await manager.pollOnce();
  expect(seenCursors).toEqual([0, 0]);
  expect(enqueue).toHaveBeenCalledOnce();
});

it("keeps start idempotent and lets wake replace only the current wait", async () => {
  const first = withResolvers<void>(), second = withResolvers<void>();
  const signals: AbortSignal[] = [];
  const { manager } = await harness({ poll: async ({ signal }) => {
    signals.push(signal!);
    (signals.length === 1 ? first : second).resolve();
    return new Promise((resolve) => signal!.addEventListener("abort", () => resolve({ events: [], cursor: 0 }), { once: true }));
  } });
  manager.start();
  manager.start();
  try {
    await first.promise;
    expect(signals).toHaveLength(1);
    manager.wake();
    await second.promise;
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  } finally { await manager.stop(); }
  expect(signals[1]!.aborted).toBe(true);
});
