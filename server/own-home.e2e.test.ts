// A server of the person's own made their bots' home, end to end: this computer's server and two servers of the person's own
// (scripts/testing/own-home-fixture.ts), one theirs alone and one with other people on it, with main's own wiring for the
// move (electron/own-home-main.mjs) and this computer's real lending (electron/computer-sharing.mjs). Disposable homes; no
// network.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createComputerSharing } from "../electron/computer-sharing.mjs";
import { createLendingTarget } from "../electron/lending-target.mjs";
import { launchOwnHomeFixture, type OwnHomeFixture, type OwnServer } from "../scripts/testing/own-home-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { movedRefusal } from "./move-freeze.ts";
import { webhookMovedLine } from "./cloud-send-arrived.ts";

let fx: OwnHomeFixture;
let garage: OwnServer, family: OwnServer;

beforeAll(async () => {
  fx = await launchOwnHomeFixture();
  garage = await fx.addServer("Garage server");
  family = await fx.addServer("Family server", { OMB_SIGNIN_MEMBER_EMAILS: "friend@example.test" });
}, hostTimeout(120_000));
afterAll(async () => { await fx?.close(); });

type Side = OwnHomeFixture["local"];
type Row = { id: string; role: string; text?: string };
type Run = { id: string; routineId: string; scheduledFor: number; createdAt: number; manual?: boolean; triggerSource?: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const journal = () => { try { return JSON.parse(readFileSync(fx.journalFile, "utf8")) as { phase: string; doneAt?: number } | null; } catch { return null; } };
async function rows(side: Side, threadId: string): Promise<Row[]> {
  return ((await side("GET", `/api/threads/${threadId}/messages?limit=500`)).body?.messages ?? []) as Row[];
}
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
async function turn(side: Side, bot: { id: string; threadId: string }, text: string) {
  const before = (await rows(side, bot.threadId)).length;
  expect((await side("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await expect.poll(async () => await idle(side) && (await rows(side, bot.threadId)).length >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}
const routines = async (side: Side) => (await side("GET", "/api/routines")).body as { routines: Array<{ id: string; enabled: boolean }>; runs: Run[] };

it("only a server that is the person's alone says it is theirs, takes a move and is offered as their bots' home", async () => {
  expect((await garage.as("GET", "/api/auth/session")).body).toMatchObject({ kind: "session", own: true });
  expect((await family.as("GET", "/api/auth/session")).body.own, "others sign in there").toBeUndefined();
  const described = async (server: OwnServer) => ((await (await fetch(`${server.base}/.well-known/openmausbot/environment`)).json()) as { capabilities: { move?: number } }).capabilities;
  expect((await described(garage)).move).toBe(1);
  expect((await described(family)).move).toBeUndefined();

  fx.main.refresh();
  await expect.poll(() => fx.main.offers(garage.place), { timeout: 10_000, interval: 100 }).toBe(true);
  expect(fx.main.offers(family.place)).toBe(false);

  // Asked anyway, the shared one keeps this computer's bots here, and its move routes refuse this sign-in.
  await expect(fx.main.start(family.place.id)).rejects.toThrow("Family server has other people on it, so your bots stay here.");
  expect(fx.main.chosen()).toBeNull();
  expect((await family.as("POST", "/api/cloud-send/memory", { v: 1, about: "", teams: [] })).status).toBe(403);
  expect((await family.as("POST", "/api/cloud-send/arrived", { v: 1, computer: "Work laptop", webhooks: [] })).status).toBe(404);
  expect((await family.as("PUT", "/api/cloud-connections/highlevel", {})).status).toBe(404);
  // Garage server takes them from this sign-in: a body it can't read is answered as such, never refused.
  expect((await garage.as("POST", "/api/cloud-send/arrived", { v: 1 })).status).toBe(400);
}, hostTimeout(60_000));

let scout: { id: string; threadId: string }, ember: { id: string; threadId: string };
let morning = "", paused = "", soon = "", soonAt = 0;
let project = "";

it("Make Garage server my home: bots, chats, memory and routines arrive, this computer stops for good, and no routine runs twice", async () => {
  const { local } = fx;
  scout = (await local("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  project = join(fx.root, "desktop", "code", "shop");
  mkdirSync(project, { recursive: true });
  expect((await local("PATCH", `/api/bots/${scout.id}`, { soul: "You are Scout.", cwd: project })).status).toBe(200);
  await turn(local, scout, "Plan the week.");
  ember = (await local("POST", "/api/bots", { name: "Ember", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await turn(local, ember, "Hello Ember.");
  expect((await local("PUT", `/api/bots/${ember.id}/memory/file`, { path: "MEMORY.md", text: "# Memory\n\n- The person likes short answers.\n" })).status).toBeLessThan(300);
  const add = async (body: Record<string, unknown>) => { const made = (await local("POST", "/api/routines", body)).body; return (made.routine ?? made).id as string; };
  morning = await add({ name: "Morning report", prompt: "Report.", botId: scout.id, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 });
  paused = await add({ name: "Paused one", prompt: "Wait.", botId: scout.id, schedule: { type: "daily", time: "10:00", weekdays: [1] }, durationMinutes: 15 });
  expect((await local("PATCH", `/api/routines/${paused}`, { enabled: false })).status).toBe(200);
  soonAt = Date.now() + 120_000;
  soon = await add({ name: "Soon", prompt: "Say the time.", botId: scout.id, schedule: { type: "interval", everyMinutes: 1_440, anchorAt: soonAt }, durationMinutes: 15 });
  const webhook = (await local("POST", "/api/webhooks", { name: "Orders", prompt: "File the order.", botId: scout.id })).body;
  await expect.poll(() => idle(local), { timeout: 60_000, interval: 200 }).toBe(true);

  expect(await fx.main.start(garage.place.id)).toEqual({ started: true });
  await expect.poll(() => fx.main.view()?.place, { timeout: 10_000, interval: 50 }).toBe("Garage server");

  // The app is killed the moment the freeze and the switch would be written down, and opens again.
  const killAt = new Set(["freeze", "switch"]);
  let killed = false;
  fx.beforeJournalWrite = (value) => { if (value?.phase && killAt.delete(value.phase)) { killed = true; throw new Error("the app was killed"); } };
  for (let round = 0; round < 240 && journal()?.phase !== "done"; round++) {
    await fx.main.kick().catch(() => {});
    if (killed) { killed = false; await fx.relaunch(); continue; }
    if (journal()?.phase !== "done") await sleep(500);
  }
  fx.beforeJournalWrite = null;
  expect(journal()?.phase, `${JSON.stringify(journal())}\n${fx.logs().split("\n").filter((line) => line.startsWith("[main]")).join("\n")}`).toBe("done");
  expect(killAt.size, "killed once at each").toBe(0);

  // Home is Garage server: everything is there under the same ids.
  expect(fx.main.away()).toBe(true);
  expect(fx.main.home()).toMatchObject({ origin: garage.base, name: "Garage server" });
  const there = (await garage.as("GET", "/api/bots")).body.bots as Array<{ id: string; name: string; soul?: string; cwd?: string }>;
  expect(there.find((bot) => bot.id === scout.id)).toMatchObject({ name: "Scout", soul: "You are Scout." });
  expect(there.find((bot) => bot.id === ember.id)?.name).toBe("Ember");
  const chat = await rows(garage.as, scout.threadId);
  expect(chat.some((row) => row.role === "user" && row.text === "Plan the week.")).toBe(true);
  const memory = (await garage.as("GET", `/api/bots/${ember.id}/memory/file?path=MEMORY.md`)).body;
  expect(memory?.text).toContain("The person likes short answers.");
  const told = (await rows(garage.as, scout.threadId)).filter((row) => row.role === "bot" && row.text === webhookMovedLine("Orders", "Garage server"));
  expect(told, "the webhook's bot says once where it lives now").toHaveLength(1);

  // What was on here is on there, and only that; this computer is stopped for good and says where its bots live.
  const after = await routines(garage.as);
  const on = (id: string) => after.routines.find((routine) => routine.id === id)?.enabled;
  expect([on(morning), on(paused), on(soon)]).toEqual([true, false, true]);
  const refused = await local("POST", `/api/bots/${scout.id}/messages`, { text: "Still here?", threadId: scout.threadId });
  expect(refused).toMatchObject({ status: 409, body: { error: movedRefusal("Garage server") } });
  expect(webhook.webhook.id).toBeTruthy();
  expect((await local("GET", "/api/move/freeze")).body).toMatchObject({ frozen: true, cloud: garage.base, place: "Garage server" });

  // This computer is lent with Scout's project folder to Garage server, its phone link stops, and the window opens Garage server.
  expect(fx.spies.lent).toEqual([{ projects: [project], place: garage.base }]);
  expect(fx.spies.phoneStops).toBe(1);
  expect(fx.spies.opened).toEqual([garage.base]);
  expect(fx.main.offers(garage.place), "home is there: nothing more to offer").toBe(false);

  // No occurrence of any routine ran on both sides, and the one due soon ran on Garage server only.
  await sleep(Math.max(0, soonAt + 25_000 - Date.now()));
  const [here, home] = [await routines(local), await routines(garage.as)];
  const occurrences = new Map<string, Set<string>>();
  for (const run of [...here.runs, ...home.runs]) {
    if (run.manual || run.triggerSource === "manual") continue;
    const key = `${run.routineId}@${run.scheduledFor}`;
    occurrences.set(key, (occurrences.get(key) ?? new Set()).add(run.id));
  }
  expect([...occurrences].filter(([, runs]) => runs.size > 1), "an occurrence ran on both sides").toEqual([]);
  expect(here.runs.filter((run) => run.routineId === soon)).toEqual([]);
  expect(home.runs.filter((run) => run.routineId === soon && run.scheduledFor === soonAt)).toHaveLength(1);
}, hostTimeout(900_000));

it("this computer then works for Garage server by itself, and never for the server it shares with others", async () => {
  const places: Array<{ id: string; name: string; origin: string }> = [garage.place, family.place];
  const target = createLendingTarget({ account: () => null, environments: () => places, ownHome: () => fx.main.home() });
  expect(target.places().map((place) => place.origin)).toEqual([garage.base]);
  expect(target.cloud(family.place)).toBeNull();
  const lent = mkdtempSync(join(fx.root, "lent-"));
  const sharing = createComputerSharing({ file: join(fx.root, "computer-sharing.json"), fetch: fx.windowFetch, environments: () => places,
    home: lent, cloud: target.cloud, myCloud: target.environment, ownClouds: target.places, screen: () => false, cuaConnection: async () => null });
  try {
    sharing.start({ maintainer: false });
    await expect.poll(async () => ((await garage.as("GET", "/api/shared-computers")).body?.computers ?? []).length, { timeout: 30_000, interval: 250 }).toBe(1);
    expect(sharing.cloudState(garage.place)).toMatchObject({ enabled: true, terminal: false });
    expect(sharing.state(family.place.id).enabled).toBe(false);
    expect((await family.as("GET", "/api/shared-computers")).status, "nothing is lent where others sign in").not.toBe(200);
    // Pause: Garage server stops using this computer, until Resume.
    sharing.pause();
    await expect.poll(async () => ((await garage.as("GET", "/api/shared-computers")).body?.computers ?? []).filter((computer: { online?: boolean; connected?: boolean }) => computer.online !== false && computer.connected !== false).length,
      { timeout: 30_000, interval: 250 }).toBe(0);
  } finally { sharing.close(); }
}, hostTimeout(120_000));
