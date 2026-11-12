import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import type { BotRecord } from "../store.ts";
import { createAppSettings, WRITE_BUDGET } from "./host.ts";
import { createSettingsRegistry } from "./registry.ts";

const OPENAI_KEY = "sk-live-9f8e7d6c5b4a3210";
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { owner?: boolean; guest?: boolean; group?: boolean; window?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-settings-"));
  dirs.push(dataDir);
  const bots: BotRecord[] = [
    { id: "kiwi", name: "Kiwi", color: "#0f0", threadId: "t-kiwi", approvalMode: "full", section: "Sales" } as unknown as BotRecord,
    { id: "clive", name: "Clive", color: "#00f", threadId: "t-clive", approvalMode: "ask" } as unknown as BotRecord,
  ];
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, threads: { maxConcurrentPerBot: 3 }, openai: { key: OPENAI_KEY }, anthropic: { url: "https://api.anthropic.com" } } as AppConfig;
  const saved: Record<string, unknown>[] = [];
  const messages: Array<Record<string, any>> = [];
  const windowValues = new Map<string, unknown>(options.window === false ? [] : [["appearance.skin", "daylight"]]);
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${messages.length + 1}`, threadId };
      messages.push(row);
      return row as never;
    },
    bot: (id: string) => bots.find((bot) => bot.id === id),
    messagesFor: (threadId: string) => messages.filter((message) => message.threadId === threadId) as never,
    patchMessage: (threadId: string, messageId: string, patch: Record<string, unknown>) => {
      const row = messages.find((message) => message.threadId === threadId && message.id === messageId);
      if (row) Object.assign(row, patch);
      return null;
    },
    setActivity: () => null,
    setTaskActivity: () => null,
    taskByThread: () => ({ busy: true }),
  };
  const credentialCards: Record<string, unknown>[] = [];
  const entries = createSettingsRegistry({
    cfg: () => cfg,
    saveConfig: async (patch) => {
      if (patch.anthropic && typeof patch.anthropic === "object" && (patch.anthropic as { url?: string }).url === "https://refused.example") return "the provider refused it";
      saved.push(patch);
      Object.assign(cfg, patch);
      return null;
    },
    bots: () => bots,
    sections: () => ["Sales"],
    reorderBots: async (botIds) => { bots.sort((a, b) => botIds.indexOf(a.id) - botIds.indexOf(b.id)); return null; },
    groupBots: async (name, botIds) => { for (const bot of bots) if (botIds.includes(bot.id)) (bot as { section?: string }).section = name || undefined; return null; },
    credentials: () => cfg,
    window: {
      read: (id) => windowValues.get(id),
      write: (id, value) => { if (!windowValues.size) return "Open MausBot on this computer first."; windowValues.set(id, value); return null; },
    },
  });
  const notified: unknown[] = [];
  const host = createAppSettings({
    store: store as never, dataDir, entries, holdMs: 1_000,
    turnOwner: () => (options.owner === false ? null : "owner"),
    guestDriven: () => options.guest === true,
    requestCredential: async (_bot, _threadId, body) => { credentialCards.push(body); return { status: 201, body: { messageId: "secret-1", label: "OpenAI API key" } }; },
    connectorThread: () => ({ group: options.group ? { id: "g", name: "Room" } as never : undefined }),
    activeGroupTurnForBot: () => null,
    notify: (notification) => notified.push(notification),
    language: () => undefined,
  });
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const set = (id: string, value?: unknown, generation = turn.generation) => host.handle({ action: "set", id, ...(value === undefined ? {} : { value }) }, { ...turn, generation });
  const answer = (requestId: string, behavior: "allow" | "deny", ownerReview = true) => {
    let sent: { status: number; body: unknown } | null = null;
    const res = { writeHead: (status: number) => { sent = { status, body: null }; }, end: (text: string) => { sent = { status: sent?.status ?? 0, body: JSON.parse(text) }; } } as unknown as ServerResponse;
    const claimed = host.resolveAndSend(res, { threadId: turn.threadId, requestId, behavior }, ownerReview);
    return { claimed, sent: sent as { status: number; body: Record<string, unknown> } | null };
  };
  const cards = () => messages.filter((message) => message.card?.appSettingRequest);
  return { host, cfg, saved, messages, cards, credentialCards, notified, windowValues, bots, turn, set, answer, dataDir };
}

describe("reads", () => {
  it("find lists matches with tier, value and where; get adds help and allowed values", async () => {
    const { host, turn } = fixture();
    const found = await host.handle({ action: "find", query: "dark mode" }, turn);
    const hits = JSON.parse(String(found.body.text)) as Array<Record<string, unknown>>;
    expect(hits[0]).toMatchObject({ id: "appearance.skin", tier: "safe", value: "daylight", where: "Settings → Appearance" });
    const got = await host.handle({ action: "get", id: "rooms.turnTimeoutMinutes" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ id: "rooms.turnTimeoutMinutes", value: "30", allowed: "1 to 1440 minutes", change: "set applies at once, with Undo on the card" });
  });

  it("works in a turn that is not the owner's, where writes are refused", async () => {
    const { host, turn, set, saved } = fixture({ owner: false });
    expect((await host.handle({ action: "get", id: "general.language" }, turn)).status).toBe(200);
    const refused = await set("general.language", "de");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("owner's own conversation");
    expect(saved).toEqual([]);
  });

  it("refuses writes in a guest-driven conversation", async () => {
    const { set, saved } = fixture({ guest: true });
    expect((await set("general.language", "de")).status).toBe(403);
    expect(saved).toEqual([]);
  });

  it("refuses an unknown id and a value the schema rejects", async () => {
    const { set, saved } = fixture();
    expect((await set("nope.nothing", 1)).status).toBe(404);
    const bad = await set("rooms.turnTimeoutMinutes", 100_000);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("1 to 1440 minutes");
    expect(saved).toEqual([]);
  });
  it("reads numbers and JSON lists from the text the tool sends", async () => {
    const { set, saved } = fixture();
    expect((await set("rooms.turnTimeoutMinutes", "45")).status).toBe(200);
    expect((await set("rooms.turnTimeoutMinutes", "lots")).status).toBe(400);
    expect(saved).toHaveLength(1);
  });
});

describe("safe tier", () => {
  it("applies at once, posts an applied card with Undo, and logs a decision", async () => {
    const { set, saved, cards, dataDir } = fixture();
    const result = await set("rooms.turnTimeoutMinutes", 45);
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("Changed Room turn timeout from 30 to 45");
    expect(saved).toEqual([{ rooms: { turnTimeoutMinutes: 45 } }]);
    expect(cards()[0]!.card).toMatchObject({ autoApplied: true, answered: "allow", options: [], tool: "app_settings", appSettingRequest: { settingId: "rooms.turnTimeoutMinutes", before: "30", after: "45", tier: "safe" } });
    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10)).toMatchObject([{ decision: "auto-approved", source: "app-settings", tool: "app_settings", summary: "rooms.turnTimeoutMinutes: 30 → 45", botId: "kiwi" }]);
  });

  it("undo restores the earlier value only while the current one is still the applied one", async () => {
    const { host, set, cfg, cards, turn, saved } = fixture();
    await set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(cards()[0]!.card.requestId);
    cfg.rooms = { turnTimeoutMinutes: 60 };
    expect(await host.undo({ threadId: turn.threadId, requestId })).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
    cfg.rooms = { turnTimeoutMinutes: 45 };
    expect(await host.undo({ threadId: turn.threadId, requestId })).toEqual({ claimed: true, state: "undone" });
    expect(saved.at(-1)).toEqual({ rooms: { turnTimeoutMinutes: 30 } });
    expect(cards()[0]!.card.undone).toBe(true);
    expect(await host.undo({ threadId: turn.threadId, requestId })).toEqual({ claimed: true, state: "already_undone" });
  });

  it("a setting never saved reads as the default the app runs on, so Undo of its first change sets that default back", async () => {
    const { host, set, cfg, cards, turn, saved } = fixture();
    delete cfg.rooms; delete cfg.threads; cfg.mcp = {};
    for (const [id, value] of [["rooms.turnTimeoutMinutes", 45], ["mcp.callTimeoutMinutes", 20], ["threads.maxConcurrentPerBot", 7]] as const) {
      const before = cards().length;
      expect((await set(id, value)).status).toBe(200);
      const card = cards()[before]!.card;
      expect(card.appSettingRequest.before, id).toMatch(/^\d+$/);
      expect(await host.undo({ threadId: turn.threadId, requestId: String(card.requestId) }), id).toEqual({ claimed: true, state: "undone" });
    }
    expect(saved.slice(-1)).toEqual([{ threads: { maxConcurrentPerBot: Number(cards()[2]!.card.appSettingRequest.before) } }]);
    expect(saved).toContainEqual({ rooms: { turnTimeoutMinutes: 5 } });
    expect(saved).toContainEqual({ mcp: { callTimeoutMinutes: 10 } });
  });

  it("reorders and groups bots through the registry, with typed values kept for undo", async () => {
    const { host, set, bots, cards, turn } = fixture();
    expect((await set("bots.order", ["clive", "kiwi"])).status).toBe(200);
    expect(bots.map((bot) => bot.id)).toEqual(["clive", "kiwi"]);
    expect(await host.undo({ threadId: turn.threadId, requestId: String(cards()[0]!.card.requestId) })).toEqual({ claimed: true, state: "undone" });
    expect(bots.map((bot) => bot.id)).toEqual(["kiwi", "clive"]);
    expect((await set("bots.groups", { Ops: ["clive"] })).status).toBe(200);
    expect(bots.map((bot) => bot.section)).toEqual([undefined, "Ops"]);
    expect(await host.undo({ threadId: turn.threadId, requestId: String(cards()[1]!.card.requestId) })).toEqual({ claimed: true, state: "undone" });
    expect(bots.map((bot) => bot.section)).toEqual(["Sales", undefined]);
  });

  it("a window preference refuses until a window has reported, then pushes the change", async () => {
    const closed = fixture({ window: false });
    const refused = await closed.set("appearance.skin", "midnight");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Open MausBot on this computer first");
    const open = fixture();
    expect((await open.set("appearance.skin", "midnight")).status).toBe(200);
    expect(open.windowValues.get("appearance.skin")).toBe("midnight");
    expect((await open.set("appearance.skin", "neon")).status).toBe(400);
  });

  it(`stops after ${WRITE_BUDGET} writes in one turn and allows the next turn`, async () => {
    const { set } = fixture();
    for (let index = 0; index < WRITE_BUDGET; index += 1) expect((await set("rooms.turnTimeoutMinutes", 10 + index)).status).toBe(200);
    const over = await set("rooms.turnTimeoutMinutes", 99);
    expect(over.status).toBe(429);
    expect(over.body.error).toContain(`${WRITE_BUDGET} settings`);
    expect((await set("rooms.turnTimeoutMinutes", 99, "gen-2")).status).toBe(200);
  });
});

describe("confirm tier", () => {
  it("always shows a Change/Cancel card, applies on an owner's Allow, and refuses a second open card", async () => {
    const { set, cards, answer, saved, dataDir } = fixture();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const card = cards()[0]!.card;
    expect(card).toMatchObject({ title: "Change Anthropic address?", options: ["Change", "Cancel"], fixedOptions: true, appSettingRequest: { tier: "confirm", before: "https://api.anthropic.com", after: "https://proxy.example/v1" } });
    expect(saved).toEqual([]);
    const second = await set("providers.xai.url", "https://other.example");
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already waiting");
    const shell = answer(String(card.requestId), "allow", false);
    expect(shell.sent).toMatchObject({ status: 403 });
    expect(saved).toEqual([]);
    const owner = answer(String(card.requestId), "allow");
    expect(owner.sent).toMatchObject({ status: 200, body: { ok: true, outcome: "allowed-once" } });
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("Changed Anthropic address from https://api.anthropic.com to https://proxy.example/v1");
    expect(saved).toEqual([{ anthropic: { url: "https://proxy.example/v1" } }]);
    expect(cards()[0]!.card.answered).toBe("allow");
    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10).map((row) => row.decision)).toEqual(["card-shown", "user-approved"]);
  });

  it("Cancel refuses with a line telling the bot not to retry, and the user sees the failure of a refused write", async () => {
    const { set, cards, answer, saved } = fixture();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(answer(String(cards()[0]!.card.requestId), "deny").sent).toMatchObject({ status: 200, body: { outcome: "rejected" } });
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("cancelled");
    expect(result.body.error).toContain("Do not retry");
    expect(saved).toEqual([]);
    const refused = set("providers.anthropic.url", "https://refused.example");
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    answer(String(cards()[1]!.card.requestId), "allow");
    expect((await refused).body.error).toContain("the provider refused it");
  });

  it("times out, patches the card as unavailable, and refuses the write", async () => {
    vi.useFakeTimers();
    const { set, cards, saved } = fixture();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("Nobody answered");
    expect(cards()[0]!.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(saved).toEqual([]);
  });
});

describe("secret tier", () => {
  it("never takes a value, posts the secret card instead, and shows keys only as set or not set", async () => {
    const { host, set, credentialCards, messages, turn, dataDir } = fixture();
    const withValue = await set("keys.openaiApiKey", OPENAI_KEY);
    expect(withValue.status).toBe(400);
    expect(credentialCards).toEqual([]);
    const carded = await set("keys.openaiApiKey");
    expect(carded.status).toBe(200);
    expect(credentialCards).toEqual([{ credentialId: "openaiApiKey", reason: undefined }]);
    const got = await host.handle({ action: "get", id: "keys.openaiApiKey" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "secret", value: "set" });
    const found = await host.handle({ action: "find", query: "anthropic key" }, turn);
    expect(JSON.parse(String(found.body.text))).toContainEqual(expect.objectContaining({ id: "keys.anthropicApiKey", value: "not set" }));
    await flushDecisionLog(dataDir);
    const everything = JSON.stringify([withValue, carded, got, found, messages, readDecisions(dataDir, 10)]);
    expect(everything).not.toContain(OPENAI_KEY);
  });
});

describe("owner-only tier", () => {
  it("explains and refuses with where to change it, approval modes included", async () => {
    const { host, set, turn } = fixture();
    const got = await host.handle({ action: "get", id: "bots.approvalModes" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "owner-only", value: "Kiwi: full; Clive: ask", change: "only the owner, in a bot's Settings" });
    const refused = await set("bots.approvalModes", { kiwi: "full" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("a bot's Settings");
    expect((await set("remote.access", "tunnel")).status).toBe(403);
  });
});
