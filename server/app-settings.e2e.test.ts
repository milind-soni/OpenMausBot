// A real server and the real injected agents proxy; only the provider's planning is scripted (room-handoff-agent).
// The bot is on Full access, so every guard below is one Full access must not skip.
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

  // The owner's paired phone: an admin session, the "paired Full-access device" a Change answer may come from.
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

it("a Full-access owner turn changing a provider address waits on a Change/Cancel card: Cancel changes nothing, Change from the owner's device applies it", async () => {
  const waitingCard = async () => {
    let waiting: any;
    await expect.poll(async () => (waiting = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "providers.xai.url" && !one.card.answered)) !== undefined, { timeout: 20_000, message: "an unanswered Change xAI address? card" }).toBe(true);
    return waiting.card;
  };
  await start("CONFIRM-CANCEL", [step({ action: "set", id: "providers.xai.url", value: XAI_URL }, true)], 60_000);
  const first = await waitingCard();
  expect(first).toMatchObject({ title: "Change xAI address?", options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: XAI_URL } });
  expect(first.autoApplied).toBeUndefined();
  expect(config().xai?.url, "Full access did not skip the card").toBeUndefined();
  // Security: while the bot waits a loopback caller could be its own shell, so a local Allow is refused.
  expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.requestId, behavior: "allow" }, 403)).error).toMatch(/^Approve settings changes from the desktop app/);
  expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.requestId, behavior: "deny" })).toMatchObject({ ok: true, outcome: "rejected" });
  expect(results(await finished("CONFIRM-CANCEL"))).toEqual([expect.objectContaining({ isError: true, text: "The user cancelled the change to xAI address. Do not retry it; ask the user what they would like instead." })]);
  expect(config().xai?.url).toBeUndefined();

  await start("CONFIRM-CHANGE", [step({ action: "set", id: "providers.xai.url", value: XAI_URL })], 60_000);
  const second = await waitingCard();
  expect(config().xai?.url).toBeUndefined();
  expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: second.requestId, behavior: "allow" }, 200, ownerDevice)).toMatchObject({ ok: true, outcome: "allowed-once" });
  expect(results(await finished("CONFIRM-CHANGE"))).toEqual([expect.objectContaining({ isError: false, text: `Changed xAI address from not set to ${XAI_URL}.` })]);
  expect(config().xai.url).toBe(XAI_URL);
  const decisions = (await api("GET", "/api/decisions")).decisions.filter((row: any) => row.tool === "app_settings" && row.summary.startsWith("providers.xai.url"));
  expect(decisions.map((row: any) => row.decision).sort()).toEqual(["card-shown", "card-shown", "user-approved", "user-denied"]);
}, 90_000);

it("Stop settles a waiting Change card at once: the card shows as unavailable, a later Change applies nothing, and the next turn can ask again", async () => {
  await start("CONFIRM-STOP", [step({ action: "set", id: "providers.groq.url", value: XAI_URL }, true)], 60_000);
  let waiting: any;
  await expect.poll(async () => (waiting = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "providers.groq.url" && !one.card.answered)) !== undefined, { timeout: 20_000 }).toBe(true);
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  await expect.poll(async () => (await settingCards(bot.threadId)).find((one) => one.id === waiting.id)?.card, { timeout: 10_000 }).toMatchObject({ answered: "unavailable", dismissed: true });
  expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: waiting.card.requestId, behavior: "allow" }, 200, ownerDevice)).toMatchObject({ outcome: "unavailable" });
  expect(config().groq?.url).toBeUndefined();
  await idle();

  // The stopped card no longer holds the bot's one open slot, so the next turn's change gets its own card.
  await start("CONFIRM-AFTER-STOP", [step({ action: "set", id: "providers.groq.url", value: XAI_URL }, true)], 60_000);
  let next: any;
  await expect.poll(async () => (next = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "providers.groq.url" && !one.card.answered)) !== undefined, { timeout: 20_000 }).toBe(true);
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: next.card.requestId, behavior: "deny" });
  expect(results(await finished("CONFIRM-AFTER-STOP"))[0]?.text).toMatch(/^The user cancelled the change to Groq address\./);
}, 90_000);

it("a Full-access bot adds and removes an AI engine only through Change/Cancel cards, with a saved key it never sees", async () => {
  const routerKey = "sk-or-v1-e2e-0123456789";
  await api("PUT", "/api/config", { openrouter: { key: routerKey } }, 200, ownerDevice);
  const engines = () => Object.entries(config().instances ?? {}).filter(([id]) => id.startsWith("openai-compat-")) as Array<[string, any]>;
  const engineCard = async () => {
    let waiting: any;
    await expect.poll(async () => (waiting = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "engines" && !one.card.answered)) !== undefined, { timeout: 20_000, message: "an unanswered Change AI engines? card" }).toBe(true);
    return waiting.card;
  };
  const answer = (card: any, behavior: "allow" | "deny") => api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior }, 200, ownerDevice);

  await start("ENGINE-CANCEL", [step({ action: "set", id: "engines", value: JSON.stringify({ kind: "ollama", url: "http://127.0.0.1:9" }) }, true)], 60_000);
  const cancelled = await engineCard();
  expect(cancelled).toMatchObject({ title: "Change AI engines?", subtitle: "Add the engine \"Ollama\" (Ollama on http://127.0.0.1:9)", options: ["Change", "Cancel"] });
  await answer(cancelled, "deny");
  expect(results(await finished("ENGINE-CANCEL"))[0]?.text).toMatch(/^The user cancelled the change to AI engines\./);
  expect(engines()).toEqual([]);

  const gateway = { kind: "openai-compat", name: "Gateway", url: "https://gw.example.test/v1", keyFrom: "openrouterApiKey" };
  await start("ENGINE-ADD", [
    step({ action: "set", id: "engines", value: JSON.stringify({ ...gateway, keyFrom: undefined, key: routerKey }) }, true),
    step({ action: "set", id: "engines", value: JSON.stringify(gateway) }),
  ], 60_000);
  const adding = await engineCard();
  expect(adding.subtitle).toBe("Add the engine \"Gateway\" (OpenAI-compatible) at https://gw.example.test/v1, sending it your saved OpenRouter API key");
  expect(engines(), "nothing is added while the card waits").toEqual([]);
  await answer(adding, "allow");
  const added = await finished("ENGINE-ADD");
  const [inline, applied] = results(added);
  expect(inline).toMatchObject({ isError: true, text: expect.stringContaining("Never put a key or token in the value") });
  expect(applied).toMatchObject({ isError: false, text: expect.stringMatching(/^Done: Add the engine "Gateway"/) });
  const [[engineId, engine]] = engines();
  expect(engine).toMatchObject({ driver: "openai-compat", displayName: "Gateway", config: { url: "https://gw.example.test/v1", key: routerKey } });
  expect((await api("GET", "/api/instances")).instances.map((instance: any) => instance.instanceId)).toContain(engineId);
  const everything = JSON.stringify({ results: results(added).map((result: any) => result.text), messages: await messages(bot.threadId), decisions: (await api("GET", "/api/decisions")).decisions });
  expect(everything).not.toContain(routerKey);

  await start("ENGINE-REMOVE", [
    step({ action: "get", id: "engines" }),
    step({ action: "set", id: "engines", value: JSON.stringify({ kind: "remove", instanceId: engineId }) }),
  ], 60_000);
  const removing = await engineCard();
  expect(removing.subtitle).toBe(`Remove the engine "Gateway" (OpenAI-compatible server, https://gw.example.test/v1)`);
  expect(engines()).toHaveLength(1);
  await answer(removing, "allow");
  const [listed, removed] = results(await finished("ENGINE-REMOVE"));
  expect(JSON.parse(listed.text).value).toContain(`${engineId}: Gateway at https://gw.example.test/v1`);
  expect(listed.text).not.toContain(routerKey);
  expect(removed.isError).toBe(false);
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
    text: "Vault and logins is changed only by the owner, in Settings → Vault. Tell the user where to find it; do not try another way." })]);
}, 60_000);

/** The unanswered card for `settingId`, once it shows. */
const waitingCard = async (settingId: string) => {
  let waiting: any;
  await expect.poll(async () => (waiting = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === settingId && !one.card.answered)) !== undefined,
    { timeout: 20_000, message: `an unanswered ${settingId} card` }).toBe(true);
  return waiting.card;
};
const botNow = async () => (await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id);

it("a bot's own name and a server setting change through the real routes only on the owner's Change", async () => {
  await start("BOT-AND-CONFIG", [
    step({ action: "set", id: "bots.name", value: JSON.stringify({ botId: bot.id, name: "Setter Two" }) }),
    step({ action: "set", id: "profile.name", value: "Ada" }),
  ], 60_000);
  const rename = await waitingCard("bots.name");
  expect(rename).toMatchObject({ title: "Change Bot name?", subtitle: "Rename Setter to \"Setter Two\"", options: ["Change", "Cancel"] });
  expect((await botNow()).name, "nothing changes while the card waits").toBe("Setter");
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: rename.requestId, behavior: "allow" }, 200, ownerDevice);
  const profile = await waitingCard("profile.name");
  expect(profile.subtitle).toBe("not set → Ada");
  expect(config().profile?.name).toBeUndefined();
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: profile.requestId, behavior: "allow" }, 200, ownerDevice);
  const [renamed, named] = results(await finished("BOT-AND-CONFIG"));
  expect(renamed).toMatchObject({ isError: false, text: expect.stringMatching(/^Done: Rename Setter to "Setter Two"\./) });
  expect(named).toMatchObject({ isError: false, text: "Changed Your name from not set to Ada." });
  expect((await botNow()).name).toBe("Setter Two");
  expect(config().profile.name).toBe("Ada");
}, 90_000);

it("a Full-access bot's own approval mode changes only on a card: Cancel keeps it, Change from the owner's device applies it to every thread", async () => {
  const change = step({ action: "set", id: "bots.approvalModes", value: JSON.stringify({ botId: bot.id, mode: "ask" }) });
  await start("APPROVAL-CANCEL", [{ ...change, expectError: true }], 60_000);
  const first = await waitingCard("bots.approvalModes");
  expect(first).toMatchObject({ title: "Change Approval mode?", options: ["Change", "Cancel"] });
  expect(first.subtitle).toMatch(/^Make Setter( Two)? ask you before each command or file change \(Ask for approval\)$/);
  // Security: a local Allow while the bot works could be the bot's own shell.
  expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.requestId, behavior: "allow" }, 403)).error).toMatch(/^Approve settings changes from the desktop app/);
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.requestId, behavior: "deny" }, 200, ownerDevice);
  expect(results(await finished("APPROVAL-CANCEL"))[0]?.text).toMatch(/^The user cancelled the change to Approval mode\./);
  expect((await botNow()).approvalMode).toBe("full");

  await start("APPROVAL-CHANGE", [change], 60_000);
  const second = await waitingCard("bots.approvalModes");
  expect((await botNow()).approvalMode, "Full access did not skip the card").toBe("full");
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: second.requestId, behavior: "allow" }, 200, ownerDevice);
  expect(results(await finished("APPROVAL-CHANGE"))[0]).toMatchObject({ isError: false, text: expect.stringMatching(/^Done: Make Setter/) });
  const now = await botNow();
  expect(now.approvalMode).toBe("ask");
  expect(now.tasks.every((task: any) => (task.approvalMode ?? "ask") === "ask")).toBe(true);
  // Fixture cleanup: the owner's device puts the bot back on Full access for the tests after this one.
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true }, 200, ownerDevice);
}, 120_000);

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
