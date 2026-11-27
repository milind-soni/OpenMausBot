import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { AppTriggerBroker } from "./app-trigger-broker.ts";
import { AppTriggerManager } from "./app-triggers.ts";
import { AppTriggerRequestService, type AppTriggerRequestCard } from "./app-trigger-requests.ts";

const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-trigger-switch-"));
  folders.push(dir);
  let exists = false, enabled = false;
  const broker: AppTriggerBroker = {
    triggerTypes: async () => ({}),
    triggerType: async () => ({ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", toolkit: "slack", name: "Message", description: "", config: {}, payload: {} }),
    create: async () => { if (!exists) { exists = true; enabled = true; } return { triggerId: "shared-copy" }; },
    setEnabled: async (_id, value) => { enabled = value; },
    remove: async () => { exists = false; enabled = false; },
    inventory: async () => ({ triggers: [], unbound: [], limits: { plan: "desktop", eventsPerDay: 100 }, usage: { eventsToday: 0 } }),
    poll: async () => ({ events: [], cursor: 0 }),
    testEvent: async () => {},
  };
  const options = {
    file: join(dir, "triggers.json"), broker, service: () => ({ available: true as const }),
    connectedApps: async () => ({ slack: { connected: true, accounts: [{ id: "account", status: "ACTIVE" }] } }),
    botState: () => "ready" as const,
    runs: { enqueue: () => ({ id: "run" }), merge: () => null, receipt: () => null, pending: () => 0, cancelQueued: () => {} },
  };
  const manager = new AppTriggerManager(options);
  const create = (botId: string, on: boolean) => manager.create({ botId, name: `Watch ${botId}`, prompt: "Summarize new messages", app: "slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED", enabled: on });
  return { manager, create, remoteEnabled: () => enabled, reopened: () => new AppTriggerManager(options) };
}

it.each([true, false])("restores a lone automation with its saved enabled state: %s", async (enabled) => {
  const h = harness();
  const first = await h.create("first", enabled);
  await h.manager.remove(first.id);
  const restored = await h.manager.restore(first.id);
  expect(restored?.enabled).toBe(enabled);
  expect(h.remoteEnabled()).toBe(enabled);
  expect(h.reopened().get(first.id)?.enabled).toBe(enabled);
});

it("enables an existing paused service copy when a new active automation shares it", async () => {
  const h = harness();
  await h.create("paused", false);
  expect(h.remoteEnabled()).toBe(false);
  const active = await h.create("active", true);
  expect(active.remote.triggerId).toBe("shared-copy");
  expect(h.remoteEnabled()).toBe(true);
  await h.manager.update(active.id, { enabled: false });
  expect(h.remoteEnabled()).toBe(false);
});

it("enables a restored automation even when only a paused sibling remains", async () => {
  const h = harness();
  const active = await h.create("active", true);
  await h.create("paused", false);
  await h.manager.remove(active.id);
  expect(h.remoteEnabled()).toBe(false);
  await h.manager.restore(active.id);
  expect(h.remoteEnabled()).toBe(true);
});

it("keeps a shared copy on when a paused automation is created or restored beside an active one", async () => {
  const h = harness();
  await h.create("active", true);
  const paused = await h.create("paused", false);
  expect(h.remoteEnabled()).toBe(true);
  await h.manager.remove(paused.id);
  await h.manager.restore(paused.id);
  expect(h.remoteEnabled()).toBe(true);
});

it("switches a retained service copy off as soon as its last active automation is removed", async () => {
  const h = harness();
  const active = await h.create("active", true);
  const paused = await h.create("paused", false);
  await h.manager.remove(active.id);
  expect(h.manager.get(paused.id)?.remote.triggerId).toBe("shared-copy");
  expect(h.remoteEnabled()).toBe(false);
});

it.each([
  ["pause", false, false], ["pause", true, false], ["resume", false, false], ["resume", true, false],
  ["pause", true, true], ["resume", false, true],
] as const)("restores local and service state after undoing %s from %s (legacy: %s)", async (action, enabled, legacy) => {
  const h = harness();
  const config = { channel: "fixture-config-private" };
  const filter = { text: "important" };
  const prompt = "Use token=fixture-private-value.";
  const saved = await h.manager.create({ botId: "first", name: "Status fixture", prompt, config, filter, app: "slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED", enabled });
  const messages: Array<{ id: string; card: AppTriggerRequestCard }> = [];
  const store = {
    messagesFor: () => messages,
    appendMessage: (_threadId: string, message: { card: AppTriggerRequestCard }) => {
      const stored = { id: "receipt", card: message.card };
      messages.push(stored);
      return stored;
    },
    patchMessage: (_threadId: string, _messageId: string, patch: { card: AppTriggerRequestCard }) => { messages[0]!.card = patch.card; },
  };
  const service = new AppTriggerRequestService({ store, triggers: h.manager, botName: () => "First" });
  const applied = await service.submit({ botId: "first", threadId: "thread", operation: { action, triggerId: saved.id } });
  expect(h.manager.get(saved.id)?.enabled).toBe(action === "resume");
  expect(JSON.stringify(messages[0]!.card)).not.toContain("fixture-private-value");
  expect(JSON.stringify(messages[0]!.card)).not.toContain("fixture-config-private");
  expect(messages[0]!.card.appTriggerRequest?.undo?.before?.filter).toBeUndefined();
  if (legacy) delete messages[0]!.card.appTriggerRequest!.undo!.before;
  expect(await service.undo({ botId: "first", threadId: "thread", requestId: applied.requestId })).toMatchObject({ state: "undone" });
  expect(h.manager.get(saved.id)?.enabled).toBe(enabled);
  expect(h.remoteEnabled()).toBe(enabled);
  expect(h.reopened().get(saved.id)).toMatchObject({ enabled, prompt, config, filter });
});
