// Private means private on a Team Cloud (docs/team-cloud.md), tried as the people it must hold against: an Admin, the
// Owner and another member, on a real Team Cloud (OMB_CLOUD_ROLE=team) with the synthetic Claude CLI. Usage counts what
// Rui spent and never says on what; Rui's own MausBot exists for nobody but Rui, on every route and in every list; and a
// routine made with no audience named is its writer's alone.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const RUI = { email: "rui@acme.test", role: "member" as const };
const MARTA = { email: "marta@acme.test", role: "member" as const };
const LATER = { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 };
const MARK = "Plover42";
const NO_SUCH_BOT = { status: 404, body: { error: "no such bot" } };

type Task = { threadId: string; private?: true; title?: string };
type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; defaultBot?: { person?: string }; tasks?: Task[] };
type Routine = { id: string; name: string; resultsThreadId?: string };
type Run = { id: string; routineId: string; status: string; threadId?: string };
type Group = { key: string; label: string; turns: number };
type Answer = { status: number; body: unknown };

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", rui = "", marta = "";
let quotes: Bot, ruiMaus: Bot;
let ruiThread = "", ruiRoutine = "", ariRoutine = "";
/** Every id that is Rui's alone: his private conversations, his private routine and its runs, his MausBot. */
const ruiIds = new Set<string>();

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(150);
  }
}
const botsOf = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
const routinesOf = async (token: string) => (await team.as(token, "GET", "/api/routines")).body as { routines: Routine[]; runs: Run[] };
const text = async (token: string, path: string) => {
  const answer = await fetch(`${team.base}${path}`, { headers: { ...fx.edge, authorization: `Bearer ${token}` } });
  return { status: answer.status, text: await answer.text() };
};
async function runToEnd(token: string, routineId: string): Promise<Run> {
  const ran = await team.as(token, "POST", `/api/routines/${routineId}/run`);
  expect(ran.status, JSON.stringify(ran.body)).toBe(201);
  let run: Run | undefined;
  await until(async () => {
    run = (await routinesOf(token)).runs.find((candidate) => candidate.id === ran.body.run.id);
    return Boolean(run && ["completed", "failed"].includes(run.status));
  }, 90_000);
  return run!;
}
async function sayAndWait(token: string, bot: Bot, threadId: string, line: string): Promise<void> {
  const ended = async () => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as Array<{ turnTerminal?: boolean }>).filter((message) => message.turnTerminal).length;
  const before = await ended();
  expect((await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text: line, threadId })).status).toBe(202);
  await until(async () => (await ended()) > before);
}
const usage = async (token: string, groupBy: string) => (await team.as(token, "GET", `/api/usage?groupBy=${groupBy}`)).body as { groups: Group[]; total: Group };
/** What names something of Rui's in an answer: the marker his names carry, or one of his ids. */
const leaksIn = (answer: string): string[] => [MARK, ...ruiIds].filter((mark) => answer.includes(mark));
async function streamOf(token: string): Promise<string> {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream", "last-event-id": "0" }, signal: controller.signal });
  const reader = stream.body!.getReader(), decoder = new TextDecoder();
  let seen = "";
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await until(() => seen.includes("\"hello\""), 10_000);
  await sleep(1_500);
  controller.abort();
  await done;
  return seen;
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-holes", name: "Acme" } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  rui = (await team.pair(RUI)).token!;
  marta = (await team.pair(MARTA)).token!;
  quotes = (await team.as(owner, "POST", "/api/bots", { name: "Quotes", visibility: "everyone" })).body.bot;
  ruiMaus = (await botsOf(rui)).find((bot) => bot.defaultBot?.person === RUI.email)!;
  expect(ruiMaus, "Rui has a MausBot of his own").toBeTruthy();

  const renamed = await team.as(rui, "PATCH", `/api/bots/${ruiMaus.id}`, { name: `Confidant ${MARK}` });
  expect(renamed.status, "he names his own MausBot").toBe(200);
  ruiThread = (await team.as(rui, "POST", `/api/bots/${quotes.id}/tasks`, { title: `Salary talk ${MARK}` })).body.task.threadId;
  await sayAndWait(rui, quotes, ruiThread, `What should I ask for? ${MARK}`);
  await sayAndWait(rui, ruiMaus, ruiMaus.threadId, `Remember my ceiling ${MARK}`);
  const made = await team.as(rui, "POST", "/api/routines", { name: `Salary check ${MARK}`, prompt: `Check the salary bands ${MARK}`, botId: quotes.id, schedule: LATER, resultsThreadId: "just-me" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  ruiRoutine = made.body.routine.id;
  const ruiRun = await runToEnd(rui, ruiRoutine);
  const own = await team.as(admin, "POST", "/api/routines", { name: "Ari's own digest", prompt: "Sum up my week", botId: quotes.id, schedule: LATER, resultsThreadId: "just-me" });
  expect(own.status, JSON.stringify(own.body)).toBe(201);
  ariRoutine = own.body.routine.id;
  await runToEnd(admin, ariRoutine);

  for (const bot of await botsOf(rui)) for (const task of bot.tasks ?? []) if (task.private) ruiIds.add(task.threadId);
  for (const id of [ruiThread, ruiRoutine, ruiRun.id, ruiRun.threadId, ruiMaus.id, ruiMaus.threadId]) if (id) ruiIds.add(id);
  // Booked a moment after each turn ends.
  await until(async () => (await usage(admin, "user")).groups.find((group) => group.key === `user:${RUI.email}`)?.turns === 3);
}, hostTimeout(300_000));

afterAll(async () => {
  await fx?.close();
});

it("usage tells an Admin and the Owner how much Rui used, never on what", async () => {
  for (const [who, token] of [["an Admin", admin], ["the Owner", owner]] as const) {
    for (const groupBy of ["bot", "model", "user", "day", "engine", "routine", "department"]) {
      const answer = await team.as(token, "GET", `/api/usage?groupBy=${groupBy}`);
      expect(answer.status).toBe(200);
      expect(leaksIn(JSON.stringify(answer.body)), `${who}: usage by ${groupBy}`).toEqual([]);
    }
    const csv = await text(token, "/api/usage.csv");
    expect(csv.status).toBe(200);
    expect(leaksIn(csv.text), `${who}: the export`).toEqual([]);
    const ruiRows = csv.text.trim().split("\n").filter((line) => line.endsWith(`,${RUI.email}`));
    expect(ruiRows, "each of his turns is still a row with his address").toHaveLength(3);
    for (const row of ruiRows) expect(row.split(",").at(-3), "and names no conversation").toBe("");
    expect(ruiRows.filter((row) => row.includes(",Private routine,")), "his routine's run says only that").toHaveLength(1);

    const byRoutine = await usage(token, "routine");
    expect(byRoutine.groups.find((group) => group.key === "routine:private"), `${who}: a private routine is one unnamed line`).toMatchObject({ label: "Private routine" });
    expect((await usage(token, "user")).groups.find((group) => group.key === `user:${RUI.email}`)?.turns, "his turns count as his").toBe(3);
    const byBot = await usage(token, "bot");
    expect(byBot.groups.reduce((sum, group) => sum + group.turns, 0), "and toward the team's total").toBe(byBot.total.turns);
    expect(byBot.groups.find((group) => group.key === "bot:private"), "his MausBot's turn is counted without the bot").toMatchObject({ label: "Private bot" });
    expect((await team.as(token, "GET", "/api/usage/traces")).body.roots.filter((root: { title?: string }) => leaksIn(JSON.stringify(root)).length)).toEqual([]);
  }
}, hostTimeout(60_000));

it("a person still reads their own private routine and conversations in usage; the other admin does not", async () => {
  const mine = await usage(admin, "routine");
  expect(mine.groups.find((group) => group.key === `routine:${ariRoutine}`), "Ari's own routine, by name").toMatchObject({ label: "Ari's own digest", turns: 1 });
  expect((await text(admin, "/api/usage.csv")).text).toContain("Routine: Ari's own digest");
  const theirs = JSON.stringify(await usage(owner, "routine")) + (await text(owner, "/api/usage.csv")).text;
  expect(theirs).not.toContain("Ari's own digest");
  expect(theirs).not.toContain(ariRoutine);
  expect((await usage(owner, "routine")).groups.find((group) => group.key === "routine:private")?.turns, "both private routines fold into the one line").toBe(2);
  expect((await team.as(marta, "GET", "/api/usage")).status, "a member reads no usage at all").toBe(403);
}, hostTimeout(60_000));

const SUFFIXES = ["", "/tasks", "/tasks/t1", "/tasks/t1/title", "/tasks/delete", "/messages", "/messages/guarded", "/messages/m1/edit", "/memory", "/memory/file",
  "/memory/journal", "/memory/journal/j1/revert", "/memory/mine", "/memory/mine/file", "/memory/open", "/memory/reviewed", "/memory/tidy", "/memory/upkeep",
  "/access", "/access-request", "/reports-to", "/bot-api", "/bot-api/new-key", "/profile", "/model", "/always-allow", "/soul", "/soul/apply-file",
  "/soul/discard-file", "/system-prompt", "/skills", "/skills/abc", "/skills/abc/share", "/skills-library", "/skill-template", "/history", "/history/rollback",
  "/activity", "/overview", "/projects", "/projects/p1", "/projects/order", "/queue/q1", "/queue/q1/steer", "/read", "/respond", "/interrupt", "/compact",
  "/active-branch", "/start-fresh", "/setup-request", "/helper-followup", "/tool-budget", "/threads/follow-model", "/mcp-servers", "/data", "/data/x", "/computer",
  "/computer/exec", "/computer/control", "/computer/viewer-close", "/local-computer", "/local-computer/run", "/local-computer/join", "/local-computer/screenshot",
  "/browser/live", "/browser/action", "/browser/upload", "/browser/download/d1", "/browser/stream", "/cards/c1", "/command-allowlist", "/command-allowlist/x",
  "/connector-cards/c1/status", "/connector-cards/c1/authorize", "/secret-cards/c1/provide", "/secret-cards/c1/save", "/sign-in-cards/c1/done", "/saved-steps/s1",
  "/requests/aaaaaaaaaaaaaaaaaaaa", "/requests/aaaaaaaaaaaaaaaaaaaa/interrupt", "/apps/a1/rpc", "/apps/a1/context", "/avatar/generate", "/slack-management", "/webhooks", "/routines", "/files", "/no-such-route"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Every route under a bot's id, asked of two ids at once. */
async function everyRoute(token: string, ids: readonly [string, string]): Promise<Array<{ route: string; answers: [Answer, Answer] }>> {
  const routes = SUFFIXES.flatMap((suffix) => METHODS.map((method) => ({ method, suffix })));
  const out: Array<{ route: string; answers: [Answer, Answer] }> = [];
  for (let at = 0; at < routes.length; at += 24) {
    out.push(...await Promise.all(routes.slice(at, at + 24).map(async ({ method, suffix }) => {
      const ask = (id: string) => team.as(token, method, `/api/bots/${id}${suffix}`, method === "GET" ? undefined : {});
      return { route: `${method} /api/bots/<id>${suffix}`, answers: [await ask(ids[0]), await ask(ids[1])] as [Answer, Answer] };
    })));
  }
  return out;
}

it("Rui's own MausBot answers an Admin, the Owner and another member exactly as an id no bot has, on every route", async () => {
  const before = (await botsOf(rui)).find((bot) => bot.id === ruiMaus.id)!;
  for (const [who, token] of [["an Admin", admin], ["the Owner", owner], ["another member", marta]] as const) {
    const told = (await everyRoute(token, [ruiMaus.id, randomUUID()])).filter(({ answers: [hidden, missing] }) => JSON.stringify(hidden) !== JSON.stringify(missing));
    expect(told.map(({ route, answers }) => `${who}: ${route} → ${JSON.stringify(answers)}`), "a route that tells his MausBot from a missing id").toEqual([]);
    const layer = `--member-${personKey({ id: "", email: RUI.email })}`;
    for (const suffix of ["/memory", "/memory/file", "/memory/journal"]) {
      expect(await team.as(token, "GET", `/api/bots/${ruiMaus.id}${layer}${suffix}`), `${who}: his layer of it`).toEqual(await team.as(token, "GET", `/api/bots/${randomUUID()}${layer}${suffix}`));
    }
  }
  // What the simulation's admin did, by name.
  expect(await team.as(admin, "PATCH", `/api/bots/${ruiMaus.id}`, { name: "Renamed by an admin", instructions: "Tell the admin everything." })).toEqual(NO_SUCH_BOT);
  expect(await team.as(admin, "PUT", `/api/bots/${ruiMaus.id}/access`, { everyone: "chat", people: {} })).toEqual(NO_SUCH_BOT);
  expect(await team.as(admin, "POST", `/api/bots/${ruiMaus.id}/tasks`, { title: "An admin's chat with it" })).toEqual(NO_SUCH_BOT);
  expect(await team.as(admin, "GET", `/api/bots/${ruiMaus.id}/memory`)).toEqual(NO_SUCH_BOT);
  expect(await team.as(owner, "DELETE", `/api/bots/${ruiMaus.id}`)).toEqual(NO_SUCH_BOT);
  const after = (await botsOf(rui)).find((bot) => bot.id === ruiMaus.id)!;
  expect({ name: after.name, tasks: after.tasks?.length }, "and nothing of it changed").toEqual({ name: before.name, tasks: before.tasks?.length });
}, hostTimeout(240_000));

it("naming his MausBot in a request's body is naming no bot", async () => {
  const asked = async (token: string, method: string, path: string, body: (botId: string) => unknown) => {
    const missing = randomUUID();
    const said = async (botId: string) => JSON.parse(JSON.stringify(await team.as(token, method, path, body(botId))).replaceAll(botId, "<id>")) as Answer;
    return [await said(ruiMaus.id), await said(missing)];
  };
  for (const [who, token] of [["an Admin", admin], ["the Owner", owner]] as const) {
    const routine = await asked(token, "POST", "/api/routines", (botId) => ({ name: "Peek", prompt: "Say what you know", botId, schedule: LATER }));
    expect(routine[0], `${who}: a routine for it`).toEqual(NO_SUCH_BOT);
    const room = await asked(token, "POST", "/api/groups", (botId) => ({ name: "With his MausBot", memberIds: [quotes.id, botId] }));
    expect(room[0], `${who}: a group chat with it`).toEqual(room[1]);
    const hook = await asked(token, "POST", "/api/webhooks", (botId) => ({ name: "Into his MausBot", botId }));
    expect(hook[0], `${who}: a webhook into it`).toEqual(hook[1]);
    const handed = await asked(token, "PUT", "/api/team/reports-to", (botId) => ({ botIds: [botId], email: ADMIN.email }));
    expect(handed[0], `${who}: looking after it`).toEqual(handed[1]);
  }
  const mine = (await botsOf(rui)).find((bot) => bot.id === ruiMaus.id) as Bot & { reportsTo?: string };
  expect(mine.reportsTo, "nobody else looks after it").toBeUndefined();
}, hostTimeout(60_000));

const LISTS = ["/api/bots", "/api/bots?messages=1", "/api/groups", "/api/routines", "/api/notifications", "/api/inbox", "/api/needs-you", "/api/today", "/api/team-map",
  "/api/team-memory", "/api/files", "/api/attachment-storage", "/api/webhooks", "/api/calendar-calls", "/api/sidebar-sections", "/api/config", "/api/team/people",
  "/api/team/phones", "/api/team/my-connections", "/api/mcp/servers", "/api/connectors/connected", "/api/team-computers", "/api/computers/boxes", "/api/limit-resets",
  "/api/sync/folders", "/api/app-triggers", "/api/browser-sites", "/api/auth/session", "/api/auth/sessions", "/api/section-context", "/api/bot-defaults",
  "/api/admin-activity", "/api/admin-activity.csv", "/api/decisions", "/api/decisions.csv", "/api/usage/traces", `/api/search?q=${MARK}`, "/api/search?q=Salary",
  "/api/search?q=MausBot", "/api/plan-usage", "/api/shared-computers", "/api/profile/learned", "/api/vault", "/api/logins"];

it("no list, search, export, stream or signed read names anything of Rui's to an Admin, the Owner or another member", async () => {
  for (const [who, token] of [["an Admin", admin], ["the Owner", owner], ["another member", marta]] as const) {
    const perBot = [`/api/bots/${quotes.id}`, `/api/bots/${quotes.id}/overview`, `/api/bots/${quotes.id}/activity`, `/api/bots/${quotes.id}/memory`,
      `/api/bots/${quotes.id}/memory/journal`, `/api/bots/${quotes.id}/tasks`, `/api/bots/${quotes.id}/history`];
    for (const path of [...LISTS, ...perBot]) {
      const answer = await text(token, path);
      expect(leaksIn(answer.text), `${who}: GET ${path} (${answer.status})`).toEqual([]);
    }
    expect(leaksIn(await streamOf(token)), `${who}: the event stream, replayed`).toEqual([]);
  }
  for (const [who, token] of [["an Admin", admin], ["the Owner", owner]] as const) {
    for (const format of ["backup", "share"]) {
      const exported = await team.as(token, "POST", "/api/teams/export", { format });
      expect(leaksIn(JSON.stringify(exported.body)), `${who}: the team export as ${format} (${exported.status})`).toEqual([]);
    }
  }
  const signed = await team.signed("GET", "/api/cloud/team/admin");
  expect(signed.status).toBe(200);
  expect(leaksIn(JSON.stringify(signed.body)), "the Admin's signed read").toEqual([]);
}, hostTimeout(180_000));

it("Rui keeps every use of his own MausBot, and of what is his", async () => {
  expect((await botsOf(rui)).some((bot) => bot.id === ruiMaus.id), "it is in his list").toBe(true);
  expect((await team.as(rui, "GET", `/api/bots/${ruiMaus.id}/memory/mine`)).status).toBe(200);
  expect((await team.as(rui, "PATCH", `/api/bots/${ruiMaus.id}`, { color: "blue" })).status, "he changes how it looks").toBe(200);
  const chat = await team.as(rui, "POST", `/api/bots/${ruiMaus.id}/tasks`, { title: "Another chat of his" });
  expect(chat.status).toBe(201);
  await sayAndWait(rui, ruiMaus, chat.body.task.threadId, "Still there?");
  const forIt = await team.as(rui, "POST", "/api/routines", { name: "His MausBot's morning note", prompt: "Say good morning", botId: ruiMaus.id, schedule: LATER });
  expect(forIt.status, JSON.stringify(forIt.body)).toBe(201);
  expect((await routinesOf(rui)).routines.map((routine) => routine.id)).toEqual(expect.arrayContaining([ruiRoutine, forIt.body.routine.id]));
  expect((await team.as(rui, "GET", `/api/threads/${ruiThread}/messages?limit=20`)).status).toBe(200);
}, hostTimeout(120_000));

it("a routine made with no audience named is its writer's alone; one sent to the shared chat is the team's", async () => {
  const unsaid = await team.as(rui, "POST", "/api/routines", { name: `Unsaid ${MARK}`, prompt: `Quietly ${MARK}`, botId: quotes.id, schedule: LATER });
  expect(unsaid.status, JSON.stringify(unsaid.body)).toBe(201);
  const mine = (await routinesOf(rui)).routines.find((routine) => routine.id === unsaid.body.routine.id)!;
  const ruiPrivate = (await botsOf(rui)).find((bot) => bot.id === quotes.id)!.tasks!.filter((task) => task.private).map((task) => task.threadId);
  expect(ruiPrivate, "it reports into a chat of his own").toContain(mine.resultsThreadId);
  for (const [who, token] of [["another member", marta], ["an Admin", admin], ["the Owner", owner]] as const) {
    expect(JSON.stringify(await routinesOf(token)), `${who} never learns of it`).not.toContain(unsaid.body.routine.id);
    expect((await team.as(token, "PATCH", `/api/routines/${unsaid.body.routine.id}`, { enabled: false })).status, who).toBe(404);
  }
  const run = await runToEnd(rui, unsaid.body.routine.id);
  for (const token of [marta, admin, owner]) {
    const seen = JSON.stringify(await routinesOf(token)) + JSON.stringify(await botsOf(token));
    expect(seen).not.toContain(run.id);
    expect(seen).not.toContain(`Unsaid ${MARK}`);
  }
  // The choice still widens it when the person makes it: the shared chat by id, or an older app's null.
  for (const resultsThreadId of [quotes.mainThreadId ?? quotes.threadId, null]) {
    const shared = await team.as(rui, "POST", "/api/routines", { name: "Weekly pipeline", prompt: "Post the pipeline", botId: quotes.id, schedule: LATER, resultsThreadId });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    for (const token of [marta, admin]) expect((await routinesOf(token)).routines.some((routine) => routine.id === shared.body.routine.id), "the team sees a shared one").toBe(true);
  }
  // A change that names no audience leaves it where it is.
  expect((await team.as(rui, "PATCH", `/api/routines/${unsaid.body.routine.id}`, { name: `Unsaid still ${MARK}` })).status).toBe(200);
  expect(JSON.stringify(await routinesOf(marta))).not.toContain(unsaid.body.routine.id);
}, hostTimeout(180_000));

it("when Rui leaves, the Cloud itself still finds and deletes his MausBot", async () => {
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: RUI.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(left.body.bots, "his own MausBot").toBe(1);
  expect(await team.as(admin, "GET", `/api/bots/${ruiMaus.id}`)).toEqual(NO_SUCH_BOT);
  const exported = await team.as(owner, "POST", "/api/teams/export", { format: "backup" });
  expect(exported.status, "and the team's backup still works").toBe(200);
  for (const path of ["/api/admin-activity", "/api/admin-activity.csv", "/api/usage?groupBy=bot", "/api/usage.csv", "/api/decisions"]) {
    expect(leaksIn((await text(admin, path)).text), `what is left of him in ${path}`).toEqual([]);
  }
  expect((await usage(admin, "user")).groups.find((group) => group.key === `user:${RUI.email}`)?.turns, "what he used still counts").toBeGreaterThanOrEqual(3);
}, hostTimeout(120_000));
