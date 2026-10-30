import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WebhookRequestService, type WebhookRequestCard, type WebhookRequestStore } from "./webhook-requests.ts";
import { WebhookManager } from "./webhooks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class MemoryStore implements WebhookRequestStore {
  readonly threads = new Map<string, Array<{ id: string; card?: WebhookRequestCard }>>();
  private sequence = 0;
  messagesFor(threadId: string) { return this.threads.get(threadId) ?? []; }
  appendMessage(threadId: string, message: { card: WebhookRequestCard }) {
    const stored = { id: `message-${++this.sequence}`, card: message.card };
    this.threads.set(threadId, [...this.messagesFor(threadId), stored]);
    return stored;
  }
  patchMessage(threadId: string, messageId: string, patch: { card: WebhookRequestCard }) {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (message) message.card = patch.card;
    return message ?? null;
  }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-webhook-requests-"));
  dirs.push(dir);
  let now = Date.parse("2026-10-17T10:00:00Z");
  const queued: Array<{ webhookId: string; prompt: string }> = [];
  const webhooks = new WebhookManager({
    file: join(dir, "webhooks.json"),
    now: () => now,
    botState: (botId) => (botId === "gone" ? "missing" : "ready"),
    enqueue: (input) => {
      queued.push(input);
      return { id: `run-${queued.length}` };
    },
  });
  const store = new MemoryStore();
  const service = new WebhookRequestService({ store, webhooks, botName: (botId) => (botId === "bot-b" ? "Sales" : "Support"), now: () => now });
  const tick = () => { now += 1_000; };
  return { dir, webhooks, store, service, queued, tick };
}

const create = { action: "create", webhook: { name: "Interested replies", instructions: "Draft a follow-up for the lead in the payload." } };

describe("WebhookRequestService", () => {
  it("creates a bot's webhook at once, with a receipt card that never carries its secret, and keeps its address", () => {
    const { service, webhooks, store, dir } = harness();
    const applied = service.submit({ botId: "bot-a", threadId: "thread-a", operation: create });
    expect(applied).toMatchObject({ state: "applied", action: "create" });
    const [webhook] = webhooks.list();
    expect(webhook).toMatchObject({ id: applied.resultId, botId: "bot-a", enabled: true, prompt: create.webhook.instructions, runOn: "maus" });
    const [message] = store.messagesFor("thread-a");
    expect(message!.card).toMatchObject({ answered: "allow", autoApplied: true, dismissed: true, options: [], tool: "create_trigger",
      webhookRequest: { version: 1, botId: "bot-a", threadId: "thread-a", resultId: webhook!.id, operation: { action: "create" } } });
    expect(applied.summary).toBe("When another app sends something, Support follows: Draft a follow-up for the lead in the payload.");
    // Neither the result nor the card carries the secret, and the file holds only its hash and a sealed copy.
    expect(JSON.stringify({ applied, card: message!.card })).not.toMatch(/whsec_/);
    expect(readFileSync(join(dir, "webhooks.json"), "utf8")).not.toMatch(/whsec_/);
    // The address is kept: the bot that owns it and the person's Copy address read the same one, and it works.
    const kept = webhooks.currentSecret(webhook!.id, false)!;
    expect(kept.secret).toMatch(/^whsec_/);
    expect(webhooks.authorize(webhook!.endpointId, kept.secret!)).toBe(true);
  });

  it("refuses a duplicate, another bot's webhook, and a field a webhook does not have", () => {
    const { service, store } = harness();
    service.submit({ botId: "bot-a", threadId: "thread-a", operation: create });
    expect(() => service.submit({ botId: "bot-a", threadId: "thread-a", operation: create })).toThrow(/already exists/);
    const theirs = service.submit({ botId: "bot-b", threadId: "thread-b", operation: { ...create, webhook: { ...create.webhook, name: "Theirs" } } });
    expect(() => service.submit({ botId: "bot-a", threadId: "thread-a", operation: { action: "pause", webhookId: theirs.resultId } }))
      .toThrow(/No webhook trigger with that id belongs to this bot/);
    expect(() => service.submit({ botId: "bot-a", threadId: "thread-a", operation: { action: "create", webhook: { ...create.webhook, schedule: {} } } }))
      .toThrow();
    expect(store.messagesFor("thread-a")).toHaveLength(1);
  });

  it("acts on another bot's webhook only when that bot is named as the target", () => {
    const { service, webhooks } = harness();
    const forPeer = service.submit({ botId: "bot-a", threadId: "thread-a", operation: { ...create, forBot: { botId: "bot-b", name: "Sales" } } });
    expect(webhooks.list()[0]).toMatchObject({ id: forPeer.resultId, botId: "bot-b" });
    expect(forPeer.summary).toContain("Sales follows");
    service.submit({ botId: "bot-a", threadId: "thread-a", operation: { action: "pause", webhookId: forPeer.resultId, forBot: { botId: "bot-b", name: "Sales" } } });
    expect(webhooks.list()[0]!.enabled).toBe(false);
  });

  it("undoes an update, a pause and a delete, bringing a deleted webhook back with its URL and secret", () => {
    const { service, webhooks, store, tick } = harness();
    const created = service.submit({ botId: "bot-a", threadId: "thread-a", operation: create });
    const { secret } = webhooks.rotateSecret(created.resultId)!;
    const endpointId = webhooks.list()[0]!.endpointId;
    tick();
    const updated = service.submit({ botId: "bot-a", threadId: "thread-a", operation: { action: "update", webhookId: created.resultId, changes: { name: "Renamed", eventTypes: ["reply.labelled"] } } });
    expect(webhooks.list()[0]).toMatchObject({ name: "Renamed", eventTypes: ["reply.labelled"] });
    expect(service.undo({ botId: "bot-a", threadId: "thread-a", requestId: updated.requestId })).toMatchObject({ state: "undone", action: "update" });
    expect(webhooks.list()[0]).toMatchObject({ name: "Interested replies" });
    expect(webhooks.list()[0]!.eventTypes).toBeUndefined();
    tick();
    const paused = service.submit({ botId: "bot-a", threadId: "thread-a", operation: { action: "pause", webhookId: created.resultId } });
    expect(webhooks.list()[0]!.enabled).toBe(false);
    expect(service.undo({ botId: "bot-a", threadId: "thread-a", requestId: paused.requestId })).toMatchObject({ state: "undone" });
    expect(webhooks.list()[0]!.enabled).toBe(true);
    tick();
    const deleted = service.submit({ botId: "bot-a", threadId: "thread-a", operation: { action: "delete", webhookId: created.resultId } });
    expect(webhooks.list()).toHaveLength(0);
    expect(webhooks.authorize(endpointId, secret)).toBe(false);
    expect(service.undo({ botId: "bot-a", threadId: "thread-a", requestId: deleted.requestId })).toMatchObject({ state: "undone", action: "delete" });
    expect(webhooks.list()[0]).toMatchObject({ id: created.resultId, endpointId });
    expect(webhooks.authorize(endpointId, secret)).toBe(true);
    // Each undo is once, and the receipt says so.
    expect(service.undo({ botId: "bot-a", threadId: "thread-a", requestId: deleted.requestId })).toEqual({ claimed: true, state: "already_undone" });
    expect(store.messagesFor("thread-a").filter((message) => message.card?.undone)).toHaveLength(3);
  });

  it("undoes a create by deleting the webhook, and refuses once it changed since or from another conversation", () => {
    const { service, webhooks, tick } = harness();
    const created = service.submit({ botId: "bot-a", threadId: "thread-a", operation: create });
    expect(service.undo({ botId: "bot-a", threadId: "thread-b", requestId: created.requestId })).toEqual({ claimed: false });
    expect(service.undo({ botId: "bot-x", threadId: "thread-a", requestId: created.requestId })).toMatchObject({ state: "invalid", status: 403 });
    expect(service.undo({ botId: "bot-a", threadId: "thread-a", requestId: created.requestId })).toMatchObject({ state: "undone", action: "create" });
    expect(webhooks.list()).toHaveLength(0);
    const again = service.submit({ botId: "bot-a", threadId: "thread-a", operation: create });
    tick();
    const paused = service.submit({ botId: "bot-a", threadId: "thread-a", operation: { action: "pause", webhookId: again.resultId } });
    tick();
    webhooks.update(again.resultId, { name: "Changed by hand" });
    expect(service.undo({ botId: "bot-a", threadId: "thread-a", requestId: paused.requestId })).toMatchObject({ state: "invalid", stale: true });
    expect(webhooks.list()[0]!.enabled).toBe(false);
  });

  it("runs a webhook once with a test call, which cannot be undone", () => {
    const { service, queued } = harness();
    const created = service.submit({ botId: "bot-a", threadId: "thread-a", operation: create });
    const tested = service.submit({ botId: "bot-a", threadId: "thread-a", operation: { action: "run_now", webhookId: created.resultId } });
    expect(tested).toMatchObject({ state: "applied", action: "run_now", runId: "run-1" });
    expect(queued[0]).toMatchObject({ webhookId: created.resultId });
    expect(queued[0]!.prompt).toContain("[USER-CONFIGURED WEBHOOK INSTRUCTIONS]");
    expect(service.undo({ botId: "bot-a", threadId: "thread-a", requestId: tested.requestId })).toMatchObject({ state: "invalid" });
  });

  it("refuses to save when the requesting turn already ended, changing nothing", () => {
    const { service, webhooks, store } = harness();
    expect(() => service.submit({ botId: "bot-a", threadId: "thread-a", operation: create, canCommit: () => false })).toThrow(/turn ended/);
    expect(webhooks.list()).toHaveLength(0);
    expect(store.messagesFor("thread-a")).toHaveLength(0);
  });
});
