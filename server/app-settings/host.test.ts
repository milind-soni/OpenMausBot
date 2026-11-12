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
const GATEWAY_KEY = "sk-gateway-0a1b2c3d";
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { owner?: boolean; guest?: boolean; group?: boolean; window?: boolean; chosen?: string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-settings-"));
  dirs.push(dataDir);
  const bots: BotRecord[] = [
    { id: "kiwi", name: "Kiwi", color: "#0f0", threadId: "t-kiwi", approvalMode: "full", section: "Sales" } as unknown as BotRecord,
    { id: "clive", name: "Clive", color: "#00f", threadId: "t-clive", approvalMode: "ask" } as unknown as BotRecord,
  ];
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, threads: { maxConcurrentPerBot: 3 }, openai: { key: OPENAI_KEY }, anthropic: { url: "https://api.anthropic.com" },
    instances: { "openai-compat-gw": { driver: "openai-compat", displayName: "Gateway", config: { key: GATEWAY_KEY, url: "https://gw.example/v1" } } } } as unknown as AppConfig;
  const engineCalls: unknown[] = [];
  const chosen = new Set<string>(options.chosen ?? []);
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
    engines: () => [{ instanceId: "claude", name: "Claude", working: true }, { instanceId: "openai-compat-gw", name: "Gateway", working: true }],
    engineChosen: (instanceId) => chosen.has(instanceId),
    addEngine: async (path, body) => { engineCalls.push({ add: path, body }); return null; },
    removeEngine: async (instanceId) => { engineCalls.push({ remove: instanceId }); return null; },
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
  const set = (id: string, value?: unknown, generation = turn.generation, ended?: AbortSignal) => host.handle({ action: "set", id, ...(value === undefined ? {} : { value }) }, { ...turn, generation }, ended);
  const answer = (requestId: string, behavior: "allow" | "deny", ownerReview = true) => {
    let sent: { status: number; body: unknown } | null = null;
    const res = { writeHead: (status: number) => { sent = { status, body: null }; }, end: (text: string) => { sent = { status: sent?.status ?? 0, body: JSON.parse(text) }; } } as unknown as ServerResponse;
    const claimed = host.resolveAndSend(res, { threadId: turn.threadId, requestId, behavior }, ownerReview);
    return { claimed, sent: sent as { status: number; body: Record<string, unknown> } | null };
  };
  const cards = () => messages.filter((message) => message.card?.appSettingRequest);
  return { host, cfg, saved, messages, cards, credentialCards, notified, windowValues, bots, turn, set, answer, dataDir, engineCalls };
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

describe("a stopped turn", () => {
  it("closes the waiting card at once as unavailable, tells the bot nothing changed, and a later tap changes nothing", async () => {
    const { set, cards, answer, saved, turn } = fixture();
    const stop = new AbortController();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1", turn.generation, stop.signal);
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    stop.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: 409, body: { error: expect.stringMatching(/^This turn was stopped, so the "Anthropic address" card was closed and nothing changed\./) } });
    expect(cards()[0]!.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(answer(String(cards()[0]!.card.requestId), "allow").sent).toMatchObject({ status: 200, body: { outcome: "unavailable" } });
    expect(saved).toEqual([]);
    expect((await set("providers.anthropic.url", "https://proxy.example/v1", turn.generation, stop.signal)).status).toBe(409);
    expect(cards()).toHaveLength(1);
  });

  it("a Stop landing after Change, while the write runs, still tells the bot it changed", async () => {
    const { set, cards, answer, saved, turn } = fixture();
    const stop = new AbortController();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1", turn.generation, stop.signal);
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    answer(String(cards()[0]!.card.requestId), "allow");
    stop.abort();
    expect(await pending).toMatchObject({ status: 200, body: { text: expect.stringMatching(/^Changed Anthropic address/) } });
    expect(cards()[0]!.card).toMatchObject({ answered: "allow" });
    expect(saved).toHaveLength(1);
  });
});

describe("AI engines", () => {
  const confirmed = async (fx: ReturnType<typeof fixture>, value: unknown) => {
    const pending = fx.set("engines", JSON.stringify(value));
    await vi.waitFor(() => expect(fx.cards().filter((card) => !card.card.answered)).toHaveLength(1));
    return { pending, card: fx.cards().at(-1)!.card };
  };

  it("get lists the engines by id with no key, and find reaches them", async () => {
    const { host, turn } = fixture();
    const got = JSON.parse(String((await host.handle({ action: "get", id: "engines" }, turn)).body.text));
    expect(got).toMatchObject({ tier: "confirm", value: "claude: Claude (removed only in Settings); openai-compat-gw: Gateway at https://gw.example/v1" });
    expect(JSON.stringify(got)).not.toContain(GATEWAY_KEY);
    const found = JSON.parse(String((await host.handle({ action: "find", query: "add ollama engine" }, turn)).body.text));
    expect(found[0].id).toBe("engines");
  });

  it("adds a local server only after the owner's Change on a card naming kind, name and address", async () => {
    const fx = fixture();
    const { pending, card } = await confirmed(fx, { kind: "ollama", url: "http://127.0.0.1:11434" });
    expect(card).toMatchObject({ title: "Change AI engines?", subtitle: "Add the engine \"Ollama\" (Ollama on http://127.0.0.1:11434)", options: ["Change", "Cancel"],
      appSettingRequest: { settingId: "engines", tier: "confirm", after: "Add the engine \"Ollama\" (Ollama on http://127.0.0.1:11434)" } });
    expect(card.appSettingRequest).not.toHaveProperty("before");
    expect(fx.answer(String(card.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.engineCalls).toEqual([]);
    fx.answer(String(card.requestId), "allow");
    expect((await pending).body.text).toMatch(/^Done: Add the engine "Ollama" \(Ollama on http:\/\/127\.0\.0\.1:11434\)\. AI engines now: /);
    expect(fx.engineCalls).toEqual([{ add: "openai-compat", body: { displayName: "Ollama", url: "http://127.0.0.1:11434", key: "ollama", catalog: "ollama" } }]);
  });

  it("an engine that needs a key takes only a saved key's id, which the server reads at the tap; the key is shown nowhere", async () => {
    const fx = fixture();
    const missing = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", keyFrom: "mistralApiKey" }));
    expect(missing).toMatchObject({ status: 409, body: { error: "Your Mistral API key is not saved yet. Call set on keys.mistralApiKey with no value first (a secure card asks the user for it), then add the engine." } });
    for (const field of ["key", "apiKey", "token"]) {
      const inline = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", [field]: OPENAI_KEY }));
      expect(inline.status, field).toBe(400);
      expect(inline.body.error, field).toContain("Never put a key or token in the value");
    }
    expect(fx.cards()).toEqual([]);
    const { pending, card } = await confirmed(fx, { kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", keyFrom: "openaiApiKey" });
    expect(card.subtitle).toBe("Add the engine \"Proxy\" (OpenAI-compatible) at https://proxy.example/v1, sending it your saved OpenAI API key");
    fx.answer(String(card.requestId), "allow");
    const result = await pending;
    expect(fx.engineCalls).toEqual([{ add: "openai-compat", body: { displayName: "Proxy", url: "https://proxy.example/v1", key: OPENAI_KEY } }]);
    await flushDecisionLog(fx.dataDir);
    expect(JSON.stringify([missing, result, fx.messages, readDecisions(fx.dataDir, 20)])).not.toContain(OPENAI_KEY);
  });

  it("removes only an engine added without a sign-in and chosen by no bot, after Change; Cancel removes nothing", async () => {
    const fx = fixture();
    expect((await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "nope" }))).body.error).toContain("No engine has the id nope");
    expect((await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "claude" }))).body.error).toBe("Claude is removed only by the user, in Settings → AI. Tell them where; do not try another way.");
    const cancelled = await confirmed(fx, { kind: "remove", instanceId: "openai-compat-gw" });
    expect(cancelled.card.subtitle).toBe("Remove the engine \"Gateway\" (OpenAI-compatible server, https://gw.example/v1)");
    fx.answer(String(cancelled.card.requestId), "deny");
    expect((await cancelled.pending).body.error).toContain("cancelled");
    expect(fx.engineCalls).toEqual([]);
    const applied = await confirmed(fx, { kind: "remove", instanceId: "openai-compat-gw" });
    fx.answer(String(applied.card.requestId), "allow");
    expect((await applied.pending).status).toBe(200);
    expect(fx.engineCalls).toEqual([{ remove: "openai-compat-gw" }]);
  });

  it("refuses to remove an engine a bot or the new-bot default uses, before any card", async () => {
    const fx = fixture({ chosen: ["openai-compat-gw"] });
    const refused = await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "openai-compat-gw" }));
    expect(refused).toMatchObject({ status: 409, body: { error: expect.stringMatching(/^Bots or the default model for new bots use Gateway\./) } });
    expect(fx.cards()).toEqual([]);
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
