// Whoever asked owns the run, on a Team Cloud's shared chat. Priya's request holds in a long tool call (a CI poll) while
// Tom and Sam write in the same chat: their lines wait their turn, in a queue everyone sees, and each runs after hers as
// its own turn; neither steers nor stops her run, and only Priya or an admin can stop it. Priya adding to her own run, and
// her private chat, behave as on a one-person server. Disposable homes and the synthetic Claude CLI; nothing leaves this
// machine.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ENGINE = `process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";
process.env.FAKE_CLAUDE_RELEASE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/release";
process.env.FAKE_CLAUDE_MARKER_REPLIES = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/markers.json";`;
const POLL = { name: "Bash", input: { command: "gh run watch 42" }, hold: true };
const [PRIYA_ASK, TOM_ASK, SAM_ASK, PRIYA_MORE] = ["Watch CI for PR 42", "What is due on Friday?", "Book the room for Monday", "Is the PR up yet?"];
/** A resumed turn's prompt can carry earlier lines too, and the fake engine answers the first marker it finds: newest asks first. */
const ANSWERS: Record<string, string> = {
  [PRIYA_MORE]: "Yes, PR 42 is up.",
  [SAM_ASK]: "Booked the room for Monday.",
  [TOM_ASK]: "The invoice run is due on Friday.",
  "Check this week's pay runs.": "This week's pay runs are fine.",
  [PRIYA_ASK]: "CI for PR 42 is green.",
};

type Row = { id: string; role: string; kind: string; text?: string; steered?: boolean; sender?: { name: string; id?: string }; tool?: { name: string }; stoppedBy?: { name: string; id?: string } };
type Queued = { queueId: string; text: string; sender?: { name: string; id?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let ada = "", priya = "", tom = "", sam = "", dev = "";
let botId = "", shared = "";

const home = (name: string) => join(team.home, name);
const transcript = async (token: string, threadId = shared) =>
  ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Row[];
const queue = async (token: string, threadId = shared) =>
  (((await team.as(token, "GET", "/api/bots?messages=0")).body.botQueuedMessages ?? {}) as Record<string, Queued[]>)[threadId] ?? [];
const busy = async (threadId = shared, token = ada) => {
  const bot = ((await team.as(token, "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; busy?: boolean; tasks?: Array<{ threadId: string; busy?: boolean }> }>).find((one) => one.id === botId);
  return Boolean(bot?.tasks?.find((task) => task.threadId === threadId)?.busy ?? (threadId === shared && bot?.busy));
};
const answered = async (text: string, threadId = shared, token = ada) => (await transcript(token, threadId)).some((row) => row.role === "bot" && row.kind === "text" && row.text?.includes(text));
const personFirstStops = async (threadId = shared, token = ada) => (await transcript(token, threadId)).filter((row) => row.kind === "activity" && (row.tool?.name ?? "").endsWith("to answer you first")).length;
const send = (token: string, text: string, threadId = shared) => team.as(token, "POST", `/api/bots/${botId}/messages`, { text, threadId });

/** Priya's request starts and holds in its CI poll; later turns call no tool. */
async function priyaRuns(threadId = shared) {
  rmSync(home("release"), { force: true });
  writeFileSync(home("tool-calls.json"), JSON.stringify([POLL]));
  const polls = async () => (await transcript(priya, threadId)).filter((row) => row.kind === "activity" && JSON.stringify(row.tool ?? {}).includes("gh run watch 42")).length;
  const before = await polls();
  const sent = await send(priya, PRIYA_ASK, threadId);
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(polls, { timeout: hostTimeout(30_000), interval: 100 }).toBe(before + 1);
  writeFileSync(home("tool-calls.json"), "[]");
}
async function release(threadId = shared, token = ada) {
  writeFileSync(home("release"), "");
  await expect.poll(async () => !(await busy(threadId, token)) && (await queue(token, threadId)).length === 0, { timeout: hostTimeout(60_000), interval: 100 }).toBe(true);
}
/** Longer than the person-first wait (OMB_PERSON_FIRST_MS below), so a stop it would make has happened. */
const pastPersonFirst = () => new Promise((resolve) => setTimeout(resolve, 3_000));

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-asker-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-asker", name: "Acme", engine: ENGINE,
    env: { OMB_BOT_BOX: "0", OMB_PERSON_FIRST_MS: "1500" } } });
  team = fx.team!;
  writeFileSync(home("markers.json"), JSON.stringify(ANSWERS));
  writeFileSync(home("tool-calls.json"), "[]");
  ada = (await team.pair({ email: "ada@acme.test", role: "owner" })).token!;
  priya = (await team.pair({ email: "priya@acme.test", role: "member" })).token!;
  tom = (await team.pair({ email: "tom@acme.test", role: "member" })).token!;
  sam = (await team.pair({ email: "sam@acme.test", role: "member" })).token!;
  dev = (await team.pair({ email: "dev@acme.test", role: "member" })).token!;
  for (const [token, name] of [[ada, "Ada"], [priya, "Priya"], [tom, "Tom"], [sam, "Sam"]]) {
    expect((await team.as(token, "PUT", "/api/me", { name })).status).toBe(200);
  }
  const created = await team.as(ada, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  botId = created.body.bot.id;
  shared = created.body.bot.threadId;
}, hostTimeout(120_000));

/** Whatever a test left holding (a stopped run's CI poll, a waiting line) ends before the next one starts. */
afterEach(async () => {
  writeFileSync(home("release"), "");
  writeFileSync(home("tool-calls.json"), "[]");
  await expect.poll(async () => !(await busy()) && (await queue(ada)).length === 0, { timeout: hostTimeout(60_000), interval: 100 }).toBe(true);
}, hostTimeout(90_000));

afterAll(async () => {
  await fx?.close();
});

it("Tom's line during Priya's run waits its turn: it never reaches her run, nor stops it, and runs after as Tom's own turn", async () => {
  await priyaRuns();
  const stopsBefore = await personFirstStops();
  const sent = await send(tom, TOM_ASK);
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  expect(sent.body.steered).toBeUndefined();
  expect(sent.body.queued).toBe(true);
  for (const viewer of [ada, priya, tom]) {
    expect((await queue(viewer)).map((item) => [item.text, item.sender?.name])).toEqual([[TOM_ASK, "Tom"]]);
  }
  await pastPersonFirst();
  expect(await busy()).toBe(true);
  expect(await personFirstStops()).toBe(stopsBefore);

  await release();
  const rows = await transcript(priya);
  const priyaAnswer = rows.findIndex((row) => row.role === "bot" && row.text?.includes(ANSWERS[PRIYA_ASK]));
  const tomLine = rows.findIndex((row) => row.role === "user" && row.text === TOM_ASK);
  const tomAnswer = rows.findIndex((row) => row.role === "bot" && row.text?.includes(ANSWERS[TOM_ASK]));
  expect(priyaAnswer).toBeGreaterThan(-1);
  expect(rows[priyaAnswer].text, "Priya's run never read Tom's words").not.toContain(TOM_ASK);
  expect(priyaAnswer).toBeLessThan(tomLine);
  expect(tomLine).toBeLessThan(tomAnswer);
  expect(rows[tomLine].steered).toBeUndefined();
  expect(rows[tomLine].sender?.name).toBe("Tom");
}, hostTimeout(120_000));

it("only Priya or an admin can stop her run: Tom's Stop and typed stop are refused in words", async () => {
  await priyaRuns();
  const pressed = await team.as(tom, "POST", `/api/bots/${botId}/interrupt`, { threadId: shared });
  expect(pressed.status, JSON.stringify(pressed.body)).toBe(403);
  expect(pressed.body.error).toBe("Only Priya or an admin can stop this.");
  const typed = await send(tom, "stop");
  expect(typed.status, JSON.stringify(typed.body)).toBe(403);
  expect(typed.body.error).toBe("Only Priya or an admin can stop this.");
  expect(await busy()).toBe(true);

  const answersBefore = (await transcript(ada)).filter((row) => row.role === "bot" && row.text?.includes(ANSWERS[PRIYA_ASK])).length;
  const admin = await team.as(ada, "POST", `/api/bots/${botId}/interrupt`, { threadId: shared });
  expect(admin.status, JSON.stringify(admin.body)).toBe(200);
  await expect.poll(() => busy(), { timeout: hostTimeout(30_000), interval: 100 }).toBe(false);
  expect((await transcript(ada)).filter((row) => row.role === "bot" && row.text?.includes(ANSWERS[PRIYA_ASK])).length, "her run ended unanswered").toBe(answersBefore);
  await expect.poll(async () => (await transcript(priya)).findLast((row) => row.kind === "activity" && row.tool?.name.startsWith("stopped:"))?.stoppedBy?.name,
    { timeout: hostTimeout(10_000), interval: 100 }).toBe("Ada");
}, hostTimeout(120_000));

it("Priya can stop her own run", async () => {
  await priyaRuns();
  const own = await team.as(priya, "POST", `/api/bots/${botId}/interrupt`, { threadId: shared });
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  await expect.poll(() => busy(), { timeout: hostTimeout(30_000), interval: 100 }).toBe(false);
  await expect.poll(async () => (await transcript(tom)).findLast((row) => row.kind === "activity" && row.tool?.name.startsWith("stopped:"))?.stoppedBy?.name,
    { timeout: hostTimeout(10_000), interval: 100 }).toBe("Priya");
}, hostTimeout(120_000));

it("Priya adding to her own run in the shared chat is steered into it, and person-first still answers her first", async () => {
  await priyaRuns();
  const stopsBefore = await personFirstStops();
  const more = await send(priya, PRIYA_MORE);
  expect(more.status, JSON.stringify(more.body)).toBe(202);
  expect(more.body.steered).toBe(true);
  await expect.poll(() => personFirstStops(), { timeout: hostTimeout(30_000), interval: 100 }).toBeGreaterThan(stopsBefore);
  await expect.poll(() => answered(ANSWERS[PRIYA_MORE]), { timeout: hostTimeout(30_000), interval: 100 }).toBe(true);
  await expect.poll(() => busy(), { timeout: hostTimeout(30_000), interval: 100 }).toBe(false);
}, hostTimeout(120_000));

it("three people: everyone sees whose lines wait, in order; each removes only their own; nobody else's waits steer her run", async () => {
  await priyaRuns();
  const stopsBefore = await personFirstStops();
  expect((await send(tom, TOM_ASK)).body.queued).toBe(true);
  expect((await send(sam, SAM_ASK)).body.queued).toBe(true);
  const waiting = await queue(priya);
  expect(waiting.map((item) => item.sender?.name)).toEqual(["Tom", "Sam"]);
  expect((await queue(sam)).map((item) => item.sender?.name)).toEqual(["Tom", "Sam"]);
  const [tomQueued, samQueued] = waiting;

  const notHis = await team.as(sam, "DELETE", `/api/bots/${botId}/queue/${tomQueued.queueId}`, { threadId: shared });
  expect(notHis.status, JSON.stringify(notHis.body)).toBe(403);
  const steerIn = await team.as(tom, "POST", `/api/bots/${botId}/queue/${tomQueued.queueId}/steer`, { threadId: shared });
  expect(steerIn.status, JSON.stringify(steerIn.body)).toBe(403);
  const priyaSteers = await team.as(priya, "POST", `/api/bots/${botId}/queue/${tomQueued.queueId}/steer`, { threadId: shared });
  expect(priyaSteers.status, JSON.stringify(priyaSteers.body)).toBe(403);
  const own = await team.as(sam, "DELETE", `/api/bots/${botId}/queue/${samQueued.queueId}`, { threadId: shared });
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  expect((await queue(tom)).map((item) => item.sender?.name)).toEqual(["Tom"]);

  await pastPersonFirst();
  expect(await personFirstStops()).toBe(stopsBefore);
  await release();
  expect(await answered(ANSWERS[TOM_ASK])).toBe(true);
  expect((await transcript(ada)).some((row) => row.role === "user" && row.text === SAM_ASK)).toBe(false);
}, hostTimeout(120_000));

it("her private chat is unchanged: her line is steered into her run and answered first", async () => {
  const opened = await team.as(priya, "POST", `/api/bots/${botId}/tasks`, { title: "Mine" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const mine = opened.body.task.threadId as string;
  await priyaRuns(mine);
  const more = await send(priya, PRIYA_MORE, mine);
  expect(more.body.steered).toBe(true);
  await expect.poll(() => personFirstStops(mine, priya), { timeout: hostTimeout(30_000), interval: 100 }).toBe(1);
  await expect.poll(() => answered(ANSWERS[PRIYA_MORE], mine, priya), { timeout: hostTimeout(30_000), interval: 100 }).toBe(true);
  await expect.poll(() => busy(mine, priya), { timeout: hostTimeout(30_000), interval: 100 }).toBe(false);
}, hostTimeout(120_000));

it("a routine run started mid-run neither steers nor stops her run, and Tom's line still runs after", async () => {
  const routine = await team.as(ada, "POST", "/api/routines", { name: "Pay check", prompt: "Check this week's pay runs.", botId,
    schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
  expect(routine.status, JSON.stringify(routine.body)).toBe(201);
  await priyaRuns();
  const stopsBefore = await personFirstStops();
  expect((await send(tom, TOM_ASK)).body.queued).toBe(true);
  const ran = await team.as(ada, "POST", `/api/routines/${routine.body.routine.id}/run`);
  expect(ran.status, JSON.stringify(ran.body)).toBe(201);
  await pastPersonFirst();
  expect(await busy()).toBe(true);
  expect(await personFirstStops()).toBe(stopsBefore);

  await release();
  await expect.poll(() => answered(ANSWERS[TOM_ASK]), { timeout: hostTimeout(60_000), interval: 100 }).toBe(true);
  const results = (ran.body.run.resultsThreadId as string | undefined) ?? shared;
  await expect.poll(() => answered("This week's pay runs are fine.", results), { timeout: hostTimeout(60_000), interval: 100 }).toBe(true);
  const rows = await transcript(ada);
  const last = (text: string) => rows.findLastIndex((row) => row.text?.includes(text));
  expect(rows[last(ANSWERS[PRIYA_ASK])].text, "the routine never reached her run").not.toContain("pay runs");
  expect(last(ANSWERS[PRIYA_ASK])).toBeLessThan(last(TOM_ASK));
  expect(last(TOM_ASK)).toBeLessThan(last(ANSWERS[TOM_ASK]));
  expect(rows.some((row) => row.role === "user" && row.text?.includes("pay runs")), "the routine ran in its own conversation").toBe(false);
}, hostTimeout(180_000));

it("a person with no name set is named as the People list names them, in the queue and in the refusal", async () => {
  await priyaRuns();
  expect((await send(dev, TOM_ASK)).body.queued).toBe(true);
  expect((await queue(priya)).map((item) => item.sender?.name)).toEqual(["Dev"]);
  await release();
  writeFileSync(home("tool-calls.json"), JSON.stringify([POLL]));
  rmSync(home("release"), { force: true });
  expect((await send(dev, SAM_ASK)).status).toBe(202);
  await expect.poll(() => busy(), { timeout: hostTimeout(30_000), interval: 100 }).toBe(true);
  const refused = await team.as(tom, "POST", `/api/bots/${botId}/interrupt`, { threadId: shared });
  expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  expect(refused.body.error).toBe("Only Dev or an admin can stop this.");
  const task = ((await team.as(tom, "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; tasks?: Array<{ threadId: string; askedBy?: { name: string } }> }>)
    .find((one) => one.id === botId)?.tasks?.find((one) => one.threadId === shared);
  expect(task?.askedBy?.name).toBe("Dev");
}, hostTimeout(120_000));
