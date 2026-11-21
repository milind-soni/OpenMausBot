import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AppTriggerBroker } from "./app-trigger-broker.ts";
import { AppTriggerManager } from "./app-triggers.ts";

const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-trigger-identity-"));
  folders.push(dir);
  let binds = 0;
  const broker: AppTriggerBroker = {
    triggerTypes: async () => ({}),
    triggerType: async () => ({ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", toolkit: "slack", name: "Message", description: "", config: {}, payload: {} }),
    create: async () => { binds++; return { triggerId: "copy" }; },
    setEnabled: async () => {}, remove: async () => {},
    inventory: async () => ({ triggers: [], unbound: [], limits: { plan: "desktop", eventsPerDay: 100 }, usage: { eventsToday: 0 } }),
    poll: async () => ({ events: [], cursor: 0 }), testEvent: async () => {},
  };
  const options = {
    file: join(dir, "triggers.json"), broker, service: () => ({ available: true as const }),
    connectedApps: async () => ({ slack: { connected: true, accounts: [{ id: "account", status: "ACTIVE" }] } }),
    botState: () => "ready" as const,
    runs: { enqueue: () => ({ id: "run" }), merge: () => null, receipt: () => null, pending: () => 0, cancelQueued: () => {} },
  };
  const manager = new AppTriggerManager(options);
  const create = (id: string) => manager.create({ id, botId: "bot", name: `Watch ${id}`, prompt: `Summarize ${id}`, app: "slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED", enabled: false });
  return { manager, create, binds: () => binds, reopened: () => new AppTriggerManager(options) };
}

it("restores an automation once when two undo requests arrive together", async () => {
  const h = harness();
  const original = await h.create("same");
  await h.manager.remove(original.id);
  const before = h.binds();
  const restored = await Promise.all([h.manager.restore(original.id), h.manager.restore(original.id)]);
  expect(restored.filter(Boolean)).toHaveLength(1);
  expect(h.manager.list()).toHaveLength(1);
  expect(h.reopened().list()).toHaveLength(1);
  expect(h.binds() - before).toBe(1);
});

it("adopts concurrent retries under one durable id", async () => {
  const source = harness();
  const original = await source.create("same");
  const target = harness();
  const copies = await Promise.all([target.manager.adopt(original), target.manager.adopt({ ...original, name: "Newest name" })]);
  expect(copies.map((copy) => copy.id)).toEqual([original.id, original.id]);
  expect(target.manager.list()).toHaveLength(1);
  expect(target.reopened().list()).toHaveLength(1);
  expect(target.manager.get(original.id)?.name).toBe("Newest name");
  expect(target.binds()).toBe(1);
});

it("rejects a duplicate explicit id while allowing unrelated creations", async () => {
  const h = harness();
  await Promise.all([h.create("first"), h.create("second")]);
  await expect(h.create("first")).rejects.toMatchObject({ status: 409 });
  expect(h.manager.list().map((trigger) => trigger.id).sort()).toEqual(["first", "second"]);
});

it("keeps an existing adoption's enabled switch", async () => {
  const h = harness();
  const original = await h.create("same");
  await h.manager.update(original.id, { enabled: true });
  const updated = await h.manager.adopt({ ...original, name: "New name" });
  expect(updated).toMatchObject({ id: original.id, enabled: true, name: "New name" });
  expect(h.manager.list()).toHaveLength(1);
});
