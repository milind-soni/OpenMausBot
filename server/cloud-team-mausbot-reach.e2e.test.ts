// A person's own MausBot hands work to the team's shared bots, on a Team Cloud with the synthetic Claude CLI. Mira (a
// User) asks her MausBot; the work runs in Sales' own private chat with her, at her level, and its result comes back whole
// to her private chat. Ben (a User) and Ada (an Admin) see none of it: not by id, not in lists, counts, search,
// notifications, streams, Sales' shared chat or its notes. A bot Mira cannot see is never named to her MausBot, a bot she
// can only view refuses work, and a turn her own request isn't behind hands nothing on. The engine plays a script through
// the real agents tools, so this proves the routes and what each person can see, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ADA = { email: "ada@acme.test", role: "admin" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const miraKey = personKey({ id: "", email: MIRA.email });
const SECRET = "Zebrafinch42";
const PRIVATE_NOTE = `Mira's commission is ${SECRET}`;
const ASK = `HAND-TO-SALES: pull the Q3 numbers for my commission review (${SECRET})`;

type Task = { threadId: string; title: string; private?: true };
type Bot = { id: string; name: string; threadId: string; mainThreadId: string; approvalMode?: string; unread?: boolean; defaultBot?: { person?: string }; tasks?: Task[] };
type Step = { step?: { tool?: string; arguments?: Record<string, unknown> }; response?: { error?: unknown; result?: { isError?: boolean; content?: Array<{ text: string }> } } };
type Turn = { botId: string; threadId: string; system: string; prompt: unknown; evidence: Step[]; planKey?: string };
type Line = { id: string; role: string; text?: string };

let fx: CloudSendFixture, team: CloudTeamFixture;
let ada = "", mira = "", ben = "";
let sales: Bot, archive: Bot, payroll: Bot, counsel: Bot, mausbot: Bot, mine = "";
let room = "";

const planPath = () => join(team.home, "plan.json");
const dataDir = (...rest: string[]) => join(team.home, ".openmausbot", ...rest);
const turns = (): Turn[] => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn) : [];
const turn = (key: string): Turn => { const found = turns().find((one) => one.planKey === key); if (!found) throw new Error(`no turn ${key}`); return found; };
const sent = (one: Turn): string => { const content = (one.prompt as { message?: { content?: unknown } }).message?.content; return typeof content === "string" ? content : JSON.stringify(content); };
const stepText = (entry: Step | undefined): string => JSON.stringify(entry?.response?.result?.content ?? entry?.response?.error ?? "");
const steps = (one: Turn) => one.evidence.filter((entry) => entry.step);
const refused = (key: string) => { const step = steps(turn(key))[0]!; expect(step.response?.result?.isError, `${key}: ${stepText(step)}`).toBe(true); return stepText(step); };
const lines = async (token: string, threadId: string) => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Line[];
const status = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=1`)).status;
const botsOf = async (token: string) => (await team.as(token, "GET", "/api/bots?messages=0")).body.bots as Bot[];
const settled = async () => (await Promise.all([ada, mira, ben].map(botsOf))).flat().every((one) => !(one as { busy?: boolean }).busy
  && !((one.tasks ?? []) as Array<{ busy?: boolean; waitingForTeammates?: boolean }>).some((task) => task.busy || task.waitingForTeammates));
async function say(text: string, threadId = mine, token = mira, bot: Bot = mausbot) {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const posted = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(posted.status, JSON.stringify(posted.body)).toBe(202);
}
const ran = (key: string) => expect.poll(() => turns().some((one) => one.planKey === key), { timeout: 60_000 }).toBe(true);
const handOn = (key: string, match: string, target: string, more: Record<string, unknown> = {}, expectError = false) => ({
  key, match: [match], reply: `${key} done`,
  steps: [{ arguments: { bot_ids: [target], message: `${key}: pull the numbers for Mira`, reason: "Mira asked", ...more }, ...(expectError ? { expectError: true } : {}) }],
});
async function workRows(): Promise<Array<Record<string, unknown>>> {
  const db = new DatabaseSync(dataDir("runtime.db"), { readOnly: true });
  try { return db.prepare("select * from assignments").all() as Array<Record<string, unknown>>; } finally { db.close(); }
}
async function listen(token: string) {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await expect.poll(() => text.includes("\"hello\""), { timeout: 10_000 }).toBe(true);
  return { text: () => text, close: async () => { controller.abort(); await done; } };
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-7", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  ada = (await team.pair(ADA)).token!;
  mira = (await team.pair(MIRA)).token!;
  ben = (await team.pair(BEN)).token!;
  for (const [token, name] of [[ada, "Ada"], [mira, "Mira"], [ben, "Ben"]] as const) expect((await team.as(token, "PUT", "/api/me", { name })).status).toBe(200);
  const create = async (name: string) => {
    const created = await team.as(ada, "POST", "/api/bots", { name, title: name, visibility: "everyone" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  const share = async (bot: Bot, access: { everyone: string; people: Record<string, string> }) =>
    expect((await team.as(ada, "PUT", `/api/bots/${bot.id}/access`, access)).status).toBe(200);
  sales = await create("Sales");
  archive = await create("Archive");
  payroll = await create("Payroll");
  counsel = await create("Counsel");
  await share(archive, { everyone: "view", people: {} });
  await share(payroll, { everyone: "none", people: { [BEN.email]: "chat" } });
  mausbot = (await botsOf(mira)).find((bot) => bot.defaultBot?.person === MIRA.email)!;
  expect(mausbot, "every member has their own MausBot").toBeDefined();
  const chat = await team.as(mira, "POST", `/api/bots/${mausbot.id}/tasks`, { title: "Mine" });
  expect(chat.status, JSON.stringify(chat.body)).toBe(201);
  mine = chat.body.task.threadId as string;
  const made = await team.as(ada, "POST", "/api/groups", { name: "All hands", memberIds: [sales.id] });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  room = (made.body.group as { id: string }).id;
  writeFileSync(planPath(), JSON.stringify({
    [mausbot.id]: { script: [
      { key: "M-LIST", match: ["WHO-CAN-YOU-REACH"], reply: "Listed.", steps: [{ tool: "list_bots", arguments: {} }] },
      { key: "M-SALES", match: ["HAND-TO-SALES"], reply: "Asked Sales.", steps: [{ arguments: { bot_ids: ["Sales"], message: ASK, reason: "Mira asked" } }] },
      { key: "M-RESUMED", repeat: true, match: ["report on assignment"], reply: "M-RESUMED done" },
      handOn("M-VIEW", "HAND-TO-ARCHIVE", "Archive", {}, true),
      handOn("M-HIDDEN-NAME", "HAND-TO-PAYROLL-NAME", "Payroll", {}, true),
      handOn("M-UNKNOWN-NAME", "HAND-TO-NOBODY-NAME", "Quokka", {}, true),
      { key: "M-HIDDEN-ID", match: ["HAND-TO-PAYROLL-ID"], reply: "done", steps: [{ arguments: { bot_ids: [payroll.id], message: "Pull the payroll", reason: "Mira asked" }, expectError: true }] },
      { key: "M-UNKNOWN-ID", match: ["HAND-TO-NOBODY-ID"], reply: "done", steps: [{ arguments: { bot_ids: ["bot_doesnotexist0"], message: "Pull the payroll", reason: "Mira asked" }, expectError: true }] },
      handOn("M-ROOM", "HAND-INTO-ROOM", "Sales", { group_id: room }, true),
      handOn("M-MAIN", "HAND-TO-MAIN-THREAD", "Sales", { thread: sales.threadId }, true),
      handOn("M-FROM-MAIN", "FROM-MY-MAIN-CHAT", "Sales"),
      handOn("M-RELAYED", "RELAYED-LINE", "Sales", {}, true),
      handOn("M-ROUTINE", "ROUTINE-LINE", "Sales", {}, true),
    ] },
    [sales.id]: { script: [
      { key: "S-FROM-MAIN", match: ["M-FROM-MAIN"], reply: "Sales: done from her main chat." },
      { key: "S-WORK", match: ["HAND-TO-SALES"], reply: `Sales: Q3 was 120k. Noted ${SECRET}.`, steps: [
        { tool: "memory_update", arguments: { action: "append", text: PRIVATE_NOTE } },
        { tool: "propose_team_memory", arguments: { kind: "decision", name: "Commission", detail: PRIVATE_NOTE }, expectError: true },
        { tool: "post_to_room", arguments: { group_id: room, message: PRIVATE_NOTE }, expectError: true },
      ] },
    ] },
    [counsel.id]: { script: [
      { key: "C-ASKS", match: ["BEN-ASKS-COUNSEL"], reply: "NEEDS INPUT: What is the password for the contract portal?" },
      { key: "C-CARRIES", repeat: true, match: ["FORGED-ANSWER"], reply: "C-CARRIES: carried on" },
    ] },
  }));
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("lists only the shared bots Mira may chat with, in its roster and in list_bots, and nothing of the rest", async () => {
  await say("WHO-CAN-YOU-REACH");
  await ran("M-LIST");
  const listed = turn("M-LIST");
  expect(listed.system).toContain("Sales");
  expect(listed.system).toContain("private chat with this person");
  for (const hidden of ["Payroll", payroll.id, "Archive", archive.id]) expect(listed.system).not.toContain(hidden);
  const names = stepText(steps(listed)[0]);
  expect(names).toContain(sales.id);
  expect(names).toContain(counsel.id);
  for (const hidden of ["Payroll", payroll.id, archive.id]) expect(names).not.toContain(hidden);
}, hostTimeout(90_000));

it("hands work to Sales privately: the result comes back to Mira whole, and Ben and the Admin see nothing of it anywhere", async () => {
  const before = Object.fromEntries(await Promise.all([["ada", ada], ["ben", ben]].map(async ([who, token]) => [who, (await botsOf(token!)).find((bot) => bot.id === sales.id)!.unread])));
  const streams = { ada: await listen(ada), ben: await listen(ben) };
  const miraStream = await listen(mira);
  await say(ASK);
  await ran("M-RESUMED");
  await expect.poll(async () => (await lines(mira, mine)).some((line) => line.text === "M-RESUMED done"), { timeout: 60_000 }).toBe(true);
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);

  const work = turn("S-WORK");
  expect(sent(work)).toMatch(/\[From @MausBot \(bot\) · assignment \S+ for Mira · on their behalf at your level\]/);
  expect(sent(turn("M-RESUMED")), "her result comes back whole: this is her own chat").toContain("Q3 was 120k");
  const seen = (await botsOf(mira)).find((bot) => bot.id === sales.id)!.tasks!.find((task) => task.threadId === work.threadId)!;
  expect(seen, "Sales' chat with Mira is listed for her").toBeDefined();
  expect(seen.private).toBe(true);
  expect(await status(mira, work.threadId)).toBe(200);
  expect(JSON.stringify(miraStream.text())).toContain(work.threadId);

  for (const [who, token] of [["ada", ada], ["ben", ben]] as const) {
    expect(await status(token, work.threadId), who).toBe(404);
    expect(await status(token, mine), who).toBe(404);
    const salesCopy = (await botsOf(token)).find((bot) => bot.id === sales.id)!;
    expect(salesCopy.tasks!.map((task) => task.threadId), who).not.toContain(work.threadId);
    expect(salesCopy.unread, `${who}: Sales' unread mark`).toBe(before[who]);
    expect(JSON.stringify(await lines(token, sales.threadId)), `${who}: Sales' shared chat`).not.toContain(SECRET);
    for (const route of ["/api/bots", `/api/search?q=${SECRET}`, "/api/notifications", "/api/today", "/api/needs-you", "/api/inbox", `/api/bots/${sales.id}/memory/mine`, `/api/bots/${sales.id}/activity`]) {
      const answer = await team.as(token, "GET", route);
      expect(answer.status, `${who}: ${route}`).toBeLessThan(500);
      expect(JSON.stringify(answer.body), `${who}: ${route}`).not.toContain(SECRET);
      expect(JSON.stringify(answer.body), `${who}: ${route}`).not.toContain(work.threadId);
    }
    expect(streams[who].text(), `${who}: event stream`).not.toContain(SECRET);
    expect(streams[who].text(), `${who}: event stream`).not.toContain(work.threadId);
  }
  for (const stream of [...Object.values(streams), miraStream]) await stream.close();

  // Sales could not take it into a room or the team's notes, and its note landed in Mira's layer alone.
  const [noted, teamMemory, roomPost] = steps(work);
  expect(noted!.response?.result?.isError).toBeFalsy();
  expect(teamMemory!.response?.result?.isError).toBe(true);
  expect(roomPost!.response?.result?.isError).toBe(true);
  expect(readFileSync(dataDir("workspaces", `${sales.id}--member-${miraKey}`, "MEMORY.md"), "utf8")).toContain(PRIVATE_NOTE);
  const teamNotes = dataDir("workspaces", sales.id, "MEMORY.md");
  expect(existsSync(teamNotes) ? readFileSync(teamNotes, "utf8") : "").not.toContain(SECRET);
  expect(existsSync(dataDir("workspaces", `${sales.id}--member-${personKey({ id: "", email: BEN.email })}`, "MEMORY.md"))).toBe(false);

  // The work acts for her and nobody else.
  const handed = JSON.parse(readFileSync(dataDir("handed-people.json"), "utf8")) as { work: Record<string, { person: string }> };
  const row = (await workRows()).find((one) => one.assignee_thread_id === work.threadId)!;
  expect(handed.work[String(row.id)]?.person).toBe(miraKey);
}, hostTimeout(180_000));

it("a bot Mira cannot see is refused exactly like one that does not exist, by name and by id, and runs nothing", async () => {
  for (const [text, key] of [["HAND-TO-PAYROLL-NAME", "M-HIDDEN-NAME"], ["HAND-TO-NOBODY-NAME", "M-UNKNOWN-NAME"], ["HAND-TO-PAYROLL-ID", "M-HIDDEN-ID"], ["HAND-TO-NOBODY-ID", "M-UNKNOWN-ID"]] as const) {
    await say(text);
    await ran(key);
  }
  const byName = refused("M-HIDDEN-NAME"), unknownName = refused("M-UNKNOWN-NAME");
  expect(byName.replaceAll("Payroll", "X")).toBe(unknownName.replaceAll("Quokka", "X"));
  const byId = refused("M-HIDDEN-ID"), unknownId = refused("M-UNKNOWN-ID");
  expect(byId.replaceAll(payroll.id, "X")).toBe(unknownId.replaceAll("bot_doesnotexist0", "X"));
  for (const said of [byName, byId]) for (const leak of ["Ben", "Ada", "looks after", "admin"]) expect(said).not.toContain(leak);
  expect(byId).not.toContain("Payroll");
  expect(turns().filter((one) => one.botId === payroll.id)).toEqual([]);
}, hostTimeout(150_000));

it("a bot Mira can only view refuses work, and says so plainly", async () => {
  await say("HAND-TO-ARCHIVE");
  await ran("M-VIEW");
  expect(refused("M-VIEW")).toContain("view only");
  expect(turns().filter((one) => one.botId === archive.id)).toEqual([]);
}, hostTimeout(90_000));

it("never into a room, nor into Sales' shared chat", async () => {
  for (const [text, key] of [["HAND-INTO-ROOM", "M-ROOM"], ["HAND-TO-MAIN-THREAD", "M-MAIN"]] as const) {
    await say(text);
    await ran(key);
    refused(key);
  }
  expect(JSON.stringify(await lines(ada, sales.threadId))).not.toContain("pull the numbers for Mira");
}, hostTimeout(120_000));

it("works from her MausBot's main chat too, which is hers alone", async () => {
  const main = (await botsOf(mira)).find((bot) => bot.id === mausbot.id)!.mainThreadId;
  expect(main).toBeTruthy();
  await say("FROM-MY-MAIN-CHAT", main);
  await ran("S-FROM-MAIN");
  const work = turn("S-FROM-MAIN");
  expect(await status(mira, work.threadId)).toBe(200);
  expect(await status(ada, work.threadId)).toBe(404);
  expect(await status(ben, work.threadId)).toBe(404);
}, hostTimeout(90_000));

it("a line another app relays into her private chat hands nothing on", async () => {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const leaf = (await team.as(mira, "GET", `/api/threads/${mine}/messages?limit=1`)).body.activeLeafId ?? null;
  const mode = (await botsOf(mira)).find((bot) => bot.id === mausbot.id)!.approvalMode ?? "ask";
  const relayed = await fetch(`${team.base}/api/bots/${mausbot.id}/messages/guarded`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: mine, sendId: "slackjob_mausbot_reach_1", text: "RELAYED-LINE", expectedActiveLeafId: leaf, expectedApprovalMode: mode, onBehalfOf: { email: MIRA.email, name: "Mira" } }),
  });
  expect(relayed.status, await relayed.clone().text()).toBe(202);
  await ran("M-RELAYED");
  refused("M-RELAYED");
  expect(turns().filter((one) => one.botId === sales.id && sent(one).includes("M-RELAYED"))).toEqual([]);
}, hostTimeout(90_000));

it("her routine, with nobody behind it, hands nothing on", async () => {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const created = await team.as(mira, "POST", "/api/routines", { name: "Nightly", prompt: "ROUTINE-LINE", botId: mausbot.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await team.as(mira, "POST", `/api/routines/${created.body.routine.id}/run`)).status).toBe(201);
  await ran("M-ROUTINE");
  refused("M-ROUTINE");
  expect(turns().filter((one) => one.botId === sales.id && sent(one).includes("M-ROUTINE"))).toEqual([]);
}, hostTimeout(90_000));

it("cannot answer a question waiting in Ben's private work, even knowing its id", async () => {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const bensMausbot = (await botsOf(ben)).find((bot) => bot.defaultBot?.person === BEN.email)!;
  const bensChat = (await team.as(ben, "POST", `/api/bots/${bensMausbot.id}/tasks`, { title: "Mine" })).body.task.threadId as string;
  const plan = JSON.parse(readFileSync(planPath(), "utf8"));
  plan[bensMausbot.id] = { script: [{ key: "B-ASKS", match: ["BEN-HANDS-ON"], reply: "Asking.", steps: [{ arguments: { bot_ids: ["Counsel"], message: "BEN-ASKS-COUNSEL", reason: "Ben asked" } }] }, { key: "B-RESUMED", repeat: true, match: ["on assignment"], reply: "B-RESUMED done" }] };
  writeFileSync(planPath(), JSON.stringify(plan));
  await say("BEN-HANDS-ON", bensChat, ben, bensMausbot);
  await ran("C-ASKS");
  await expect.poll(async () => (await workRows()).some((row) => row.status === "needs_input"), { timeout: 60_000 }).toBe(true);
  const waiting = (await workRows()).find((row) => row.status === "needs_input")!;

  const later = JSON.parse(readFileSync(planPath(), "utf8"));
  later[mausbot.id].script.push({ key: "M-ANSWERS", match: ["ANSWER-BENS-QUESTION"], reply: "M-ANSWERS done",
    steps: [{ arguments: { bot_ids: ["Counsel"], message: "FORGED-ANSWER contract B", reason: "Mira answers", answers: String(waiting.id) }, expectError: true }] });
  writeFileSync(planPath(), JSON.stringify(later));
  await expect.poll(async () => (await workRows()).find((row) => row.id === waiting.id)?.status, { timeout: 30_000 }).toBe("needs_input");
  const posted = await team.as(mira, "POST", `/api/bots/${mausbot.id}/messages`, { text: "ANSWER-BENS-QUESTION", threadId: mine });
  expect(posted.status, JSON.stringify(posted.body)).toBe(202);
  await ran("M-ANSWERS");
  refused("M-ANSWERS");
  expect((await workRows()).find((row) => row.id === waiting.id)!.status).toBe("needs_input");
  expect(turns().some((one) => one.planKey === "C-CARRIES")).toBe(false);
}, hostTimeout(180_000));
