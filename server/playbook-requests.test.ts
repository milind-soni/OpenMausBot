import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { playbookRevision } from "./playbook-revision.ts";
import {
  PlaybookRequestService,
  type PlaybookRequestStore,
  type OptionCardLike,
} from "./playbook-requests.ts";
import type { BotRecord, InstalledPlaybook } from "./store.ts";

interface StoredMessage {
  id: string;
  card?: OptionCardLike;
}

class MemoryStore implements PlaybookRequestStore {
  readonly bots = new Map<string, BotRecord>();
  readonly threads = new Map<string, StoredMessage[]>();
  private sequence = 0;

  bot(id: string): BotRecord | undefined {
    return this.bots.get(id);
  }

  messagesFor(threadId: string): StoredMessage[] {
    return this.threads.get(threadId) ?? [];
  }

  appendMessage(
    threadId: string,
    message: { role: "bot"; kind: "options"; card: OptionCardLike; from?: { botId: string; name: string; color: string } },
  ): StoredMessage {
    const stored: StoredMessage = { id: `message-${++this.sequence}`, card: message.card };
    const messages = this.threads.get(threadId) ?? [];
    messages.push(stored);
    this.threads.set(threadId, messages);
    return stored;
  }

  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): StoredMessage | null {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = patch.card;
    return message;
  }

  patchBotPlaybooks(
    id: string,
    patch: { playbooks: InstalledPlaybook[]; lastPlaybookRequestId: string },
  ): BotRecord | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    return bot;
  }
}

const PLAYBOOK = {
  key: "ticket-quality",
  name: "Ticket Quality",
  summary: "How a ticket earns its place on the board.",
  triggers: ["ticket quality", "review ticket"],
  instructions: "Refuse a vague ticket until the outcome is clear.",
};

function harness(options: { validateTarget?: (proposer: string, target: string) => string | null } = {}) {
  const store = new MemoryStore();
  const service = new PlaybookRequestService({ store, validateTarget: options.validateTarget });

  function addBot(name: string, playbooks?: InstalledPlaybook[]): BotRecord {
    const record = {
      id: randomUUID(),
      threadId: randomUUID(),
      name,
      title: "",
      description: "",
      color: "blue",
      unread: false,
      createdAt: Date.now(),
      ...(playbooks ? { playbooks } : {}),
    } as unknown as BotRecord;
    store.bots.set(record.id, record);
    return record;
  }

  return { service, store, addBot, bot: addBot("Scout") };
}

describe("PlaybookRequestService", () => {
  it("pins a revision and appends a durable card for a new playbook", () => {
    const { service, store, bot } = harness();
    const result = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: { action: "upsert", playbook: PLAYBOOK },
      reason: "You asked me to reuse the ticket rules.",
    });

    const card = store.messagesFor(bot.threadId).at(-1)!.card!;
    expect(card.tool).toBe("update_playbook");
    expect(card.options).toEqual(["Confirm", "Cancel"]);
    expect(card.playbookRequest).toMatchObject({
      version: 1,
      botId: bot.id,
      targetBotId: bot.id,
      targetName: "Scout",
      change: { action: "upsert", playbook: { key: "ticket-quality" } },
    });
    expect(card.playbookRequest!.before).toBeUndefined();
    expect(card.playbookRequest!.expectedRevision).toBe(playbookRevision(bot));
    expect(result.title).toBe("Add Scout's “Ticket Quality” playbook?");
    expect(card.subtitle).toContain("Triggers: ticket quality, review ticket");
    expect(card.subtitle).toContain("Nothing runs.");
    // never applied on propose
    expect(store.bots.get(bot.id)!.playbooks).toBeUndefined();
  });

  it("shows a diff against the playbook the key already holds", () => {
    const { service, store, addBot } = harness();
    const bot = addBot("Scout", [{ ...PLAYBOOK, instructions: "Old rule." }]);
    service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: { action: "upsert", playbook: { ...PLAYBOOK, instructions: "New rule." } },
      reason: "team.md changed.",
    });

    const card = store.messagesFor(bot.threadId).at(-1)!.card!;
    expect(card.title).toBe("Update Scout's “Ticket Quality” playbook?");
    expect(card.playbookRequest!.before).toMatchObject({ instructions: "Old rule." });
    expect(card.subtitle).toContain("-Old rule.");
    expect(card.subtitle).toContain("+New rule.");
  });

  it("redacts secrets before they reach the durable payload", () => {
    const { service, store, bot } = harness();
    service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: {
        action: "upsert",
        playbook: { ...PLAYBOOK, instructions: "Use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA to sync." },
      },
      reason: "sync setup",
    });

    const card = store.messagesFor(bot.threadId).at(-1)!.card!;
    const change = card.playbookRequest!.change;
    expect(change.action).toBe("upsert");
    if (change.action !== "upsert") throw new Error("expected upsert");
    expect(change.playbook.instructions).not.toContain("sk-ant-api03-AAAA");
  });

  it("refuses a proposal that would not change anything", () => {
    const { service, addBot } = harness();
    const bot = addBot("Scout", [PLAYBOOK]);
    expect(() =>
      service.propose({
        botId: bot.id,
        threadId: bot.threadId,
        change: { action: "upsert", playbook: PLAYBOOK },
        reason: "no-op",
      }),
    ).toThrow(/Nothing would change/);
  });

  it("refuses removing a playbook the bot does not have", () => {
    const { service, bot } = harness();
    expect(() =>
      service.propose({
        botId: bot.id,
        threadId: bot.threadId,
        change: { action: "remove", key: "missing" },
        reason: "cleanup",
      }),
    ).toThrow(/no playbook/i);
  });

  it("validates keys, triggers, sizes, and the per-bot ceiling", () => {
    const { service, addBot, bot } = harness();
    const propose = (change: unknown, target = bot) =>
      service.propose({ botId: target.id, threadId: target.threadId, change, reason: "why" });

    expect(() => propose({ action: "upsert", playbook: { ...PLAYBOOK, key: "Not A Slug" } })).toThrow(/key/i);
    expect(() => propose({ action: "upsert", playbook: { ...PLAYBOOK, triggers: [] } })).toThrow(/trigger/i);
    expect(() => propose({ action: "upsert", playbook: { ...PLAYBOOK, instructions: "x".repeat(24_001) } })).toThrow(
      /24000/,
    );
    expect(() => propose({ action: "upsert", playbook: { ...PLAYBOOK, summary: "x".repeat(301) } })).toThrow(/summary/i);
    expect(() => propose({ action: "sabotage" })).toThrow(/upsert or remove/i);

    const full = addBot(
      "Full",
      Array.from({ length: 80 }, (_, index) => ({ ...PLAYBOOK, key: `playbook-${index}` })),
    );
    expect(() => propose({ action: "upsert", playbook: PLAYBOOK }, full)).toThrow(/80/);
  });

  it("requires a reason", () => {
    const { service, bot } = harness();
    expect(() =>
      service.propose({
        botId: bot.id,
        threadId: bot.threadId,
        change: { action: "upsert", playbook: PLAYBOOK },
        reason: "  ",
      }),
    ).toThrow(/reason is required/);
  });

  it("applies on confirm, marks the playbook bot-authored, and leaves other playbooks alone", () => {
    const { service, store, addBot } = harness();
    const keep: InstalledPlaybook = { ...PLAYBOOK, key: "planning", name: "Planning" };
    const bot = addBot("Scout", [keep]);
    const { requestId } = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: { action: "upsert", playbook: PLAYBOOK },
      reason: "reuse the ticket rules",
    });

    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" });
    expect(result).toMatchObject({ claimed: true, state: "applied", targetBotId: bot.id });

    const playbooks = store.bots.get(bot.id)!.playbooks!;
    expect(playbooks).toHaveLength(2);
    expect(playbooks.find((entry) => entry.key === "planning")).toMatchObject({ name: "Planning" });
    expect(playbooks.find((entry) => entry.key === "ticket-quality")).toMatchObject({
      name: "Ticket Quality",
      source: "bot",
    });
    expect(store.bots.get(bot.id)!.lastPlaybookRequestId).toBe(requestId);
    expect(store.messagesFor(bot.threadId).at(-1)!.card!.answered).toBe("allow");
  });

  it("removes on confirm", () => {
    const { service, store, addBot } = harness();
    const bot = addBot("Scout", [PLAYBOOK, { ...PLAYBOOK, key: "planning" }]);
    const { requestId } = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: { action: "remove", key: "ticket-quality" },
      reason: "no longer used",
    });

    service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" });
    expect(store.bots.get(bot.id)!.playbooks!.map((entry) => entry.key)).toEqual(["planning"]);
  });

  it("does not apply when cancelled", () => {
    const { service, store, bot } = harness();
    const { requestId } = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: { action: "upsert", playbook: PLAYBOOK },
      reason: "why",
    });

    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "deny" })).toMatchObject({
      state: "denied",
    });
    expect(store.bots.get(bot.id)!.playbooks).toBeUndefined();
  });

  it("fails closed when the playbook set moved after the card was written", () => {
    const { service, store, bot } = harness();
    const { requestId } = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: { action: "upsert", playbook: PLAYBOOK },
      reason: "why",
    });

    store.bots.get(bot.id)!.playbooks = [{ ...PLAYBOOK, key: "elsewhere" }];
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" })).toMatchObject({
      state: "invalid",
      status: 409,
    });
  });

  it("never applies twice on a repeated confirm", () => {
    const { service, store, bot } = harness();
    const { requestId } = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: { action: "upsert", playbook: PLAYBOOK },
      reason: "why",
    });

    service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" });
    const again = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" });
    expect(again).toMatchObject({ state: "already_settled", behavior: "allow" });
    expect(store.bots.get(bot.id)!.playbooks).toHaveLength(1);
  });

  it("checks a Chief's reach at propose and again at confirm", () => {
    let refusal: string | null = null;
    const { service, store, addBot, bot } = harness({ validateTarget: () => refusal });
    const peer = addBot("Peer");

    refusal = "only a section's Chief of Staff can change another bot's playbooks";
    expect(() =>
      service.propose({
        botId: bot.id,
        threadId: bot.threadId,
        targetBotId: peer.id,
        change: { action: "upsert", playbook: PLAYBOOK },
        reason: "why",
      }),
    ).toThrow(/Chief of Staff/);

    refusal = null;
    const { requestId } = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      targetBotId: peer.id,
      change: { action: "upsert", playbook: PLAYBOOK },
      reason: "why",
    });
    // the peer left the section while the card sat open
    refusal = "that bot belongs to a different section";
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" })).toMatchObject({
      state: "invalid",
    });
    expect(store.bots.get(peer.id)!.playbooks).toBeUndefined();
  });

  it("refuses a card claimed from another conversation", () => {
    const { service, addBot, bot } = harness();
    const other = addBot("Other");
    const { requestId } = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      change: { action: "upsert", playbook: PLAYBOOK },
      reason: "why",
    });

    expect(service.resolve({ botId: other.id, threadId: bot.threadId, requestId, behavior: "allow" })).toMatchObject({
      state: "invalid",
      status: 403,
    });
  });
});
