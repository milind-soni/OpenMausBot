import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import type { TurnOwnerRefusal } from "../host/phones.ts";
import type { BotRecord } from "../store.ts";
import { createAppSettings, WRITE_BUDGET } from "./host.ts";
import { createSettingsRegistry } from "./registry.ts";

const OPENAI_KEY = "sk-live-9f8e7d6c5b4a3210";
const GATEWAY_KEY = "sk-gateway-0a1b2c3d";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fixture(options: { owner?: boolean; ownerRefusal?: TurnOwnerRefusal; guest?: boolean; group?: boolean; window?: boolean; pictureRefusal?: string; patchRefusal?: string; patchRefusalFor?: (botId: string) => string | null; emptyRegistryBots?: boolean; automated?: boolean; tts?: AppConfig["tts"] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-settings-"));
  dirs.push(dataDir);
  const bots: BotRecord[] = [
    { id: "kiwi", name: "Kiwi", color: "green", threadId: "t-kiwi", approvalMode: "full", section: "Sales", modelSelection: { instanceId: "claude", model: "opus" } } as unknown as BotRecord,
    { id: "clive", name: "Clive", color: "blue", threadId: "t-clive", approvalMode: "ask", modelSelection: { instanceId: "claude", model: "sonnet" }, assignedSkills: ["notes"] } as unknown as BotRecord,
  ];
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, threads: { maxConcurrentPerBot: 3 }, openai: { key: OPENAI_KEY }, anthropic: { url: "https://api.anthropic.com" },
    ...(options.tts ? { tts: options.tts } : {}),
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
  const pictureFiles: { taken: string[]; discarded: string[] } = { taken: [], discarded: [] };
  const entries = createSettingsRegistry({
    cfg: () => cfg,
    saveConfig: async (patch) => {
      if (patch.anthropic && typeof patch.anthropic === "object" && (patch.anthropic as { url?: string }).url === "https://refused.example") return "the provider refused it";
      saved.push(patch);
      Object.assign(cfg, patch);
      return null;
    },
    bots: () => (options.emptyRegistryBots ? [] : bots),
    sections: () => ["Sales"],
    reorderBots: async (botIds) => { bots.sort((a, b) => botIds.indexOf(a.id) - botIds.indexOf(b.id)); return null; },
    patchBot: async (botId, body) => { const refusal = options.patchRefusal ?? options.patchRefusalFor?.(botId); if (refusal) return refusal; botPatches.push({ botId, body }); Object.assign(bots.find((bot) => bot.id === botId)!, body); return null; },
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
    ownerRefusal: () => (options.owner === false ? (options.ownerRefusal ?? null) : null),
    guestDriven: () => options.guest === true,
    automated: () => options.automated === true,
    requestCredential: async (_bot, _threadId, body) => { credentialCards.push(body); return { status: 201, body: { messageId: "secret-1", label: "OpenAI API key" } }; },
    connectorThread: () => ({ group: options.group ? { id: "g", name: "Room" } as never : undefined }),
    language: () => undefined,
    pictures: {
      take: async (_turn, path) => {
        pictureFiles.taken.push(path);
        return options.pictureRefusal ? { refusal: options.pictureRefusal } : { avatarUrl: `/api/attachments/stored-${pictureFiles.taken.length}.png` };
      },
      discard: (avatarUrl) => { pictureFiles.discarded.push(avatarUrl); },
    },
  });
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const set = (id: string, value?: unknown, generation = turn.generation) => host.handle({ action: "set", id, ...(value === undefined ? {} : { value }) }, { ...turn, generation });
  const cards = () => messages.filter((message) => message.card?.appSettingRequest);
  /** Undo on the newest applied card. */
  const undo = () => host.undo({ threadId: turn.threadId, requestId: String(cards().at(-1)!.card.requestId) });
  return { host, cfg, saved, messages, cards, credentialCards, windowValues, bots, turn, set, undo, dataDir, engineCalls, botPatches, routeCalls, engines, pictureFiles };
}

describe("reads", () => {
  it("find lists matches with tier, value and where; get adds help and allowed values", async () => {
    const { host, turn } = fixture();
    const found = await host.handle({ action: "find", query: "dark mode" }, turn);
    const hits = JSON.parse(String(found.body.text)) as Array<Record<string, unknown>>;
    expect(hits[0]).toMatchObject({ id: "appearance.skin", tier: "safe", value: "daylight", where: "Settings → Appearance → Theme" });
    const got = await host.handle({ action: "get", id: "rooms.turnTimeoutMinutes" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ id: "rooms.turnTimeoutMinutes", value: "30", allowed: "1 to 1440 minutes", change: "set applies at once, with Undo on the card" });
  });

  it("names the per-bot connected apps switch as the bot panel does, so find reaches it by those words", async () => {
    const { host, turn } = fixture();
    const found = JSON.parse(String((await host.handle({ action: "find", query: "connected apps" }, turn)).body.text)) as Array<{ id: string }>;
    expect(found.map((hit) => hit.id)).toContain("bots.settings");
    const got = JSON.parse(String((await host.handle({ action: "get", id: "bots.settings" }, turn)).body.text)) as { help: string };
    expect(got.help).toContain("connected apps");
    expect(got.help).not.toContain("Composio apps");
  });

  it("names real places only: find falls back to where a thing is, places lists them all", async () => {
    const { host, turn } = fixture();
    const owner = await host.handle({ action: "get", id: "phone.pairing" }, turn);
    expect(JSON.parse(String(owner.body.text))).toMatchObject({ where: "Settings → Devices → Phones and tablets → Add a phone", change: "only the person, in Settings → Devices → Phones and tablets → Add a phone" });
    const none = await host.handle({ action: "find", query: "invoice" }, turn);
    expect(none.body.text).toMatch(/^No setting you can change matches "invoice"\. Where the person finds it in the app: Settings → Plan & billing/);
    expect((await host.handle({ action: "places", query: "spending" }, turn)).body.text).toMatch(/^Settings → Spending$/m);
    expect((await host.handle({ action: "places", query: "storage" }, turn)).body.text).toMatch(/^Settings → Data.*\(shown in Advanced mode; the switch is at the bottom of Settings\)$/m);
    const every = String((await host.handle({ action: "places" }, turn)).body.text).split("\n");
    expect(every[0]).toMatch(/^Settings opens from/);
    expect(every).toContain("Settings → AI → Other services");
    expect(every.join("\n")).not.toMatch(/API keys|Computers\b/);
  });

  it("works in a turn that is not the owner's, where writes are refused", async () => {
    const { host, turn, set, saved } = fixture({ owner: false });
    expect((await host.handle({ action: "get", id: "general.language" }, turn)).status).toBe(200);
    const refused = await set("general.language", "de");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("owner's own conversation");
    expect(saved).toEqual([]);
  });

  it("says why a turn is not the owner's own and what the person can do instead, and still changes nothing", async () => {
    const said = async (options: Parameters<typeof fixture>[0]) => {
      const { host, turn, set, saved } = fixture(options);
      const where = (JSON.parse(String((await host.handle({ action: "get", id: "general.language" }, turn)).body.text)) as { where: string }).where;
      const refused = await set("general.language", "de");
      expect(refused.status).toBe(403);
      expect(saved).toEqual([]);
      const error = String(refused.body.error);
      expect(error).toMatch(/^Settings change only in the owner's own conversation\. Nothing changed; you may still read settings\. /);
      expect(error).toContain(`The person can change it themselves in ${where}.`);
      return error;
    };
    expect(await said({ owner: false, ownerRefusal: "shared" })).toContain("Several people share this server");
    expect(await said({ owner: false, ownerRefusal: "service" })).toContain("set up as a shared or hosted server");
    expect(await said({ guest: true })).toContain("A guest writes in this conversation");
    const someoneElse = await said({ owner: false, ownerRefusal: "someone-else" });
    expect(someoneElse).toContain("asking again here won't work");
    expect(someoneElse).toContain("a new conversation with this bot that only they write in");
    expect(await said({ owner: false, ownerRefusal: "not-owner" })).toContain("started by someone other than the owner");
    expect(await said({ owner: false, ownerRefusal: "memory-changed" })).toContain("tap Mark reviewed");
    expect(await said({ owner: false, ownerRefusal: "unproven" })).toContain("can't be tied to a message the owner sent here");
    // No reason given: the plain words, still refused.
    expect(await said({ owner: false })).toContain("can't be tied to a message the owner sent here");
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

  it("refuses a local server already added at the same address, so Settings never lists it twice", async () => {
    const fx = fixture();
    await fx.set("engines", JSON.stringify({ kind: "lmstudio", url: "http://127.0.0.1:1234/v1" }));
    const again = await fx.set("engines", JSON.stringify({ kind: "lmstudio", url: "http://127.0.0.1:1234/v1/" }));
    expect(again).toMatchObject({ status: 409, body: { error: "\"LM Studio\" at http://127.0.0.1:1234/v1 is already an engine (openai-compat-2). Use that one; do not add it again." } });
    expect(fx.engineCalls).toHaveLength(1);
    expect(fx.cards()).toHaveLength(1);
    // Another address is another server.
    await fx.set("engines", JSON.stringify({ kind: "lmstudio", url: "http://127.0.0.1:1235/v1" }));
    expect(fx.engineCalls).toHaveLength(2);
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
    expect(refused).toMatchObject({ status: 409, body: { error: "Removing an AI engine is changed only by the person, in Settings → AI → Providers. Tell them where in one line; do not try another way." } });
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
  it("explains and refuses with where to change it: sign-in, logins, pairing, backups, the domain", async () => {
    const { host, set, turn, cards, saved, routeCalls } = fixture();
    const got = await host.handle({ action: "get", id: "vault.logins" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "owner-only", change: "only the person, in Settings → Vault" });
    for (const id of ["cloud.account", "vault.logins", "phone.pairing", "data.backups", "people.signIn", "remote.domain", "remote.httpsAddress"]) {
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
    expect(off).toMatchObject({ status: 409, body: { error: "Turning off Reach from anywhere is changed only by the person, in Settings → Devices → How your phone reaches this computer → Anywhere, through MausBot (only in the desktop app, on this computer's own page). Tell them where in one line; do not try another way." } });
    expect(fx.windowValues.get("remote.relay")).toBe(true);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.windowValues.get("remote.relay")).toBe(false);
  });
});

describe("pictures from a file the bot names", () => {
  const MASCOT = { avatarUrl: null, avatarCrop: "mascot", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 };

  it("gives a bot the stored picture in a circle, with Undo back to its mascot face", async () => {
    const fx = fixture();
    const done = await fx.set("bots.picture", JSON.stringify({ botId: "clive", path: "/work/clive.png" }));
    expect(done.body.text).toBe("Done: Give Clive the picture clive.png. Bot picture now: Kiwi: mascot face; Clive: /api/attachments/stored-1.png. The user can undo it from the card in the conversation.");
    expect(fx.pictureFiles.taken).toEqual(["/work/clive.png"]);
    expect(fx.botPatches).toEqual([{ botId: "clive", body: { avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "circle", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 } }]);
    expect(fx.cards()[0]!.card).toMatchObject({ subtitle: "Give Clive the picture clive.png", appSettingRequest: { settingId: "bots.picture", after: "Give Clive the picture clive.png" } });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches[1]).toEqual({ botId: "clive", body: { ...MASCOT, avatarUrl: null } });
  });

  it("keeps a bot's own crop, takes a picture off with an empty path, and Undo puts the earlier picture back", async () => {
    const fx = fixture();
    Object.assign(fx.bots[0]!, { avatarUrl: "/api/attachments/earlier.webp", avatarCrop: "rounded", avatarZoom: 2 });
    await fx.set("bots.picture", { botId: "kiwi", path: "new.gif" });
    expect(fx.botPatches[0]!.body).toMatchObject({ avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "rounded", avatarZoom: 1 });
    const off = await fx.set("bots.picture", { botId: "kiwi", path: "" });
    expect(off.body.text).toMatch(/^Done: Take Kiwi's picture off; it shows its mascot face again\./);
    expect(fx.botPatches[1]!.body).toEqual(MASCOT);
    expect(fx.pictureFiles.taken).toEqual(["new.gif"]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches[2]!.body).toEqual({ avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "rounded", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 });
    expect(await fx.set("bots.picture", { botId: "clive", path: "" })).toMatchObject({ status: 409, body: { error: "Clive has no picture; it already shows its mascot face." } });
  });

  it("sets and takes off the person's photo through the config route, with Undo", async () => {
    const fx = fixture();
    const done = await fx.set("profile.photo", { path: "/work/me.jpg" });
    expect(done.body.text).toMatch(/^Done: Make me\.jpg your photo\. Your photo now: \/api\/attachments\/stored-1\.png\./);
    expect(fx.saved).toEqual([{ profile: { avatarUrl: "/api/attachments/stored-1.png" } }]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved[1]).toEqual({ profile: { avatarUrl: "" } });
    expect(await fx.set("profile.photo", { path: "" })).toMatchObject({ status: 409, body: { error: "The person has no photo to take off." } });
  });

  it("stores nothing when the turn may not change settings, the bot is unknown or the file is refused", async () => {
    const notOwner = fixture({ owner: false });
    expect((await notOwner.set("bots.picture", { botId: "kiwi", path: "a.png" })).status).toBe(403);
    expect((await notOwner.set("profile.photo", { path: "a.png" })).status).toBe(403);
    expect(notOwner.pictureFiles.taken).toEqual([]);

    const fx = fixture({ pictureRefusal: "a.png is not a PNG, JPEG, GIF or WebP picture." });
    expect(await fx.set("bots.picture", { botId: "nobody", path: "a.png" })).toMatchObject({ status: 409, body: { error: "No bot has the id nobody. Use list_bots for the ids." } });
    expect(await fx.set("bots.picture", { botId: "kiwi", path: "a.png" })).toEqual({ status: 400, body: { error: "a.png is not a PNG, JPEG, GIF or WebP picture." } });
    expect(await fx.set("bots.picture", { botId: "kiwi", avatarUrl: "/api/attachments/x.png" })).toMatchObject({ status: 400 });
    expect([fx.botPatches, fx.saved, fx.cards()]).toEqual([[], [], []]);
  });

  it("takes back the stored copy when the route refuses the change", async () => {
    const fx = fixture({ patchRefusal: "avatarUrl must reference an existing stored image" });
    expect(await fx.set("bots.picture", { botId: "kiwi", path: "a.png" })).toEqual({ status: 409, body: { error: "avatarUrl must reference an existing stored image" } });
    expect(fx.pictureFiles.discarded).toEqual(["/api/attachments/stored-1.png"]);
    expect(fx.cards()).toEqual([]);
  });
});

describe("Simple mode: a bot changes settings in the background and never switches the mode", () => {
  const simple = () => { const fx = fixture(); fx.windowValues.set("appearance.advanced", false); return fx; };

  it("changes a setting only Advanced mode shows while the app stays on Simple", async () => {
    const fx = simple();
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "threads.maxConcurrentPerBot" }, fx.turn)).body.text)) as { where: string; inSimple: string };
    expect(got).toMatchObject({ where: expect.stringMatching(/\(shown in Advanced mode; the switch is at the bottom of Settings\)$/), inSimple: "set it as usual; never switch modes for it" });
    expect(got.where).not.toContain("appearance.advanced");
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "parallel threads" }, fx.turn)).body.text)) as Array<{ id: string; inSimple?: string }>;
    expect(found.find((hit) => hit.id === "threads.maxConcurrentPerBot")?.inSimple).toBe("set it as usual; never switch modes for it");
    const personOnly = JSON.parse(String((await fx.host.handle({ action: "get", id: "remote.httpsAddress" }, fx.turn)).body.text)) as Record<string, unknown>;
    expect(personOnly).toMatchObject({ change: "only the person, in Settings → Devices → How your phone reaches this computer → HTTPS address (shown in Advanced mode; the switch is at the bottom of Settings; only in the desktop app, on this computer's own page)" });
    expect(personOnly).not.toHaveProperty("inSimple");
    expect((await fx.set("threads.maxConcurrentPerBot", "5")).status).toBe(200);
    expect(fx.cfg.threads?.maxConcurrentPerBot).toBe(5);
    expect(fx.windowValues.get("appearance.advanced")).toBe(false);
    expect(fx.cards().map((card) => card.card.appSettingRequest.settingId)).toEqual(["threads.maxConcurrentPerBot"]);
  });

  it("tells a bot to change the mode only when the person asks for it by name, and still changes it then", async () => {
    const fx = simple();
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "appearance.advanced" }, fx.turn)).body.text)) as { help: string };
    expect(got.help).toContain("only when the person asks for Simple or Advanced mode by name, never to reach another setting");
    expect((await fx.set("appearance.advanced", "true")).status).toBe(200);
    expect(fx.windowValues.get("appearance.advanced")).toBe(true);
  });

  it.each([
    ["appearance.showThreads", "true"], ["appearance.toolsLayout", "toolbar"], ["appearance.pinnedCircles", "true"],
    ["appearance.pinnedPages", JSON.stringify([{ name: "Docs", url: "https://example.com" }])],
  ])("refuses %s, which Simple does not show, rather than claim a change nobody sees", async (id, value) => {
    const fx = simple();
    const refused = await fx.set(id, value);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/shows only in Advanced mode and this app is on Simple, so nothing changed\. Don't switch modes for it.*the switch at the bottom of Settings, then ask again\.$/);
    expect(fx.windowValues.has(id)).toBe(false);
    expect(fx.windowValues.get("appearance.advanced")).toBe(false);
    expect(fx.cards()).toEqual([]);
    fx.windowValues.set("appearance.advanced", true);
    expect((await fx.set(id, value)).status).toBe(200);
  });

  it("pins pages in Simple while the window frame's bar shows them", async () => {
    const fx = simple();
    fx.windowValues.set("appearance.windowFrame", true);
    expect((await fx.set("appearance.pinnedPages", JSON.stringify([{ name: "Docs", url: "https://example.com" }]))).status).toBe(200);
    expect(fx.windowValues.get("appearance.advanced")).toBe(false);
  });
});

describe("a provider address whose key is saved", () => {
  const withSavedKey = () => {
    const fx = fixture();
    fx.cfg.anthropic = { ...(fx.cfg.anthropic as object), key: "sk-ant-saved" } as AppConfig["anthropic"];
    return fx;
  };

  it("is the person's to change, because it decides where their saved key is sent", async () => {
    const fx = withSavedKey();
    const before = JSON.stringify(fx.saved);

    const refused = await fx.set("providers.anthropic.url", "https://elsewhere.example/v1");

    expect(refused).toMatchObject({ status: 409 });
    expect(String(refused.body.error)).toContain("only by the person");
    expect(JSON.stringify(fx.saved)).toBe(before);
  });

  it("can still be cleared while the key is saved, since clearing sends the key nowhere new", async () => {
    const fx = withSavedKey();

    const cleared = await fx.set("providers.anthropic.url", "");

    expect(cleared.status).toBe(200);
    expect(fx.saved).toEqual([{ anthropic: { key: "sk-ant-saved", url: "" } }]);
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

  it("reads, updates, and clears voice.baseUrl without re-sending saved tts keys", async () => {
    const fx = fixture({
      tts: { provider: "elevenlabs", key: "el-secret", fishKey: "fish-secret", geminiKey: "gem-secret", baseUrl: "http://127.0.0.1:4123" },
    });
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "voice.baseUrl" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "safe", value: "http://127.0.0.1:4123" });
    expect((await fx.set("voice.baseUrl", "http://127.0.0.1:5000")).status).toBe(200);
    expect(fx.cards()[0]!.card.subtitle).toBe("http://127.0.0.1:4123 → http://127.0.0.1:5000");
    expect((await fx.set("voice.baseUrl", "")).status).toBe(200);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved).toEqual([
      { tts: { baseUrl: "http://127.0.0.1:5000" } },
      { tts: { baseUrl: "" } },
      { tts: { baseUrl: "http://127.0.0.1:5000" } },
    ]);
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

  it("picks a custom decision endpoint with Undo, but never sets its address", async () => {
    const { set, saved } = fixture();
    expect((await set("ai.routing", JSON.stringify({ provider: "custom", customModel: "m-1", customApi: "decisions" }))).status).toBe(200);
    expect(saved).toEqual([{ decider: { provider: "custom", customModel: "m-1", customApi: "decisions" } }]);
    expect((await set("ai.routing", JSON.stringify({ customBaseUrl: "https://elsewhere.example.com" }))).status).toBe(400);
    expect(saved).toHaveLength(1);
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

  it("never keeps a bot on this computer from a routine or other automation, the owner's own included", async () => {
    const fx = fixture({ automated: true });
    const refused = await fx.set("bots.settings", JSON.stringify({ botId: "kiwi", computer: "local" }));
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toContain("A routine or automation can't keep a bot on this computer. Nothing changed");
    expect(String(refused.body.error)).toContain("This computer under “Where Kiwi works” in Bot's screen");
    expect(fx.botPatches).toEqual([]);
    expect(fx.cards()).toEqual([]);
    // Other settings, and another place, still change from an automation as before.
    expect((await fx.set("bots.settings", JSON.stringify({ botId: "kiwi", computer: "vm" }))).status).toBe(200);
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { computer: "vm" } }]);
  });

  it("turns one bot's tool groups off and on by name, keeps the rest as they were, and Undo puts the list back", async () => {
    const fx = fixture();
    (fx.bots.find((bot) => bot.id === "kiwi") as { toolsOff?: string[] }).toolsOff = ["images"];
    await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["pages", "meetings"] }));
    expect(fx.cards()[0]!.card.subtitle).toBe("Kiwi: turn off Pages and apps, Meetings");
    await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOn: ["images"] }));
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages", "images"] } },
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages"] } },
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages", "images"] } },
    ]);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["browser"] }))).status).toBe(400);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["data"], turnOn: ["data"] }))).status).toBe(400);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi" }))).status).toBe(400);
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

describe("bulk bot settings (botIds)", () => {
  it("applies one change across more than WRITE_BUDGET bots as one write and one Undo restoring each bot's prior state", async () => {
    const fx = fixture();
    (fx.bots[0] as { browser?: boolean }).browser = true;
    (fx.bots[1] as { browser?: boolean }).browser = false;
    for (let i = 3; i <= 12; i += 1) {
      fx.bots.push({
        id: `bot-${i}`, name: `Bot ${i}`, color: "green", threadId: `t-${i}`, approvalMode: "ask",
        browser: i % 2 === 1, modelSelection: { instanceId: "claude", model: "sonnet" },
      } as unknown as BotRecord);
    }
    const result = await fx.set("bots.settings", JSON.stringify({ botIds: "all", browser: true }));
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("Built-in browser on for 12 bots");
    expect(fx.botPatches).toHaveLength(12);
    expect(fx.botPatches.every((patch) => !("botIds" in patch.body) && patch.body.browser === true)).toBe(true);
    expect(fx.cards()).toHaveLength(1);
    expect(fx.cards()[0]!.card).toMatchObject({
      autoApplied: true, answered: "allow", options: [], subtitle: "Built-in browser on for 12 bots",
      appSettingRequest: { settingId: "bots.settings", tier: "safe", after: "Built-in browser on for 12 bots" },
    });
    // Still counts as only 1 write against WRITE_BUDGET (10).
    for (let i = 1; i < WRITE_BUDGET; i += 1) {
      expect((await fx.set("rooms.turnTimeoutMinutes", 10 + i)).status).toBe(200);
    }
    expect((await fx.set("rooms.turnTimeoutMinutes", 55)).status).toBe(429);

    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(fx.cards()[0]!.card.requestId) })).toEqual({ claimed: true, state: "undone" });
    expect(fx.bots.every((bot, index) => (bot as { browser?: boolean }).browser === (index % 2 === 0))).toBe(true);
  });

  it("supports explicit botIds lists across approvalModes, color, model, archived and tools with single Undo", async () => {
    const fx = fixture();
    fx.bots.push({ id: "plum", name: "Plum", color: "coral", threadId: "t-plum", approvalMode: "edits", modelSelection: { instanceId: "claude", model: "haiku", effort: "high" }, toolsOff: ["email"] } as unknown as BotRecord);
    (fx.bots[0] as { toolsOff?: string[] }).toolsOff = ["images"];

    expect((await fx.set("bots.color", JSON.stringify({ botIds: ["kiwi", "clive"], color: "teal" }))).status).toBe(200);
    expect(fx.cards().at(-1)!.card.subtitle).toBe("Make 2 bots (Kiwi, Clive) teal");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.bots.slice(0, 2).map((bot) => bot.color)).toEqual(["green", "blue"]);

    expect((await fx.set("bots.approvalModes", JSON.stringify({ botIds: ["kiwi", "clive"], mode: "edits" }))).status).toBe(200);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.bots.slice(0, 2).map((bot) => bot.approvalMode)).toEqual(["full", "ask"]);

    expect((await fx.set("bots.model", JSON.stringify({ botIds: "all", instanceId: "claude", model: "opus", effort: "low" }))).status).toBe(200);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.bots.map((bot) => bot.modelSelection)).toEqual([
      { instanceId: "claude", model: "opus" },
      { instanceId: "claude", model: "sonnet" },
      { instanceId: "claude", model: "haiku", effort: "high" },
    ]);

    expect((await fx.set("bots.tools", JSON.stringify({ botIds: ["kiwi", "plum"], turnOff: ["pages"] }))).status).toBe(200);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.bots[0]!.toolsOff).toEqual(["images"]);
    expect(fx.bots[2]!.toolsOff).toEqual(["email"]);

    expect((await fx.set("bots.archived", JSON.stringify({ botIds: ["clive", "plum"], archived: true }))).status).toBe(200);
    expect(fx.bots.map((bot) => Boolean(bot.hidden))).toEqual([false, true, true]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.bots.map((bot) => Boolean(bot.hidden))).toEqual([false, false, false]);
  });

  it("enforces schema bounds, keeps bots.name single-bot, and retains key-leak and automation guards", async () => {
    const fx = fixture();
    for (const [id, payload] of [
      ["bots.color", { botId: "kiwi", botIds: ["clive"], color: "teal" }],
      ["bots.color", { color: "teal" }],
      ["bots.color", { botIds: [], color: "teal" }],
      ["bots.settings", { botIds: ["kiwi", "clive"] }],
      ["bots.name", { botIds: ["kiwi", "clive"], name: "Twin" }],
    ] as const) {
      expect((await fx.set(id, JSON.stringify(payload))).status, `${id}:${JSON.stringify(payload)}`).toBe(400);
    }
    const leak = await fx.set("bots.settings", JSON.stringify({ botIds: "all", apiKey: OPENAI_KEY }));
    expect(leak.status).toBe(400);
    expect(leak.body.error).toContain("Never put a key or token in the value");

    const autoFx = fixture({ automated: true });
    expect((await autoFx.set("bots.settings", JSON.stringify({ botIds: "all", computer: "local" }))).status).toBe(403);
    expect([fx.cards(), fx.botPatches, autoFx.cards(), autoFx.botPatches]).toEqual([[], [], [], []]);
  });

  it("refuses unknown explicit botIds, empty all-targets, or total effect refusals without spending budget", async () => {
    const fx = fixture();
    expect(await fx.set("bots.settings", JSON.stringify({ botIds: ["kiwi", "ghost"], browser: false }))).toMatchObject({
      status: 409,
      body: { error: "No bot has the id ghost. Use list_bots for the ids." },
    });
    expect(await fx.set("bots.model", JSON.stringify({ botIds: "all", instanceId: "nowhere", model: "x" }))).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining("No engine has the id nowhere") },
    });
    fx.bots[0]!.approvalMode = "custom";
    fx.bots[1]!.approvalMode = "custom";
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botIds: "all", mode: "ask" }))).status).toBe(409);

    const emptyFx = fixture({ emptyRegistryBots: true });
    expect((await emptyFx.set("bots.color", JSON.stringify({ botIds: "all", color: "coral" }))).status).toBe(409);
    expect(fx.cards()).toEqual([]);
    expect(fx.botPatches).toEqual([]);
    expect([emptyFx.cards(), emptyFx.botPatches]).toEqual([[], []]);
    for (let i = 0; i < WRITE_BUDGET; i += 1) {
      expect((await fx.set("rooms.turnTimeoutMinutes", 10 + i)).status).toBe(200);
    }
  });

  it("skips per-bot effect and patchBot refusals without blocking other bots, naming only changed bots on card and Undo", async () => {
    const fx = fixture();
    (fx.bots[0] as { defaultBot?: unknown }).defaultBot = { createdAt: 1 };
    fx.bots.push({ id: "plum", name: "Plum", color: "coral", threadId: "t-plum", approvalMode: "ask", modelSelection: { instanceId: "claude", model: "sonnet" } } as unknown as BotRecord);
    const archived = await fx.set("bots.archived", JSON.stringify({ botIds: "all", archived: true }));
    expect(archived.status).toBe(200);
    expect(archived.body.text).toContain("Kiwi is this place's own bot and is never archived");
    expect(fx.cards()).toHaveLength(1);
    expect(fx.cards()[0]!.card.subtitle).toBe("Archive 2 bots (Clive, Plum): they leave the sidebar and keep their chats");
    expect(fx.botPatches.map((p) => p.botId)).toEqual(["clive", "plum"]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches.slice(2).map((p) => p.botId)).toEqual(["clive", "plum"]);

    const customFx = fixture({ patchRefusalFor: (botId) => (botId === "clive" ? "Clive is currently busy." : null) });
    const color = await customFx.set("bots.color", JSON.stringify({ botIds: ["kiwi", "clive"], color: "coral" }));
    expect(color.status).toBe(200);
    expect(color.body.text).toContain("Done: Make Kiwi coral.");
    expect(color.body.text).toContain("Clive is currently busy.");
    expect(customFx.cards()).toHaveLength(1);
    expect(customFx.cards()[0]!.card.subtitle).toBe("Make Kiwi coral");
    expect(customFx.botPatches).toEqual([{ botId: "kiwi", body: { color: "coral" } }]);
    expect(await customFx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(customFx.botPatches).toEqual([{ botId: "kiwi", body: { color: "coral" } }, { botId: "kiwi", body: { color: "green" } }]);

    const allFailed = fixture({ patchRefusal: "busy" });
    expect(await allFailed.set("bots.color", JSON.stringify({ botIds: ["kiwi", "clive"], color: "coral" }))).toMatchObject({ status: 409 });
    expect(allFailed.cards()).toEqual([]);
  });

  it("deduplicates repeated botIds and detects stale state on Undo after a bulk edit", async () => {
    const fx = fixture();
    const dedup = await fx.set("bots.color", JSON.stringify({ botIds: ["kiwi", "kiwi"], color: "coral" }));
    expect(dedup.status).toBe(200);
    expect(fx.cards()[0]!.card.subtitle).toBe("Make Kiwi coral");
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { color: "coral" } }]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { color: "coral" } }, { botId: "kiwi", body: { color: "green" } }]);

    expect((await fx.set("bots.color", JSON.stringify({ botIds: "all", color: "teal" }))).status).toBe(200);
    fx.bots[1]!.color = "coral";
    expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
  });

  it("preserves chiefOfStaff demotion notice in bulk archive card after in-place patchBot mutation", async () => {
    const fx = fixture();
    (fx.bots[1] as { chiefOfStaff?: boolean }).chiefOfStaff = true;
    fx.bots.push({ id: "plum", name: "Plum", color: "coral", threadId: "t-plum", approvalMode: "ask", modelSelection: { instanceId: "claude", model: "sonnet" } } as unknown as BotRecord);
    const archived = await fx.set("bots.archived", JSON.stringify({ botIds: ["clive", "plum"], archived: true }));
    expect(archived.status).toBe(200);
    expect(fx.cards()[0]!.card.subtitle).toBe("Archive 2 bots (Clive, Plum): they leave the sidebar and keep their chats; Clive stops being Chief of Staff");
  });

  it("releases the write reservation when all batch patchBot calls refuse", async () => {
    const fx = fixture({ patchRefusal: "busy" });
    for (let i = 0; i < WRITE_BUDGET + 2; i += 1) {
      expect((await fx.set("bots.color", JSON.stringify({ botIds: "all", color: "coral" }))).status).toBe(409);
    }
    for (let i = 0; i < WRITE_BUDGET; i += 1) {
      expect((await fx.set("rooms.turnTimeoutMinutes", 10 + i)).status).toBe(200);
    }
    expect((await fx.set("rooms.turnTimeoutMinutes", 99)).status).toBe(429);
  });

  it("detects stale targeted fields in bots.settings Undo without blocking when unrelated fields change", async () => {
    const fx = fixture();
    fx.bots[0]!.title = "Old A";
    fx.bots[1]!.title = "Old B";
    expect((await fx.set("bots.settings", JSON.stringify({ botIds: "all", title: "Batch" }))).status).toBe(200);
    // Changing an unrelated field keeps Undo valid.
    fx.bots[0]!.color = "teal";
    // Modifying one targeted field must trigger UNDO_STALE instead of clobbering "New B".
    fx.bots[1]!.title = "New B";
    expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
    expect(fx.bots[0]!.title).toBe("Batch");
    expect(fx.bots[1]!.title).toBe("New B");

    // Restoring targeted field back to applied state lets Undo succeed cleanly even with the unrelated color edit.
    fx.bots[1]!.title = "Batch";
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.bots[0]!.title).toBe("Old A");
    expect(fx.bots[1]!.title).toBe("Old B");
  });

  it("keeps partially completed Undo retryable while still detecting independent edits before retry", async () => {
    let cliveBusy = false;
    const fx = fixture({ patchRefusalFor: (botId) => (cliveBusy && botId === "clive" ? "Clive is busy" : null) });
    fx.bots[0]!.title = "Old A";
    fx.bots[1]!.title = "Old B";
    expect((await fx.set("bots.settings", JSON.stringify({ botIds: "all", title: "Batch" }))).status).toBe(200);
    expect(fx.botPatches).toEqual([
      { botId: "kiwi", body: { title: "Batch" } },
      { botId: "clive", body: { title: "Batch" } },
    ]);

    cliveBusy = true;
    expect(await fx.undo()).toEqual({ claimed: true, state: "invalid", error: "Clive is busy", status: 409 });
    // Kiwi reverted; Clive remains at "Batch" with only Clive queued for retry.
    expect(fx.bots.map((bot) => bot.title)).toEqual(["Old A", "Batch"]);

    // Independent external edit on Clive before retry still triggers UNDO_STALE.
    cliveBusy = false;
    fx.bots[1]!.title = "External B";
    expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });

    // Once Clive matches the applied state again, retry finishes only Clive without re-patching Kiwi.
    fx.bots[1]!.title = "Batch";
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.bots.map((bot) => bot.title)).toEqual(["Old A", "Old B"]);
    expect(fx.botPatches).toEqual([
      { botId: "kiwi", body: { title: "Batch" } },
      { botId: "clive", body: { title: "Batch" } },
      { botId: "kiwi", body: { title: "Old A" } },
      { botId: "clive", body: { title: "Old B" } },
    ]);

    // Also verify read()-based bulk Undo (bots.color) refreshes cleanly on partial failure and finishes on retry.
    const colorFx = fixture({ patchRefusalFor: (botId) => (cliveBusy && botId === "clive" ? "Clive is busy" : null) });
    expect((await colorFx.set("bots.color", JSON.stringify({ botIds: "all", color: "coral" }))).status).toBe(200);
    cliveBusy = true;
    expect(await colorFx.undo()).toEqual({ claimed: true, state: "invalid", error: "Clive is busy", status: 409 });
    cliveBusy = false;
    expect(await colorFx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(colorFx.bots.map((bot) => bot.color)).toEqual(["green", "blue"]);
    expect(colorFx.botPatches.filter((patch) => patch.body.color === "green")).toHaveLength(1);
  });
});
