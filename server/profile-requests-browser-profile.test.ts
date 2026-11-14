import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { botFolder } from "./bot-folder.ts";
import { appliesNow, type DirectApplyCheck } from "./direct-apply.ts";
import { ProfileRequestService, type OptionCardLike, type ProfileRequestStore } from "./profile-requests.ts";
import type { BotRecord } from "./store.ts";

class MemoryStore implements ProfileRequestStore {
  readonly bots = new Map<string, BotRecord>();
  readonly threads = new Map<string, Array<{ id: string; card?: OptionCardLike }>>();
  private sequence = 0;

  bot(id: string): BotRecord | undefined {
    return this.bots.get(id);
  }

  messagesFor(threadId: string) {
    return this.threads.get(threadId) ?? [];
  }

  appendMessage(threadId: string, message: { card: OptionCardLike }) {
    const stored = { id: `message-${++this.sequence}`, card: message.card };
    this.threads.set(threadId, [...this.messagesFor(threadId), stored]);
    return stored;
  }

  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }) {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = patch.card;
    return message;
  }

  patchBotProfile(id: string, patch: Parameters<ProfileRequestStore["patchBotProfile"]>[1]): BotRecord | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    return bot;
  }
}

const PROFILES = [{ id: "work", name: "Work" }, { id: "shop", name: "Shopping" }];
const fullAccess: DirectApplyCheck = () => appliesNow({ fullAccess: true, ownerMustConfirm: false });

function harness(options: { autoApply?: DirectApplyCheck; chiefs?: string[] } = {}) {
  const store = new MemoryStore();
  const held = new Set<string>();
  const closeForBot = vi.fn<(botId: string) => void>();
  const forgetTemporaryBrowser = vi.fn(async (_botId: string) => {});
  const addBot = (name: string, fields: Partial<BotRecord> = {}): BotRecord => {
    const record = {
      id: randomUUID(), threadId: randomUUID(), name, title: "", description: "", soul: "", notifications: true,
      color: "blue", unread: false, modelSelection: "default", resumeCursors: {}, ...fields,
    } as unknown as BotRecord;
    store.bots.set(record.id, record);
    mkdirSync(botFolder(record.id), { recursive: true, mode: 0o700 });
    return record;
  };
  const chief = addBot("Chief", { busy: true });
  const chiefs = new Set([chief.id]);
  const service = new ProfileRequestService({
    store,
    autoApply: options.autoApply,
    validateTarget: (proposer) => (chiefs.has(proposer) ? null : "Only a Chief of Staff can change another bot's profile."),
    browserProfile: {
      guards: { profiles: () => PROFILES, heldBy: (session) => held.has(session), currentBrowserSession: (botId, profile) => `${botId}:${profile ?? "own"}` },
      cleanup: { closeForBot, forgetTemporaryBrowser },
    },
  });
  return { store, service, chief, addBot, held, closeForBot, forgetTemporaryBrowser };
}

describe("propose_profile browserProfile", () => {
  it("lets a Chief set an idle teammate's profile by name, closes its browser view, and Undo puts the old one back", () => {
    const { store, service, chief, addBot, closeForBot } = harness({ autoApply: fullAccess });
    const peer = addBot("Peer");
    const applied = service.submit({ botId: chief.id, threadId: chief.threadId, targetBotId: peer.id, changes: { browserProfile: "work" }, reason: "asked" });
    expect(applied).toMatchObject({ state: "applied", result: { targetBotId: peer.id, fields: ["browserProfile"] } });
    expect(peer.browserProfile).toBe("work");
    expect(applied.detail).toContain('Browser profile: its own browser → "Work"');
    expect(closeForBot).toHaveBeenCalledWith(peer.id);

    expect(service.undo({ botId: chief.id, threadId: chief.threadId, requestId: applied.requestId })).toMatchObject({ state: "undone" });
    expect(peer.browserProfile).toBeUndefined();
    expect(closeForBot).toHaveBeenCalledTimes(2);

    const byName = service.submit({ botId: chief.id, threadId: chief.threadId, targetBotId: peer.id, changes: { browserProfile: "shopping" }, reason: "asked" });
    expect(byName.state).toBe("applied");
    expect(store.bot(peer.id)!.browserProfile).toBe("shop");
  });

  it("applies on confirm when a card is shown, and erases a temporary browser it leaves", () => {
    const { service, chief, addBot, forgetTemporaryBrowser } = harness();
    const peer = addBot("Peer", { browserProfile: "guest" });
    const { requestId } = service.propose({ botId: chief.id, threadId: chief.threadId, targetBotId: peer.id, changes: { browserProfile: "" }, reason: "asked" });
    expect(peer.browserProfile).toBe("guest");
    expect(service.resolve({ botId: chief.id, threadId: chief.threadId, requestId, behavior: "allow" })).toMatchObject({ state: "applied" });
    expect(peer.browserProfile).toBeUndefined();
    expect(forgetTemporaryBrowser).toHaveBeenCalledWith(peer.id);
  });

  it("refuses a busy teammate or one whose browser is under the person's control, at proposal and again at confirm", () => {
    const { service, chief, addBot, held } = harness({ autoApply: fullAccess });
    const busy = addBot("Busy", { busy: true });
    expect(() => service.submit({ botId: chief.id, threadId: chief.threadId, targetBotId: busy.id, changes: { browserProfile: "work" }, reason: "asked" }))
      .toThrow("@Busy: stop this bot's turn before changing its browser profile");
    expect(busy.browserProfile).toBeUndefined();

    const controlled = addBot("Controlled");
    held.add(`${controlled.id}:own`);
    expect(() => service.submit({ botId: chief.id, threadId: chief.threadId, targetBotId: controlled.id, changes: { browserProfile: "work" }, reason: "asked" }))
      .toThrow("Release browser control before changing its profile.");

    const idle = harness();
    const later = idle.addBot("Later");
    const card = idle.service.propose({ botId: idle.chief.id, threadId: idle.chief.threadId, targetBotId: later.id, changes: { browserProfile: "work" }, reason: "asked" });
    later.busy = true;
    expect(idle.service.resolve({ botId: idle.chief.id, threadId: idle.chief.threadId, requestId: card.requestId, behavior: "allow" }))
      .toMatchObject({ state: "invalid", status: 409 });
    expect(later.browserProfile).toBeUndefined();
    later.busy = false;
    expect(idle.service.resolve({ botId: idle.chief.id, threadId: idle.chief.threadId, requestId: card.requestId, behavior: "allow" }))
      .toMatchObject({ state: "applied" });
    expect(later.browserProfile).toBe("work");
  });

  it("refuses a profile that does not exist and never creates one", () => {
    const { service, chief, addBot, closeForBot } = harness({ autoApply: fullAccess });
    const peer = addBot("Peer");
    expect(() => service.submit({ botId: chief.id, threadId: chief.threadId, targetBotId: peer.id, changes: { browserProfile: "Banking" }, reason: "asked" }))
      .toThrow(/No browser profile is named "Banking"\. Existing profiles: "Work", "Shopping"\./);
    expect(peer.browserProfile).toBeUndefined();
    expect(closeForBot).not.toHaveBeenCalled();
  });

  it("refuses a bot that is not a Chief changing another bot's profile", () => {
    const { service, addBot } = harness({ autoApply: fullAccess });
    const member = addBot("Member");
    const peer = addBot("Peer");
    expect(() => service.submit({ botId: member.id, threadId: member.threadId, targetBotId: peer.id, changes: { browserProfile: "work" }, reason: "asked" }))
      .toThrow("Only a Chief of Staff can change another bot's profile.");
    expect(peer.browserProfile).toBeUndefined();
  });

  it("refuses a bot's own switch mid-turn, naming its current profile and where the person changes it", () => {
    const { service, chief, store } = harness({ autoApply: fullAccess });
    store.patchBotProfile(chief.id, { browserProfile: "shop" });
    expect(() => service.submit({ botId: chief.id, threadId: chief.threadId, changes: { browserProfile: "work" }, reason: "asked" }))
      .toThrow(/can't switch its own browser profile.*uses "Shopping" now.*Browser tab/);
    expect(chief.browserProfile).toBe("shop");
  });

  it("is refused where no browser rules were given", () => {
    const store = new MemoryStore();
    const bot = { id: "a", threadId: "t", name: "A", title: "", description: "", soul: "" } as unknown as BotRecord;
    const peer = { id: "b", threadId: "u", name: "B", title: "", description: "", soul: "" } as unknown as BotRecord;
    store.bots.set(bot.id, bot).set(peer.id, peer);
    const service = new ProfileRequestService({ store });
    expect(() => service.propose({ botId: bot.id, threadId: bot.threadId, targetBotId: peer.id, changes: { browserProfile: "work" }, reason: "r" }))
      .toThrow("Browser profiles can't be changed here.");
  });
});
