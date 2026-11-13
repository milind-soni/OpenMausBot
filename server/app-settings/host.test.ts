import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fixture(options: { owner?: boolean; guest?: boolean; group?: boolean; window?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-settings-"));
  dirs.push(dataDir);
  const bots: BotRecord[] = [
    { id: "kiwi", name: "Kiwi", color: "green", threadId: "t-kiwi", approvalMode: "full", section: "Sales", modelSelection: { instanceId: "claude", model: "opus" } } as unknown as BotRecord,
    { id: "clive", name: "Clive", color: "blue", threadId: "t-clive", approvalMode: "ask", modelSelection: { instanceId: "claude", model: "sonnet" }, assignedSkills: ["notes"] } as unknown as BotRecord,
  ];
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, threads: { maxConcurrentPerBot: 3 }, openai: { key: OPENAI_KEY }, anthropic: { url: "https://api.anthropic.com" },
    instances: { "openai-compat-gw": { driver: "openai-compat", displayName: "Gateway", config: { key: GATEWAY_KEY, url: "https://gw.example/v1" } } } } as unknown as AppConfig;
  const engineCalls: unknown[] = [];
  const engines = [{ instanceId: "claude", name: "Claude", working: true }, { instanceId: "openai-compat-gw", name: "Gateway", working: true }];
  const botPatches: Array<{ botId: string; body: Record<string, unknown> }> = [];
  const routeCalls: unknown[] = [];
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
    patchBot: async (botId, body) => { botPatches.push({ botId, body }); Object.assign(bots.find((bot) => bot.id === botId)!, body); return null; },
    call: async (route, method, path, body) => { routeCalls.push({ route, method, path, body }); return null; },
    read: async (_route, path) => (path === "/api/skills-library" ? { skills: [{ name: "notes", enabled: false, everyBot: false }] } : null),
    paused: () => [],
    pinBot: async (botId, pinned) => { (bots.find((bot) => bot.id === botId) as { pinned?: boolean }).pinned = pinned || undefined; return null; },
    groupBots: async (name, botIds) => { for (const bot of bots) if (botIds.includes(bot.id)) (bot as { section?: string }).section = name || undefined; return null; },
    credentials: () => cfg,
    window: {
      read: (id) => windowValues.get(id),
      write: (id, value) => { if (!windowValues.size) return "Open MausBot on this computer first."; windowValues.set(id, value); return null; },
    },
    engines: () => engines,
    addEngine: async (path, body) => {
      engineCalls.push({ add: path, body });
      const instanceId = `openai-compat-${engines.length}`;
      engines.push({ instanceId, name: String(body.displayName), working: true });
      (cfg.instances as Record<string, unknown>)[instanceId] = { driver: "openai-compat", displayName: body.displayName, config: { url: body.url, key: body.key } };
      return null;
    },
    removeEngine: async (instanceId) => { engineCalls.push({ remove: instanceId }); engines.splice(engines.findIndex((engine) => engine.instanceId === instanceId), 1); return null; },
  });
  const host = createAppSettings({
    store: store as never, dataDir, entries,
    turnOwner: () => (options.owner === false ? null : "owner"),
    guestDriven: () => options.guest === true,
    requestCredential: async (_bot, _threadId, body) => { credentialCards.push(body); return { status: 201, body: { messageId: "secret-1", label: "OpenAI API key" } }; },
    connectorThread: () => ({ group: options.group ? { id: "g", name: "Room" } as never : undefined }),
    language: () => undefined,
  });
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const set = (id: string, value?: unknown, generation = turn.generation) => host.handle({ action: "set", id, ...(value === undefined ? {} : { value }) }, { ...turn, generation });
  const cards = () => messages.filter((message) => message.card?.appSettingRequest);
  /** Undo on the newest applied card. */
  const undo = () => host.undo({ threadId: turn.threadId, requestId: String(cards().at(-1)!.card.requestId) });
  return { host, cfg, saved, messages, cards, credentialCards, windowValues, bots, turn, set, undo, dataDir, engineCalls, botPatches, routeCalls, engines };
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

  it("pins and unpins bots from the full list sent, refuses an unknown id, and Undo restores the earlier pins", async () => {
    const { host, set, bots, cards, turn } = fixture();
    const pins = () => bots.filter((bot) => bot.pinned).map((bot) => bot.id);
    expect((await set("bots.pinned", JSON.stringify(["clive"]))).body.text).toMatch(/^Changed Pinned bots from not set to Clive\./);
    expect(pins()).toEqual(["clive"]);
    expect((await set("bots.pinned", ["kiwi"])).status).toBe(200);
    expect(pins()).toEqual(["kiwi"]);
    expect(await host.undo({ threadId: turn.threadId, requestId: String(cards()[1]!.card.requestId) })).toEqual({ claimed: true, state: "undone" });
    expect(pins()).toEqual(["clive"]);
    expect((await set("bots.pinned", ["ghost"])).body.error).toContain("No bot has the id ghost");
    expect(pins()).toEqual(["clive"]);
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

describe("AI engines", () => {
  it("get lists the engines by id with no key, and find reaches them", async () => {
    const { host, turn } = fixture();
    const got = JSON.parse(String((await host.handle({ action: "get", id: "engines" }, turn)).body.text));
    expect(got).toMatchObject({ tier: "safe", value: "claude: Claude (removed only in Settings); openai-compat-gw: Gateway at https://gw.example/v1" });
    expect(JSON.stringify(got)).not.toContain(GATEWAY_KEY);
    const found = JSON.parse(String((await host.handle({ action: "find", query: "add ollama engine" }, turn)).body.text));
    expect(found[0].id).toBe("engines");
  });

  it("adds a local server at once with a card naming kind, name and address, and Undo removes it", async () => {
    const fx = fixture();
    const added = await fx.set("engines", JSON.stringify({ kind: "ollama", url: "http://127.0.0.1:11434" }));
    expect(added.body.text).toMatch(/^Done: Add the engine "Ollama" \(Ollama on http:\/\/127\.0\.0\.1:11434\)\. AI engines now: .*The user can undo it/);
    expect(fx.engineCalls).toEqual([{ add: "openai-compat", body: { displayName: "Ollama", url: "http://127.0.0.1:11434", key: "ollama", catalog: "ollama" } }]);
    expect(fx.cards()[0]!.card).toMatchObject({ title: "Changed AI engines", subtitle: "Add the engine \"Ollama\" (Ollama on http://127.0.0.1:11434)", options: [], autoApplied: true,
      appSettingRequest: { settingId: "engines", tier: "safe", after: "Add the engine \"Ollama\" (Ollama on http://127.0.0.1:11434)" } });
    expect(fx.cards()[0]!.card.appSettingRequest).not.toHaveProperty("before");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.engineCalls.at(-1)).toEqual({ remove: "openai-compat-2" });
    expect(fx.engines.map((engine) => engine.instanceId)).toEqual(["claude", "openai-compat-gw"]);
  });

  it("an engine that needs a key takes only a saved key's id, which the server reads as it adds it; the key is shown nowhere", async () => {
    const fx = fixture();
    const missing = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", keyFrom: "mistralApiKey" }));
    expect(missing).toMatchObject({ status: 409, body: { error: "Your Mistral API key is not saved yet. Call set on keys.mistralApiKey with no value first (a secure card asks the user for it), then add the engine." } });
    for (const field of ["key", "apiKey", "token"]) {
      const inline = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", [field]: OPENAI_KEY }));
      expect(inline.status, field).toBe(400);
      expect(inline.body.error, field).toContain("Never put a key or token in the value");
    }
    expect(fx.cards()).toEqual([]);
    const result = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", keyFrom: "openaiApiKey" }));
    expect(fx.cards()[0]!.card.subtitle).toBe("Add the engine \"Proxy\" (OpenAI-compatible) at https://proxy.example/v1, sending it your saved OpenAI API key");
    expect(fx.engineCalls).toEqual([{ add: "openai-compat", body: { displayName: "Proxy", url: "https://proxy.example/v1", key: OPENAI_KEY } }]);
    await flushDecisionLog(fx.dataDir);
    expect(JSON.stringify([missing, result, fx.messages, readDecisions(fx.dataDir, 20)])).not.toContain(OPENAI_KEY);
  });

  it("never removes an engine: the bot is told in one line that the person does that in Settings", async () => {
    const fx = fixture();
    const refused = await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "openai-compat-gw" }));
    expect(refused).toMatchObject({ status: 409, body: { error: "Removing an AI engine is changed only by the person, in Settings → AI. Tell them where in one line; do not try another way." } });
    expect(fx.engineCalls).toEqual([]);
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
  it("explains and refuses with where to change it: sign-in, logins, pairing, backups, the domain, a photo", async () => {
    const { host, set, turn, cards, saved, routeCalls } = fixture();
    const got = await host.handle({ action: "get", id: "vault.logins" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "owner-only", change: "only the person, in Settings → Vault" });
    for (const id of ["cloud.account", "vault.logins", "phone.pairing", "data.backups", "people.signIn", "remote.domain", "remote.httpsAddress", "profile.photo"]) {
      const refused = await set(id, "on");
      expect(refused.status, id).toBe(403);
      expect(refused.body.error, id).toMatch(/ is changed only by the person, in Settings → .+\. Tell them where in one line; do not try another way\.$/);
    }
    expect([cards(), saved, routeCalls]).toEqual([[], [], []]);
  });

  it("turns a way in to this computer on with Undo, but leaves turning one off to the person", async () => {
    const fx = fixture();
    fx.windowValues.set("remote.relay", false);
    const on = await fx.set("remote.relay", "true");
    expect(on.body.text).toMatch(/^Done: Let your paired phones reach this computer from anywhere, through MausBot's relay\./);
    expect(fx.windowValues.get("remote.relay")).toBe(true);
    const off = await fx.set("remote.relay", false);
    expect(off).toMatchObject({ status: 409, body: { error: "Turning off Reach from anywhere is changed only by the person, in Settings → Phone & devices. Tell them where in one line; do not try another way." } });
    expect(fx.windowValues.get("remote.relay")).toBe(true);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.windowValues.get("remote.relay")).toBe(false);
  });
});

describe("every other setting applies at once with Undo, Full access or not", () => {
  const written = (fx: ReturnType<typeof fixture>) => JSON.stringify([fx.botPatches, fx.saved, fx.routeCalls, [...fx.windowValues]]);

  it.each([
    ["a bot's own setting", "bots.name", { botId: "clive", name: "Clover" }, "Rename Clive to \"Clover\"",
      (fx: ReturnType<typeof fixture>) => expect(fx.botPatches).toEqual([{ botId: "clive", body: { name: "Clover" } }, { botId: "clive", body: { name: "Clive" } }])],
    ["a server setting", "profile.name", "Ada", "not set → Ada", (fx: ReturnType<typeof fixture>) => expect(fx.saved).toEqual([{ profile: { name: "Ada" } }, { profile: { name: "" } }])],
    ["a provider address", "providers.anthropic.url", "https://proxy.example/v1", "https://api.anthropic.com → https://proxy.example/v1",
      (fx: ReturnType<typeof fixture>) => expect(fx.saved).toEqual([{ anthropic: { url: "https://proxy.example/v1" } }, { anthropic: { url: "https://api.anthropic.com" } }])],
    ["a library skill", "skills.library", { name: "notes", enabled: true }, "Turn on the library skill notes",
      (fx: ReturnType<typeof fixture>) => expect(fx.routeCalls).toEqual([{ route: "skills", method: "PATCH", path: "/api/skills-library/notes", body: { enabled: true } }, { route: "skills", method: "PATCH", path: "/api/skills-library/notes", body: { enabled: false } }])],
    ["a window preference", "general.openAtLogin", true, "Open MausBot when you log in", (fx: ReturnType<typeof fixture>) => expect(fx.windowValues.get("general.openAtLogin")).toBe(false)],
  ])("%s applies with no card to answer, and Undo puts it back", async (_kind, id, value, subtitle, check) => {
    const fx = fixture();
    fx.windowValues.set("general.openAtLogin", false);
    const before = written(fx);
    const result = await fx.set(id, typeof value === "string" ? value : JSON.stringify(value));
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("The user can undo it from the card");
    expect(written(fx)).not.toBe(before);
    expect(fx.cards()[0]!.card).toMatchObject({ options: [], answered: "allow", autoApplied: true, subtitle, appSettingRequest: { settingId: id, tier: "safe" } });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    check(fx);
    await flushDecisionLog(fx.dataDir);
    expect(readDecisions(fx.dataDir, 10)).toMatchObject([{ decision: "auto-approved", source: "app-settings", tool: "app_settings", summary: expect.stringMatching(new RegExp(`^${id.replaceAll(".", "\\.")}: `)) }]);
  });

  it("an approval mode change says what it allows and applies at once; Undo restores the earlier mode", async () => {
    const fx = fixture();
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.approvalModes" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "safe", value: "Kiwi: Full access; Clive: Ask for approval" });
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "clive", mode: "full" }))).status).toBe(200);
    expect(fx.cards()[0]!.card.subtitle).toBe("Let Clive act without asking (Full access)");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([{ botId: "clive", body: { approvalMode: "full", applyToAllThreads: true } }, { botId: "clive", body: { approvalMode: "ask", applyToAllThreads: true } }]);
  });

  it("refuses an unknown bot, an invalid mode, Custom, and Approve for me on this computer's own desktop", async () => {
    const fx = fixture();
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "ghost", mode: "ask" })))).toMatchObject({ status: 409, body: { error: "No bot has the id ghost. Use list_bots for the ids." } });
    expect((await fx.set("bots.name", JSON.stringify({ botId: "ghost", name: "Boo" }))).status).toBe(409);
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "clive", mode: "custom" }))).status).toBe(400);
    (fx.bots[1] as { computer?: string }).computer = "local";
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "clive", mode: "auto" }))).body.error).toMatch(/needs a warning only Clive's Settings shows/);
    expect((await fx.set("bots.model", JSON.stringify({ botId: "clive", instanceId: "nowhere", model: "x" }))).body.error).toContain("No engine has the id nowhere");
    expect(fx.cards()).toEqual([]);
    expect(fx.botPatches).toEqual([]);
  });

  it("never takes a key or token in a value", async () => {
    const fx = fixture();
    for (const [id, value] of [["bots.settings", { botId: "kiwi", apiKey: OPENAI_KEY }], ["ai.routing", { enabled: true, openrouterKey: OPENAI_KEY }], ["ai.images", { key: OPENAI_KEY }]] as const) {
      const refused = await fx.set(id, JSON.stringify(value));
      expect(refused.status, id).toBe(400);
      expect(refused.body.error, id).toContain("Never put a key or token in the value");
    }
    expect(fx.cards()).toEqual([]);
    expect(JSON.stringify(fx.messages)).not.toContain(OPENAI_KEY);
  });

  it("a window preference is refused while no window is open, and nothing is posted", async () => {
    const fx = fixture({ window: false });
    expect((await fx.set("general.openAtLogin", true)).body.error).toContain("Open MausBot on this computer first");
    expect(fx.cards()).toEqual([]);
    expect(fx.windowValues.size).toBe(0);
  });

  it("a browser profile is added naming whose browser it uses, never removed by a bot, and Undo takes the new one away", async () => {
    const fx = fixture();
    (fx.cfg as { browserProfiles?: unknown }).browserProfiles = [{ id: "work", name: "Work" }];
    expect((await fx.set("desktops.browserProfiles", JSON.stringify([]))).body.error).toMatch(/^Removing the browser profile "Work" deletes its saved logins/);
    expect(fx.cards()).toEqual([]);
    await fx.set("desktops.browserProfiles", JSON.stringify([{ id: "work", name: "Work" }, { name: "Mine", browser: "chrome" }]));
    expect(fx.cards()[0]!.card.subtitle).toBe("Browser profiles: add the profile \"Mine\" on your own running Chrome, with its logins");
    expect(fx.saved).toEqual([{ browserProfiles: [{ id: "work", name: "Work" }, { id: expect.stringMatching(/^profile-[0-9a-f]{32}$/), name: "Mine", browser: "chrome" }], expectedBrowserProfiles: [{ id: "work", name: "Work" }] }]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toMatchObject({ browserProfiles: [{ id: "work", name: "Work" }] });
  });

  it("other bot settings name each change, and Undo restores each field as the bot ran on it", async () => {
    const fx = fixture();
    await fx.set("bots.settings", JSON.stringify({ botId: "kiwi", memoryEnabled: false, computer: "local" }));
    expect(fx.cards()[0]!.card.subtitle).toBe("Kiwi: memory off; computer use this computer's own desktop, as you");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { memoryEnabled: false, computer: "local" } }, { botId: "kiwi", body: { memoryEnabled: true, computer: null } }]);
  });

  it("the browser proxy takes only a socks5 address, reads as set or not set, and Undo clears it", async () => {
    const fx = fixture();
    expect((await fx.set("desktops.browserProxy", "http://proxy.example:8080")).status).toBe(400);
    const result = await fx.set("desktops.browserProxy", "socks5://proxy.example:1080");
    expect(result.body.text).toMatch(/^Done: Send bots' browsers to public sites through the SOCKS5 proxy you named\. Browser proxy now: set\./);
    expect(JSON.stringify(fx.messages)).not.toContain("proxy.example");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved).toEqual([{ browserEngine: { egress: { proxy: "socks5://proxy.example:1080" } } }, { browserEngine: { egress: { proxy: "" } } }]);
  });

  it("a bot's library skills are set from the full list, and Undo gives back the earlier list", async () => {
    const fx = fixture();
    await fx.set("bots.skills", JSON.stringify({ botId: "clive", skills: [] }));
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.routeCalls).toEqual([
      { route: "skills", method: "PUT", path: "/api/bots/clive/skills-library", body: { skills: [] } },
      { route: "skills", method: "PUT", path: "/api/bots/clive/skills-library", body: { skills: ["notes"] } },
    ]);
  });
});
