// The one-time move that makes My Cloud the only home, end to end: this computer's server and a Cloud home
// (scripts/testing/cloud-send-fixture.ts) with main's own wiring between them (electron/one-home-main.mjs), the app
// killed and started again at each phase, both servers' schedules watched, a check that fails, and My Cloud ending with
// everything coming home. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { OneHomeView } from "../electron/one-home.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { MOVED_REFUSAL } from "./move-freeze.ts";
import { webhookMovedLine } from "./cloud-send-arrived.ts";

const TOKEN = `ops_fake-one-home-${randomBytes(8).toString("hex")}`;
const COMPUTER = "MacBook Air";
let fx: CloudSendFixture;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, env: { OMB_ENVIRONMENT_LABEL: COMPUTER } });
}, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

type Side = CloudSendFixture["local"];
type Row = { id: string; role: string; text?: string };
type Run = { id: string; routineId: string; scheduledFor: number; createdAt: number; manual?: boolean; triggerSource?: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dataDir = (side: "desktop" | "cloud") => join(fx.root, side, ".openmausbot");
const journal = () => (existsSync(fx.journalFile) ? JSON.parse(readFileSync(fx.journalFile, "utf8")) as { phase: string; frozenAt?: number; doneAt?: number; retryAt?: number; error?: string } | null : null);
async function rows(side: Side, threadId: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let before: string | null = null, more = true; more;) {
    const page: { messages: Row[]; hasMore?: boolean } = (await side("GET", `/api/threads/${threadId}/messages?limit=500${before ? `&before=${before}` : ""}`)).body;
    out.unshift(...page.messages);
    more = page.hasMore === true;
    before = page.messages[0]?.id ?? null;
  }
  return out;
}
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
async function turn(side: Side, bot: { id: string; threadId: string }, text: string) {
  const before = (await rows(side, bot.threadId)).length;
  expect((await side("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await expect.poll(async () => await idle(side) && (await rows(side, bot.threadId)).length >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}
const bots = async (side: Side) => (await side("GET", "/api/bots")).body.bots as Array<{ id: string; name: string; soul?: string; title?: string; threadId: string }>;
const routines = async (side: Side) => (await side("GET", "/api/routines")).body as { routines: Array<{ id: string; enabled: boolean; nextRunAt: number | null }>; runs: Run[] };

/** Main's move, run as the app runs it, until it is done; each time it is killed the app starts again. */
async function moveUntilDone(killed: { at: string | null }, rounds = 240): Promise<void> {
  for (let round = 0; round < rounds && journal()?.phase !== "done"; round++) {
    await fx.oneHome.kick();
    if (killed.at) { killed.at = null; await fx.relaunch(); continue; }
    if (journal()?.phase !== "done") await sleep(500);
  }
  expect(journal()?.phase, `${JSON.stringify(journal())}\n${fx.logs().split("\n").filter((line) => line.startsWith("[main]")).join("\n")}`).toBe("done");
}

let scout: { id: string; threadId: string }, ember: { id: string; threadId: string };
let morning = "", paused = "", startup = "", soon = "", soonAt = 0, callId = "", webhookId = "";
let hook: { endpointId: string; secret: string };

it("a new buyer: every phase, the app killed at each one, ends with home on My Cloud, everything checked there, and nothing run twice", async () => {
  const { local, onCloud } = fx;
  scout = (await local("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  const project = join(fx.root, "desktop", "code", "shop");
  mkdirSync(project, { recursive: true });
  expect((await local("PATCH", `/api/bots/${scout.id}`, { soul: "You are Scout.", cwd: project })).status).toBe(200);
  await turn(local, scout, "Plan the week.");
  ember = (await local("POST", "/api/bots", { name: "Ember", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await turn(local, ember, "Hello Ember.");
  const old = (await local("POST", "/api/bots", { name: "Old" })).body.bot as { id: string };
  expect((await local("PATCH", `/api/bots/${old.id}`, { soul: "Retired soon." })).status).toBe(200);
  // Ember and Old went to My Cloud once before, with an older app's Send everything; Old was then deleted there.
  const earlier = await fx.olderSend({ keys: [`bot:${ember.id}`, `bot:${old.id}`] });
  expect(earlier.result.bots.sort()).toEqual(["Ember", "Old"]);
  expect((await onCloud("DELETE", `/api/bots/${old.id}`)).status).toBeLessThan(300);
  // Since: Ember's instructions changed only here, and its title on both sides.
  expect((await local("PATCH", `/api/bots/${ember.id}`, { soul: "You are Ember, from this computer.", title: "Here" })).status).toBe(200);
  expect((await onCloud("PATCH", `/api/bots/${ember.id}`, { title: "There" })).status).toBe(200);
  // My Cloud's own bots: one called Scout too, and one only it has.
  const cloudScout = (await onCloud("POST", "/api/bots", { name: "Scout" })).body.bot as { id: string };
  const cloudy = (await onCloud("POST", "/api/bots", { name: "Cloudy" })).body.bot as { id: string };

  // Automations: one on, one off, one that runs at every start, one due soon, a scheduled call and a webhook.
  const add = async (body: Record<string, unknown>) => { const made = (await local("POST", "/api/routines", body)).body; return (made.routine ?? made).id as string; };
  morning = await add({ name: "Morning report", prompt: "Report.", botId: scout.id, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 });
  paused = await add({ name: "Paused one", prompt: "Wait.", botId: scout.id, schedule: { type: "daily", time: "10:00", weekdays: [1] }, durationMinutes: 15 });
  expect((await local("PATCH", `/api/routines/${paused}`, { enabled: false })).status).toBe(200);
  startup = await add({ name: "At every start", prompt: "Say hello.", botId: scout.id, runOnStartup: true, schedule: { type: "interval", everyMinutes: 1_440, anchorAt: Date.now() + 86_400_000 }, durationMinutes: 15 });
  soonAt = Date.now() + 150_000;
  soon = await add({ name: "Soon", prompt: "Say the time.", botId: scout.id, schedule: { type: "interval", everyMinutes: 1_440, anchorAt: soonAt }, durationMinutes: 15 });
  callId = (await local("POST", "/api/calendar-calls", { name: "Weekly sync", botIds: [scout.id], schedule: { type: "daily", time: "11:00", weekdays: [1] } })).body.call.id;
  const webhook = (await local("POST", "/api/webhooks", { name: "Orders", prompt: "File the order.", botId: scout.id })).body;
  webhookId = webhook.webhook.id;
  hook = { endpointId: webhook.webhook.endpointId, secret: webhook.credential.secret };
  await expect.poll(() => idle(local), { timeout: 60_000, interval: 200 }).toBe(true);

  // The app is killed the moment each phase would be written down, and opens again.
  const killAt = new Set(["wait", "freeze", "final", "check", "switch", "done"]);
  const killed = { at: null as string | null };
  const phases: string[] = [];
  fx.beforeJournalWrite = (value) => {
    if (value?.phase && phases.at(-1) !== value.phase) phases.push(value.phase);
    if (value?.phase && killAt.delete(value.phase)) { killed.at = value.phase; throw new Error("the app was killed"); }
  };
  fx.account.state = { ...fx.account.state, machine: { status: "ready", origin: fx.cloudBase, moves: true } };
  await moveUntilDone(killed);
  fx.beforeJournalWrite = null;
  expect(killAt.size, "killed once at every phase").toBe(0);
  for (const phase of ["copy", "wait", "freeze", "final", "check", "switch", "done"]) expect(phases).toContain(phase);

  // Home is My Cloud, and everything is there: the move's own check, run again.
  expect(fx.oneHome.away()).toBe(true);
  const report = await fx.check();
  expect(report.gaps, JSON.stringify(report.gaps)).toEqual({ items: [], parts: [], memory: [], rooms: [], connections: [], conversations: [], files: [], runs: [], journal: [], learned: [], teams: [], settings: [] });
  expect(report.ok).toBe(true);
  const done = fx.oneHome.view() as Extract<OneHomeView, { phase: "done" }>;
  expect(done).toMatchObject({ phase: "done", phone: true, counts: { routines: 4 } });
  expect(done.counts!.bots).toBeGreaterThanOrEqual(2);

  // This computer's copy is frozen: no turn, no webhook, and it says why.
  const refused = await local("POST", `/api/bots/${scout.id}/messages`, { text: "Still here?", threadId: scout.threadId });
  expect(refused).toMatchObject({ status: 409, body: { error: MOVED_REFUSAL } });
  const desktopHooks = `http://127.0.0.1:${Number(new URL(fx.desktopBase).port) + 1}`;
  const posted = await fetch(`${desktopHooks}/hooks/${hook.endpointId}/${hook.secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(posted.status).toBe(409);
  expect((await local("GET", "/api/routines/wake")).body, "nor keeps this computer awake for a routine that runs on My Cloud").toEqual({ hold: false });

  // My Cloud switched on what was on here, and only that.
  const there = await routines(onCloud);
  const on = (id: string) => there.routines.find((routine) => routine.id === id);
  expect([on(morning)?.enabled, on(paused)?.enabled, on(startup)?.enabled, on(soon)?.enabled]).toEqual([true, false, true, true]);
  expect(((await onCloud("GET", "/api/calendar-calls")).body.calls as Array<{ id: string; nextRunAt: number | null }>).find((call) => call.id === callId)?.nextRunAt).not.toBeNull();
  const hooksThere = (await onCloud("GET", "/api/webhooks")).body.webhooks as Array<{ id: string; enabled: boolean }>;
  expect(hooksThere.find((entry) => entry.id === webhookId)?.enabled).toBe(true);
  // Scout says once, in its own chat, that its webhook has a new address; the address itself stays on its card.
  const told = (await rows(onCloud, scout.threadId)).filter((row) => row.role === "bot" && row.text === webhookMovedLine("Orders"));
  expect(told).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dataDir("cloud"), "moved-from.json"), "utf8"))).toMatchObject({ computer: COMPUTER });

  // §2.2: one Ember, updated where only this computer changed it and My Cloud's title kept; both Scouts, the arriving
  // one named after this computer; My Cloud's own bot untouched; the bot deleted there not brought back.
  const cloudBots = await bots(onCloud);
  const emberThere = cloudBots.filter((bot) => bot.id === ember.id);
  expect(emberThere).toHaveLength(1);
  expect(emberThere[0]).toMatchObject({ soul: "You are Ember, from this computer.", title: "There" });
  expect(cloudBots.find((bot) => bot.id === scout.id)?.name).toBe(`Scout (${COMPUTER})`);
  expect(cloudBots.find((bot) => bot.id === cloudScout.id)?.name).toBe("Scout");
  expect(cloudBots.find((bot) => bot.id === cloudy.id)?.name).toBe("Cloudy");
  expect(cloudBots.some((bot) => bot.id === old.id)).toBe(false);

  // This computer is lent with Scout's project folder, its phone link stops, and the window opens My Cloud: once each.
  expect(fx.spies.lent).toEqual([[project]]);
  expect(fx.spies.phoneStops).toBe(1);
  expect(fx.spies.opened).toEqual(["cloud"]);

  // The schedules on both servers: the one that runs at every start ran here only before the freeze, never on My Cloud,
  // and no occurrence of any routine ran on both sides.
  const frozenAt = (JSON.parse(readFileSync(join(dataDir("desktop"), "moved.json"), "utf8")) as { at: number }).at;
  const here = await routines(local);
  expect(here.runs.filter((run) => run.routineId === startup && run.createdAt >= frozenAt), "a frozen computer never runs a schedule, however often it starts").toEqual([]);
  expect(here.runs.filter((run) => run.routineId === startup).length).toBeGreaterThanOrEqual(1);
  await sleep(Math.max(0, soonAt + 25_000 - Date.now()));
  const [afterHere, afterThere] = [await routines(local), await routines(onCloud)];
  const ids = new Map<string, Set<string>>();
  for (const run of [...afterHere.runs, ...afterThere.runs]) {
    if (run.manual || run.triggerSource === "manual") continue;
    const key = `${run.routineId}@${run.scheduledFor}`;
    ids.set(key, (ids.get(key) ?? new Set()).add(run.id));
  }
  expect([...ids].filter(([, runs]) => runs.size > 1), "an occurrence ran on both sides").toEqual([]);
  expect(afterHere.runs.filter((run) => run.routineId === soon && run.createdAt >= frozenAt)).toEqual([]);
  if (journal()!.doneAt! < soonAt) expect(afterThere.runs.filter((run) => run.routineId === soon && run.scheduledFor === soonAt)).toHaveLength(1);
}, hostTimeout(900_000));

it("when My Cloud ends, everything comes home: this computer at once, then My Cloud's own later chats and what was on there", async () => {
  const { local, onCloud } = fx;
  // On My Cloud, after the move: a new conversation turn with Scout.
  await turn(onCloud, scout, "From My Cloud: book the venue.");
  const later = (await rows(onCloud, scout.threadId)).map((row) => row.id);

  // The trial ends unpaid: the Admin holds My Cloud, and starts it for its owner's export only.
  fx.account.state = { ...fx.account.state, machine: { status: "stopped", hold: { until: Date.now() + 3 * 86_400_000 } } };
  let asked = 0;
  fx.account.exportHome = async () => {
    asked++;
    if (asked === 1) return { starting: true };
    return { grant: { origin: fx.cloudBase, code: (await fx.grant("Bring My Cloud home")).code, expiresAt: Date.now() + 300_000 } };
  };
  await fx.relaunch({ kill: false, cloud: { OMB_CLOUD_EXPORT_ONLY: "1" } });
  expect((await onCloud("POST", `/api/bots/${scout.id}/messages`, { text: "Anyone?", threadId: scout.threadId })).status, "a held Cloud runs nothing").toBe(409);

  await fx.oneHome.kick();
  expect(journal()?.phase).toBe("home-again");
  // Home again, this computer's schedules run at once (the one that runs at every start among them).
  await expect.poll(() => idle(local), { timeout: 60_000, interval: 200 }).toBe(true);
  expect(fx.oneHome.away()).toBe(false);
  expect(fx.spies.opened.at(-1)).toBe("local");
  expect(fx.spies.phoneStarts).toBe(1);
  expect((await local("GET", "/api/move/freeze")).body.frozen, "home again at once").toBe(false);

  for (let round = 0; round < 40 && journal()?.phase !== "back"; round++) { await fx.oneHome.kick(); if (journal()?.phase !== "back") await sleep(500); }
  expect(journal()?.phase).toBe("back");
  expect(fx.spies.relaunches).toBe(1);
  // The app opens again, which finishes the restore, and switches on here what was on at My Cloud.
  await fx.relaunch({ kill: false });
  await fx.oneHome.kick();
  const home = await rows(local, scout.threadId);
  expect(home.map((row) => row.id)).toEqual(expect.arrayContaining(later));
  expect(home.some((row) => row.text === "From My Cloud: book the venue.")).toBe(true);
  const back = await routines(local);
  const routine = (id: string) => back.routines.find((entry) => entry.id === id);
  expect([routine(morning)?.enabled, routine(paused)?.enabled, routine(soon)?.enabled]).toEqual([true, false, true]);
  expect(fx.oneHome.view()).toEqual({ phase: "back" });
  await turn(local, scout, "Back home?");
}, hostTimeout(600_000));
