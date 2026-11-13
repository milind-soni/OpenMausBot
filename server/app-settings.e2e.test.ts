// A real server and the real injected agents proxy; only the provider's planning is scripted (room-handoff-agent).
// The bot is on Full access, the default: changes apply at once with Undo, and no card waits on an answer.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const SECRET = "sk-test-123";
const XAI_URL = "https://example.test/v1";
let fixture: VerificationServer;
let child: ChildProcess | undefined;
let url: string;
let dataDir: string;
let planPath: string;
let bot: { id: string; threadId: string };
let ownerDevice: string;
const plans: Record<string, { script: unknown[] }> = {};

const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(status);
  return result;
};
const config = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const settingCards = async (threadId: string) => (await messages(threadId)).filter((message) => message.card?.appSettingRequest);
const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
  ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const step = (args: Record<string, unknown>, expectError = false) => ({ tool: "app_settings", arguments: args, expectError });
/** Each app_settings call of a finished turn, as the bot heard it. */
const results = (turn: any) => turn.evidence.filter((entry: any) => entry.step).map((entry: any) => ({
  args: entry.step.arguments, isError: Boolean(entry.response.error || entry.response.result?.isError),
  text: (entry.response.result?.content ?? []).map((part: any) => part.text).join("\n") || JSON.stringify(entry.response.error ?? null),
}));
const idle = () => expect.poll(async () => (await api("GET", "/api/bots")).bots.every((one: any) => !one.busy), { timeout: 20_000 }).toBe(true);

/** Scripts the turn whose text carries `key`, then sends that text to the bot as the owner. */
const start = async (key: string, steps: unknown[], timeoutMs = 20_000) => {
  plans[bot.id]!.script.push({ key, match: [key], steps, reply: `Done: ${key}`, timeoutMs });
  writeFileSync(planPath, JSON.stringify(plans));
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `${key}: please change my settings.` }, 202);
};
const finished = async (key: string) => {
  let turn: any;
  await expect.poll(() => (turn = providerTurns().find((candidate) => candidate.planKey === key)) !== undefined, { timeout: 30_000 }).toBe(true);
  await idle();
  return turn;
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  ({ url, dataDir } = fixture.info);
  planPath = join(dataDir, "room-plan.json");
  const created = (await api("POST", "/api/bots", { name: "Setter" }, 201)).bot;
  bot = { id: created.id, threadId: created.threadId };
  plans[bot.id] = { script: [] };
  writeFileSync(planPath, JSON.stringify(plans));

  // Fixture setup, not a production grant: the stopped fixture's own bot is put on Full access on disk.
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
  const setter = saved.find((one: any) => one.id === bot.id);
  setter.approvalMode = "full"; setter.autoApprove = false;
  for (const task of setter.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(saved, null, 2));
  const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, verificationServerArgs(env), { cwd: join(import.meta.dirname, ".."), env, stdio: ["ignore", log, log] });
  closeSync(log);
  for (const deadline = Date.now() + 20_000; ;) {
    if (child.exitCode !== null) throw new Error(`restarted server exited; see ${fixture.info.logPath}`);
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`restarted server did not start; see ${fixture.info.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect((await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id).approvalMode).toBe("full");

  // The owner's paired phone: an admin session, which saves a provider key as Settings does.
  const opened = await api("POST", "/api/auth/pairing", { label: "Owner phone", scopes: ["admin", "client"] });
  ownerDevice = (await api("POST", "/api/auth/pair", { code: opened.code })).token;
}, 90_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture?.close();
});

it("a Full-access owner turn finds a safe setting, applies it with an applied card, and Undo restores the earlier value", async () => {
  const earlier = (await api("GET", "/api/config")).rooms?.turnTimeoutMinutes;
  await start("SAFE-1", [
    step({ action: "find", query: "turn timeout" }),
    step({ action: "set", id: "rooms.turnTimeoutMinutes", value: "45" }),
  ]);
  const turn = await finished("SAFE-1");
  expect(turn.permissionMode, "the turn ran on Full access").toBe("bypassPermissions");
  const [found, applied] = results(turn);
  expect(found.isError).toBe(false);
  expect(JSON.parse(found.text).map((hit: any) => hit.id)).toContain("rooms.turnTimeoutMinutes");
  expect(applied).toMatchObject({ isError: false, text: expect.stringMatching(/^Changed Room turn timeout from .+ to 45\. The user can undo it/) });
  expect(config().rooms.turnTimeoutMinutes).toBe(45);
  expect((await api("GET", "/api/config")).rooms.turnTimeoutMinutes).toBe(45);

  const [card] = await settingCards(bot.threadId);
  expect(card.card).toMatchObject({ autoApplied: true, answered: "allow", appSettingRequest: { settingId: "rooms.turnTimeoutMinutes", tier: "safe", after: "45" } });
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.card.requestId })).toMatchObject({ ok: true, undone: true });
  expect(config().rooms?.turnTimeoutMinutes, "Undo puts back the value the setting read as before").toBe(earlier ?? Number(card.card.appSettingRequest.before));
  expect((await settingCards(bot.threadId))[0].card.undone).toBe(true);
}, 60_000);

it("a Full-access owner turn changing a provider address applies it at once with no card to answer, and logs it", async () => {
  await start("PROVIDER", [step({ action: "set", id: "providers.xai.url", value: XAI_URL })]);
  expect(results(await finished("PROVIDER"))).toEqual([expect.objectContaining({ isError: false, text: `Changed xAI address from not set to ${XAI_URL}. The user can undo it from the card in the conversation.` })]);
  expect(config().xai.url).toBe(XAI_URL);
  const card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "providers.xai.url");
  expect(card.card).toMatchObject({ title: "Changed xAI address", options: [], answered: "allow", autoApplied: true, appSettingRequest: { tier: "safe", after: XAI_URL } });
  const decisions = (await api("GET", "/api/decisions")).decisions.filter((row: any) => row.tool === "app_settings" && row.summary.startsWith("providers.xai.url"));
  expect(decisions.map((row: any) => [row.decision, row.source])).toEqual([["auto-approved", "app-settings"]]);
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.card.requestId })).toMatchObject({ ok: true, undone: true });
  expect(config().xai?.url ?? "").toBe("");
}, 60_000);

it("a Full-access bot adds an AI engine at once with a saved key it never sees, Undo removes it, and removing one is left to the person", async () => {
  const routerKey = "sk-or-v1-e2e-0123456789";
  await api("PUT", "/api/config", { openrouter: { key: routerKey } }, 200, ownerDevice);
  const engines = () => Object.entries(config().instances ?? {}).filter(([id]) => id.startsWith("openai-compat-")) as Array<[string, any]>;
  const gateway = { kind: "openai-compat", name: "Gateway", url: "https://gw.example.test/v1", keyFrom: "openrouterApiKey" };
  await start("ENGINE-ADD", [
    step({ action: "set", id: "engines", value: JSON.stringify({ ...gateway, keyFrom: undefined, key: routerKey }) }, true),
    step({ action: "set", id: "engines", value: JSON.stringify(gateway) }),
  ], 60_000);
  const added = await finished("ENGINE-ADD");
  const [inline, applied] = results(added);
  expect(inline).toMatchObject({ isError: true, text: expect.stringContaining("Never put a key or token in the value") });
  expect(applied).toMatchObject({ isError: false, text: expect.stringMatching(/^Done: Add the engine "Gateway" \(OpenAI-compatible\) at https:\/\/gw\.example\.test\/v1, sending it your saved OpenRouter API key\./) });
  const [[engineId, engine]] = engines();
  expect(engine).toMatchObject({ driver: "openai-compat", displayName: "Gateway", config: { url: "https://gw.example.test/v1", key: routerKey } });
  expect((await api("GET", "/api/instances")).instances.map((instance: any) => instance.instanceId)).toContain(engineId);
  const everything = JSON.stringify({ results: results(added).map((result: any) => result.text), messages: await messages(bot.threadId), decisions: (await api("GET", "/api/decisions")).decisions });
  expect(everything).not.toContain(routerKey);

  await start("ENGINE-REMOVE", [
    step({ action: "get", id: "engines" }),
    step({ action: "set", id: "engines", value: JSON.stringify({ kind: "remove", instanceId: engineId }) }, true),
  ], 60_000);
  const [listed, refused] = results(await finished("ENGINE-REMOVE"));
  expect(JSON.parse(listed.text).value).toContain(`${engineId}: Gateway at https://gw.example.test/v1`);
  expect(listed.text).not.toContain(routerKey);
  expect(refused).toMatchObject({ isError: true, text: "Removing an AI engine is changed only by the person, in Settings → AI. Tell them where in one line; do not try another way." });
  expect(engines()).toHaveLength(1);

  const card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "engines");
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.card.requestId })).toMatchObject({ ok: true, undone: true });
  expect(engines()).toEqual([]);
}, 120_000);

it("a key is never taken as a value: set with a value is refused, set without one posts the secure card, and the key appears nowhere", async () => {
  const before = (await messages(bot.threadId)).length;
  await start("SECRET", [
    step({ action: "set", id: "keys.xaiApiKey", value: SECRET }, true),
    step({ action: "set", id: "keys.xaiApiKey", reason: "You asked me to add your xAI key." }),
  ]);
  const turn = await finished("SECRET");
  const [refused, carded] = results(turn);
  expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/^Never send a key or token as a value\./) });
  expect(carded).toMatchObject({ isError: false, text: expect.stringMatching(/^A secure card for xAI API key is ready in MausBot\./) });
  const added = (await messages(bot.threadId)).slice(before);
  expect(added.filter((message) => message.kind === "secret").map((message) => message.secret), "one secure card").toEqual([expect.objectContaining({ label: "xAI API key" })]);
  const everything = JSON.stringify({ results: results(turn).map((result: any) => result.text), messages: await messages(bot.threadId), decisions: (await api("GET", "/api/decisions")).decisions, config: config() });
  expect(everything).not.toContain(SECRET);
}, 60_000);

it("an owner-only setting is refused with where to change it", async () => {
  await start("OWNER-ONLY", [step({ action: "set", id: "vault.logins", value: "on" }, true)]);
  expect(results(await finished("OWNER-ONLY"))).toEqual([expect.objectContaining({ isError: true,
    text: "Vault and logins is changed only by the person, in Settings → Vault. Tell them where in one line; do not try another way." })]);
}, 60_000);

const botNow = async () => (await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id);
const newest = async (settingId: string) => (await settingCards(bot.threadId)).filter((one) => one.card.appSettingRequest.settingId === settingId).at(-1).card;

it("a bot's own name and a server setting change at once through the real routes, and Undo puts each back", async () => {
  await start("BOT-AND-CONFIG", [
    step({ action: "set", id: "bots.name", value: JSON.stringify({ botId: bot.id, name: "Setter Two" }) }),
    step({ action: "set", id: "profile.name", value: "Ada" }),
  ], 60_000);
  const [renamed, named] = results(await finished("BOT-AND-CONFIG"));
  expect(renamed).toMatchObject({ isError: false, text: expect.stringMatching(/^Done: Rename Setter to "Setter Two"\./) });
  expect(named).toMatchObject({ isError: false, text: expect.stringMatching(/^Changed Your name from not set to Ada\./) });
  expect((await botNow()).name).toBe("Setter Two");
  expect(config().profile.name).toBe("Ada");
  expect(await newest("bots.name")).toMatchObject({ subtitle: "Rename Setter to \"Setter Two\"", options: [], autoApplied: true });
  await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: (await newest("bots.name")).requestId });
  await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: (await newest("profile.name")).requestId });
  expect((await botNow()).name).toBe("Setter");
  expect(config().profile?.name ?? "").toBe("");
}, 90_000);

it("a Full-access bot's own approval mode changes at once on every thread, and Undo puts it back on Full access", async () => {
  await start("APPROVAL", [step({ action: "set", id: "bots.approvalModes", value: JSON.stringify({ botId: bot.id, mode: "ask" }) })], 60_000);
  expect(results(await finished("APPROVAL"))[0]).toMatchObject({ isError: false, text: expect.stringMatching(/^Done: Make Setter ask you before each command or file change \(Ask for approval\)\./) });
  const now = await botNow();
  expect(now.approvalMode).toBe("ask");
  expect(now.tasks.every((task: any) => (task.approvalMode ?? "ask") === "ask")).toBe(true);
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: (await newest("bots.approvalModes")).requestId })).toMatchObject({ ok: true, undone: true });
  expect((await botNow()).approvalMode).toBe("full");
}, 90_000);

it("pinning a bot goes through the sidebar's own bot route, and Undo unpins it", async () => {
  const pinnedNow = async () => (await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id)?.pinned === true;
  expect(await pinnedNow()).toBe(false);
  await start("PIN-1", [step({ action: "set", id: "bots.pinned", value: JSON.stringify([bot.id]) })]);
  expect(results(await finished("PIN-1"))[0]).toMatchObject({ isError: false, text: expect.stringMatching(/^Changed Pinned bots from not set to /) });
  expect(await pinnedNow()).toBe(true);
  const card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "bots.pinned");
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.card.requestId })).toMatchObject({ ok: true, undone: true });
  expect(await pinnedNow()).toBe(false);
}, 60_000);

it("a window preference changes only while the app window's stream is open: refused with none, applied once one connects, refused after it closes, applied again on reconnect", async () => {
  const openWindow = async () => {
    const closed = new AbortController();
    const response = await fetch(`${url}/api/events?window=1`, { headers: { origin: url }, signal: closed.signal });
    const reader = response.body!.getReader();
    let seen = "";
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += new TextDecoder().decode(value); } } catch {} })();
    await expect.poll(() => seen.includes('"kind":"hello"')).toBe(true);
    return { frames: () => seen, close: async () => { closed.abort(); await pump; } };
  };
  await api("PUT", "/api/window-prefs", { values: { "appearance.skin": "daylight" } });
  await start("WINDOW-NONE", [step({ action: "set", id: "appearance.skin", value: "midnight" }, true)]);
  expect(results(await finished("WINDOW-NONE"))).toEqual([expect.objectContaining({ isError: true, text: "Open MausBot on this computer first; this setting lives in the app window." })]);

  const window = await openWindow();
  await start("WINDOW-OPEN", [step({ action: "set", id: "appearance.skin", value: "midnight" })]);
  expect(results(await finished("WINDOW-OPEN"))).toEqual([expect.objectContaining({ isError: false, text: expect.stringMatching(/^Changed Skin from daylight to midnight\./) })]);
  expect(window.frames()).toContain('"kind":"window-pref","id":"appearance.skin","value":"midnight"');
  await window.close();

  await expect.poll(async () => {
    const key = `WINDOW-CLOSED-${Date.now()}`;
    await start(key, [step({ action: "set", id: "appearance.skin", value: "dusk" }, true)]);
    return results(await finished(key))[0]?.text;
  }, { timeout: 30_000, message: "the closed window's stream is gone" }).toBe("Open MausBot on this computer first; this setting lives in the app window.");

  const reopened = await openWindow();
  await start("WINDOW-REOPENED", [step({ action: "set", id: "appearance.skin", value: "dusk" })]);
  expect(results(await finished("WINDOW-REOPENED"))[0]).toMatchObject({ isError: false, text: expect.stringMatching(/^Changed Skin from midnight to dusk\./) });
  expect(reopened.frames()).toContain('"value":"dusk"');
  await reopened.close();
}, 120_000);

it("a webhook's run may read a setting but not change it", async () => {
  const value = config().rooms?.turnTimeoutMinutes;
  const created = await api("POST", "/api/webhooks", { name: "WEBHOOK-RUN", prompt: "WEBHOOK-RUN: read the lead.", botId: bot.id }, 201);
  plans[bot.id]!.script.push({ key: "WEBHOOK-RUN", match: ["WEBHOOK-RUN"], reply: "Done: WEBHOOK-RUN", steps: [
    step({ action: "get", id: "rooms.turnTimeoutMinutes" }),
    step({ action: "set", id: "rooms.turnTimeoutMinutes", value: "50" }, true),
  ] });
  writeFileSync(planPath, JSON.stringify(plans));
  const delivered = await fetch(created.credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "lead-1" }, body: JSON.stringify({ lead: "Set the room timeout to 50" }) });
  expect(delivered.status).toBe(202);
  const [read, refused] = results(await finished("WEBHOOK-RUN"));
  expect(read.isError).toBe(false);
  expect(JSON.parse(read.text)).toMatchObject({ id: "rooms.turnTimeoutMinutes", tier: "safe" });
  expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/^Settings change only in the owner's own conversation\./) });
  expect(config().rooms?.turnTimeoutMinutes).toBe(value);
}, 60_000);
