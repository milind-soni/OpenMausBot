import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { botFolder } from "./bot-folder.ts";
import { profileRevision } from "./profile-revision.ts";
import { flushProfileHistory, readHistory } from "./profile-versions.ts";
import {
  ProfileRequestService,
  type OptionCardLike,
  type ProfileRequestStore,
} from "./profile-requests.ts";
import type { BotRecord } from "./store.ts";

interface StoredMessage {
  id: string;
  card?: OptionCardLike;
}

class MemoryStore implements ProfileRequestStore {
  readonly bots = new Map<string, BotRecord>();
  readonly threads = new Map<string, StoredMessage[]>();
  readonly setSoulCalls: Array<[string, string]> = [];
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

  patchMessage(
    threadId: string,
    messageId: string,
    patch: { card: OptionCardLike },
  ): StoredMessage | null {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = patch.card;
    return message;
  }

  patchBot(id: string, patch: Parameters<ProfileRequestStore["patchBotProfile"]>[1]): BotRecord | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    return bot;
  }

  patchBotProfile(id: string, patch: Parameters<ProfileRequestStore["patchBotProfile"]>[1]): BotRecord | null {
    return this.patchBot(id, patch);
  }

  setSoul(id: string, soul: string): BotRecord | null {
    this.setSoulCalls.push([id, soul]);
    const bot = this.bots.get(id);
    if (!bot) return null;
    bot.soul = soul;
    return bot;
  }
}

function harness(options: { name: string; chiefOfStaff?: boolean }) {
  const store = new MemoryStore();
  const service = new ProfileRequestService({ store });

  function addBot(overrides: { name: string }): BotRecord {
    const record = {
      id: randomUUID(),
      threadId: randomUUID(),
      name: overrides.name,
      title: "",
      description: "",
      soul: "",
      notifications: true,
      color: "blue",
      unread: false,
      modelSelection: "default",
      resumeCursors: {},
    } as unknown as BotRecord;
    store.bots.set(record.id, record);
    // recordProfileChange (via resolve -> profile-versions.ts) skips its
    // write when the bot's folder is gone, so a synthetic bot here needs
    // one too — a real bot gets its folder at creation (writeSoulMirror).
    mkdirSync(botFolder(record.id), { recursive: true, mode: 0o700 });
    return record;
  }

  const bot = addBot({ name: options.name });
  return { service, store, bot, addBot };
}

describe("ProfileRequestService", () => {
  it("validates through the profile boundary, pins a revision, and appends a durable card", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const result = service.propose({
      botId: bot.id,
      threadId: bot.threadId,
      changes: { name: "Kiwi", title: "Tracker", soul: "File bugs.\nNever noise. sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      reason: "You asked me to track Discord.",
    });
    const card = store.messagesFor(bot.threadId).at(-1)!.card!;
    expect(card.tool).toBe("update_profile");
    expect(card.options).toEqual(["Confirm", "Cancel"]);
    expect(card.profileRequest).toMatchObject({
      version: 1,
      botId: bot.id,
      threadId: bot.threadId,
      targetBotId: bot.id,
      targetName: "Scout",
      changes: { name: "Kiwi", title: "Tracker" },
      before: { name: "Scout", title: "", soul: "" },
    });
    expect(card.profileRequest!.changes.soul).not.toContain("sk-ant-api03-AAAA");
    expect(card.profileRequest!.expectedRevision).toBe(profileRevision(bot));
    expect(result.title).toBe("Set up Scout?");
    expect(card.subtitle).toContain('Name: "Scout" → "Kiwi"');
    expect(card.subtitle).toContain("+File bugs.");
    expect(card.subtitle).toContain("Changes what Scout is told on every turn. Nothing runs.");
  });

  it("refuses unsupported fields, over-cap values, a missing reason, and empty changes with the boundary's copy", () => {
    const { service, bot } = harness({ name: "Scout" });
    const attempt = (changes: unknown, reason: unknown = "r") =>
      () => service.propose({ botId: bot.id, threadId: bot.threadId, changes, reason });
    expect(attempt({ notifications: false })).toThrow("unsupported profile field: notifications");
    expect(attempt({ soul: "x".repeat(24_001) })).toThrow("standing instructions must be at most 24000 bytes");
    expect(attempt({ name: "Kiwi" }, "")).toThrow("reason is required");
    expect(attempt({})).toThrow("Choose at least one of name, title, description, soul, cwd");
    expect(attempt({ name: "Scout" })).toThrow("Nothing would change");
  });

  it("re-checks the cap after redaction, since a mask can be longer than the secret it replaces", () => {
    const { service, bot } = harness({ name: "Scout" });
    // "token: sk-ant-AAAAAAAA" (22 bytes) matches the key=value secret
    // pattern (its value is only 8 chars — too short for the standalone
    // sk-ant-… shape, which needs 16+) and is masked to
    // "token: «redacted 15 chars»" (28 bytes): +6 bytes of growth. Padding
    // the rest of the soul with plain filler (separated by a newline so the
    // pattern's word boundary still lands on "token") puts the RAW value
    // exactly at the cap, so only the redaction growth can push it over.
    const secretish = "token: sk-ant-AAAAAAAA";
    const filler = "x".repeat(24_000 - secretish.length - 1);
    const soul = `${filler}\n${secretish}`;
    expect(Buffer.byteLength(soul, "utf8")).toBe(24_000);
    expect(() => service.propose({ botId: bot.id, threadId: bot.threadId, changes: { soul }, reason: "r" }))
      .toThrow("standing instructions must be at most 24000 bytes");
  });

  it("applies only on confirm, through patchBot and setSoul, records history, and settles the card", async () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const { requestId } = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { name: "Kiwi", soul: "Be brief." }, reason: "r" });
    expect(store.bot(bot.id)!.name).toBe("Scout");
    const denied = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: "nope", behavior: "allow" });
    expect(denied).toEqual({ claimed: false, state: "not_found" });
    const applied = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" });
    expect(applied).toEqual({ claimed: true, state: "applied", targetBotId: bot.id, fields: ["name", "soul"] });
    expect(store.bot(bot.id)).toMatchObject({ name: "Kiwi", soul: "Be brief." });
    expect(store.setSoulCalls).toEqual([]);
    const card = store.messagesFor(bot.threadId).at(-1)!.card!;
    expect(card.answered).toBe("allow");
    expect(card.profileRequest!.appliedAt).toBeGreaterThan(0);
    await flushProfileHistory(bot.id);
    expect(readHistory(bot.id).map((r) => [r.field, r.actor, r.via])).toEqual([
      ["soul", "bot", `card:${store.messagesFor(bot.threadId).at(-1)!.id}`],
      ["name", "bot", `card:${store.messagesFor(bot.threadId).at(-1)!.id}`],
    ]);
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" }))
      .toEqual({ claimed: true, state: "already_settled", behavior: "allow" });
  });

  it("denies without changing anything, and fails closed when the profile moved after the card", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const a = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { title: "T" }, reason: "r" });
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: a.requestId, behavior: "deny" }))
      .toEqual({ claimed: true, state: "denied" });
    expect(store.bot(bot.id)!.title).toBe("");
    const b = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { title: "T" }, reason: "r" });
    store.patchBot(bot.id, { description: "changed elsewhere" });
    const stale = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: b.requestId, behavior: "allow" });
    expect(stale).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    expect((stale as { error: string }).error).toBe("This bot's profile changed after this card was prepared. Ask the bot to review it and propose again.");
    expect(store.messagesFor(bot.threadId).at(-1)!.card!.held).toContain("changed after this card");
    expect(store.bot(bot.id)!.title).toBe("");
  });

  it("scrubs existing profile secrets in the returned tool result as well as the card", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const secret = "sk-ant-api03-SECRETSECRETSECRETSECRETSECRET";
    store.setSoul(bot.id, `Keep ${secret} private.`);
    const result = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { soul: "Be brief." }, reason: "r" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(store.messagesFor(bot.threadId))).not.toContain(secret);
  });

  it("still cancels a proposal after its target bot was deleted", () => {
    const { service, store, bot, addBot } = harness({ name: "Chief" });
    const peer = addBot({ name: "Peer" });
    const proposed = service.propose({ botId: bot.id, threadId: bot.threadId, targetBotId: peer.id, changes: { title: "Tracker" }, reason: "r" });
    store.bots.delete(peer.id);
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: proposed.requestId, behavior: "deny" }))
      .toEqual({ claimed: true, state: "denied" });
  });

  it("commits profile fields once and can retry a failed card settlement without reapplying", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const proposed = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { name: "Kiwi", soul: "Be brief." }, reason: "r" });
    const patch = vi.spyOn(store, "patchBotProfile");
    const settle = vi.spyOn(store, "patchMessage").mockImplementationOnce(() => { throw new Error("card write failed"); });
    const args = { botId: bot.id, threadId: bot.threadId, requestId: proposed.requestId, behavior: "allow" };
    expect(service.resolve(args)).toMatchObject({ state: "applied", settlementPending: true, message: expect.stringContaining("Profile saved") });
    expect(bot).toMatchObject({ name: "Kiwi", soul: "Be brief.", lastProfileRequestId: proposed.requestId });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(store.messagesFor(bot.threadId).at(-1)?.card?.held).toContain("Confirm again");
    expect(service.resolve(args)).toMatchObject({ state: "already_settled", behavior: "allow" });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(store.messagesFor(bot.threadId).at(-1)?.card?.answered).toBe("allow");
    settle.mockRestore();
  });

  it("never reapplies an interrupted card after a later proposal restores its original text", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const a = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { name: "Kiwi", soul: "Brief." }, reason: "r" });
    const patch = vi.spyOn(store, "patchBotProfile");
    vi.spyOn(store, "patchMessage").mockImplementationOnce(() => { throw new Error("card write failed"); });
    const args = { botId: bot.id, threadId: bot.threadId, requestId: a.requestId, behavior: "allow" };
    expect(service.resolve(args)).toMatchObject({ state: "applied", settlementPending: true });
    const b = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { name: "Scout", soul: "" }, reason: "restore" });
    expect(service.resolve({ ...args, requestId: b.requestId })).toMatchObject({ state: "applied" });
    expect(service.resolve(args)).toMatchObject({ state: "invalid", status: 409 });
    expect(bot).toMatchObject({ name: "Scout", soul: "", lastProfileRequestId: b.requestId });
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("pins ownership to the proposing conversation and rejects other behaviors", () => {
    const { service, bot } = harness({ name: "Scout" });
    const { requestId } = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { title: "T" }, reason: "r" });
    expect(service.resolve({ botId: "other", threadId: bot.threadId, requestId, behavior: "allow" }))
      .toMatchObject({ claimed: true, state: "invalid", status: 403 });
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "answer" }))
      .toMatchObject({ claimed: true, state: "invalid", status: 400 });
  });

  it("lets a validated target be another bot, re-checks it at confirm, and applies to the target", () => {
    const { service, store, bot, addBot } = harness({ name: "Chief", chiefOfStaff: true });
    const peer = addBot({ name: "Peer" });
    let refuse: string | null = null;
    service.validateTarget = () => refuse;
    const { requestId, title } = service.propose({ botId: bot.id, threadId: bot.threadId, targetBotId: peer.id, changes: { title: "Analyst" }, reason: "r" });
    expect(title).toBe("Update @Peer's profile?");
    // A cross-bot card is shown in the PROPOSER's thread — it must name the
    // target as its very first line, or the web card never says whose
    // profile is on the line.
    const card = store.messagesFor(bot.threadId).at(-1)!.card!;
    expect(card.subtitle.split("\n")[0]).toBe("Whose profile: @Peer");
    refuse = "@Peer is no longer in this section";
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" }))
      .toMatchObject({ claimed: true, state: "invalid", status: 404 });
    refuse = null;
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" }))
      .toMatchObject({ state: "applied", targetBotId: peer.id });
    expect(store.bot(peer.id)!.title).toBe("Analyst");
    expect(store.bot(bot.id)!.title).toBe("");
  });

  it("bases isSetup on the target's whole profile, not just the fields this proposal touches", () => {
    // An established bot (title already set) renamed by itself: only `name`
    // is in `before`, so the old check ("every OTHER changed field is
    // blank" over an empty list) vacuously said "setup".
    const established = harness({ name: "Kiwi" });
    established.store.patchBot(established.bot.id, { title: "Tracker" });
    const rename = established.service.propose({ botId: established.bot.id, threadId: established.bot.threadId, changes: { name: "Kiwi2" }, reason: "r" });
    expect(rename.title).toBe("Update Kiwi's profile?");

    // A genuinely blank bot still reads as first-time setup.
    const blank = harness({ name: "Scout" });
    const first = blank.service.propose({ botId: blank.bot.id, threadId: blank.bot.threadId, changes: { title: "Tracker" }, reason: "r" });
    expect(first.title).toBe("Set up Scout?");

    // Cross-bot phrasing never depends on isSetup at all.
    const chief = harness({ name: "Chief", chiefOfStaff: true });
    const peer = chief.addBot({ name: "Peer" });
    const cross = chief.service.propose({ botId: chief.bot.id, threadId: chief.bot.threadId, targetBotId: peer.id, changes: { name: "Peer2" }, reason: "r" });
    expect(cross.title).toBe("Update @Peer's profile?");
  });

  it("rejects a payload whose requestId no longer matches its card", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const { requestId, messageId } = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { title: "T" }, reason: "r" });
    const message = store.messagesFor(bot.threadId).find((candidate) => candidate.id === messageId)!;
    const card = message.card!;
    store.patchMessage(bot.threadId, messageId, {
      card: { ...card, profileRequest: { ...card.profileRequest!, requestId: "mismatched" } },
    });
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" }))
      .toEqual({ claimed: true, state: "invalid", error: "This profile request does not match its card", status: 409 });
  });

  it("shows the complete proposed instructions when a detailed diff is too large", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `changed ${i}`).join("\n");
    store.patchBot(bot.id, { title: "already set" });
    store.setSoul(bot.id, before);
    const { detail } = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { soul: after }, reason: "r" });
    expect(detail).toContain("complete proposed instructions");
    expect(detail).toContain(after);
    expect(detail).toContain("changed 499");
    expect(detail).not.toContain("more lines)");
  });
});

describe("propose_profile working folder (cwd)", () => {
  it("proposes an existing folder, says where the tools will work, and applies it on confirm", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const dir = mkdtempSync(join(tmpdir(), "omb-cwd-"));
    try {
      const result = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { cwd: dir }, reason: "You said the site lives there." });
      expect(result.detail).toContain(`Working folder: its private workspace → ${dir}`);
      expect(result.detail).toContain("Scout's tools will read and write files in that folder.");
      // A folder-only card does not change what the bot is told.
      expect(result.detail).not.toContain("told on every turn");
      expect(result.detail).toContain("Nothing runs.");
      expect(store.bot(bot.id)!.cwd).toBeUndefined();
      const applied = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: result.requestId, behavior: "allow" });
      expect(applied).toEqual({ claimed: true, state: "applied", targetBotId: bot.id, fields: ["cwd"] });
      expect(store.bot(bot.id)!.cwd).toBe(dir);

      // Back to the private workspace: "" clears it, and the card names both ends.
      const clear = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { cwd: "" }, reason: "r" });
      expect(clear.detail).toContain(`Working folder: ${dir} → its private workspace`);
      service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: clear.requestId, behavior: "allow" });
      expect(store.bot(bot.id)!.cwd).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing or relative folder at proposal, and a folder that vanished before confirm", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const attempt = (cwd: string) => () => service.propose({ botId: bot.id, threadId: bot.threadId, changes: { cwd }, reason: "r" });
    expect(attempt("relative/path")).toThrow("working folder must be an absolute path");
    expect(attempt(join(tmpdir(), "omb-definitely-missing-" + Date.now()))).toThrow(/that folder doesn't exist/);
    // No folder today and "" proposed: nothing to change.
    expect(attempt("")).toThrow("Nothing would change");

    const dir = mkdtempSync(join(tmpdir(), "omb-cwd-"));
    const { requestId } = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { cwd: dir }, reason: "r" });
    rmSync(dir, { recursive: true, force: true });
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" });
    expect(result).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    expect(store.bot(bot.id)!.cwd).toBeUndefined();
    expect(store.messagesFor(bot.threadId).at(-1)!.card!.held).toMatch(/that folder doesn't exist/);
  });

  it("a folder change elsewhere makes an open card stale, since cwd is part of the revision", () => {
    const { service, store, bot } = harness({ name: "Scout" });
    const { requestId } = service.propose({ botId: bot.id, threadId: bot.threadId, changes: { title: "T" }, reason: "r" });
    store.patchBot(bot.id, { cwd: tmpdir() });
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId, behavior: "allow" });
    expect(result).toMatchObject({ claimed: true, state: "invalid", status: 409 });
  });
});
