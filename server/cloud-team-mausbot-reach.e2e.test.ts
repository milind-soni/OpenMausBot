// A person's own MausBot hands work to the team's shared bots from their private chat, on a Team Cloud with the synthetic
// Claude CLI: the work runs in a thread private to them, follows the bot's sharing level for them, never reaches a room,
// the team's notes or another member, no admin can open it, and a turn with no person behind it cannot do this. The engine
// plays a script through the real agents tools, so this proves the routes and what each person can see, not a model's
// judgement, not the bot box (a shell reading another layer's files) and not Windows.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const miraKey = personKey({ id: "", email: MIRA.email });
const PRIVATE_NOTE = "Mira's commission is Zebrafinch42";

type Task = { threadId: string; title: string; private?: true; inbox?: true };
type Bot = { id: string; name: string; threadId: string; mainThreadId: string; approvalMode?: string; defaultBot?: { person?: string }; tasks?: Task[] };
type Step = { step?: { tool?: string; arguments?: Record<string, unknown> }; response?: { error?: unknown; result?: { isError?: boolean; content?: Array<{ text: string }> } } };
type Turn = { botId: string; threadId: string; system: string; prompt: unknown; evidence: Step[]; planKey?: string; unplanned?: true };
type Line = { id: string; role: string; text?: string; card?: { answered?: string; requestId?: string; subtitle?: string; title?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", mira = "", ben = "";
let sales: Bot, archive: Bot, payroll: Bot, counsel: Bot, mausbot: Bot, inbox = "";
let room = "", roomThread = "";

const planPath = () => join(team.home, "plan.json");
const dataDir = (...rest: string[]) => join(team.home, ".openmausbot", ...rest);
const turns = (): Turn[] => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn) : [];
const turn = (key: string): Turn => { const found = turns().find((one) => one.planKey === key); if (!found) throw new Error(`no turn ${key}: ${JSON.stringify(turns().map((one) => one.planKey ?? one.botId))}`); return found; };
const sent = (one: Turn): string => { const content = (one.prompt as { message?: { content?: unknown } }).message?.content; return typeof content === "string" ? content : JSON.stringify(content); };
const stepText = (entry: Step | undefined): string => JSON.stringify(entry?.response?.result?.content ?? entry?.response?.error ?? "");
const steps = (one: Turn) => one.evidence.filter((entry) => entry.step);
const lines = async (token: string, threadId: string) => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Line[];
const status = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=1`)).status;
const botsOf = async (token: string) => (await team.as(token, "GET", "/api/bots?messages=0")).body.bots as Bot[];
const settled = async () => (await Promise.all([olive, mira, ben].map(botsOf))).flat().every((one) => !(one as { busy?: boolean }).busy
  && !((one.tasks ?? []) as Array<{ busy?: boolean; waitingForTeammates?: boolean }>).some((task) => task.busy || task.waitingForTeammates));
async function say(text: string, threadId = inbox, token = mira, bot: Bot = mausbot) {
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

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-5", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  mira = (await team.pair(MIRA)).token!;
  ben = (await team.pair(BEN)).token!;
  for (const [token, name] of [[olive, "Olive"], [mira, "Mira"], [ben, "Ben"]] as const) expect((await team.as(token, "PUT", "/api/me", { name })).status).toBe(200);
  const create = async (name: string) => {
    const created = await team.as(olive, "POST", "/api/bots", { name, title: name });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  const share = async (bot: Bot, access: { everyone: string; people: Record<string, string> }) =>
    expect((await team.as(olive, "PUT", `/api/bots/${bot.id}/access`, access)).status).toBe(200);
  sales = await create("Sales");
  archive = await create("Archive");
  payroll = await create("Payroll");
  counsel = await create("Counsel");
  await share(archive, { everyone: "view", people: {} });
  await share(payroll, { everyone: "none", people: { [BEN.email]: "chat" } });
  mausbot = (await botsOf(mira)).find((bot) => bot.defaultBot)!;
  expect(mausbot, "every member has their own MausBot").toBeDefined();
  const chat = await team.as(mira, "POST", `/api/bots/${mausbot.id}/tasks`, { title: "Mine" });
  expect(chat.status, JSON.stringify(chat.body)).toBe(201);
  inbox = chat.body.task.threadId as string;
  const made = await team.as(olive, "POST", "/api/groups", { name: "All hands", memberIds: [sales.id] });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  room = (made.body.group as { id: string }).id;
  roomThread = (made.body.group as { threadId: string }).threadId;
  writeFileSync(planPath(), JSON.stringify({
    [mausbot.id]: { script: [
      { key: "M-LIST", match: ["WHO-CAN-YOU-REACH"], reply: "Listed.", steps: [{ tool: "list_bots", arguments: {} }] },
      handOn("M-SALES", "HAND-TO-SALES", "Sales"),
      { key: "M-RESUMED", repeat: true, match: ["report on assignment"], reply: "M-RESUMED done" },
      handOn("M-VIEW", "HAND-TO-ARCHIVE", "Archive", {}, true),
      handOn("M-NONE-NAME", "HAND-TO-PAYROLL-NAME", "Payroll", {}, true),
      { key: "M-NONE-ID", match: ["HAND-TO-PAYROLL-ID"], reply: "M-NONE-ID done", steps: [{ arguments: { bot_ids: [payroll.id], message: "Pull the payroll", reason: "Mira asked" }, expectError: true }] },
      handOn("M-ROOM", "HAND-INTO-ROOM", "Sales", { group_id: room }, true),
      handOn("M-MAIN", "HAND-TO-MAIN-THREAD", "Sales", { thread: sales.threadId }, true),
      handOn("M-SHARED", "FROM-MY-MAIN-CHAT", "Sales"),
      handOn("M-HELD-RELAY", "HELD-RELAY", "Sales", {}, true),
      handOn("M-HELD-LATER", "HELD-LATER", "Sales", {}, true),
      handOn("M-RELAYED", "RELAYED-LINE", "Sales", {}, true),
      handOn("M-ROUTINE", "ROUTINE-LINE", "Sales", {}, true),
    ] },
    [sales.id]: { script: [
      { key: "S-SHARED", match: ["M-SHARED"], reply: "Sales: done from her main chat." },
      { key: "S-WORK", match: ["M-SALES"], reply: "Sales: Q3 was 120k.", steps: [
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

it("lists the shared bots its person may chat with, and only those, in the roster and in list_bots", async () => {
  await say("WHO-CAN-YOU-REACH");
  await ran("M-LIST");
  const listed = turn("M-LIST");
  expect(listed.system).toContain("Sales");
  expect(listed.system).not.toContain("Payroll");
  expect(listed.system).not.toContain("Archive");
  const names = stepText(steps(listed)[0]);
  expect(names).toContain(sales.id);
  expect(names).not.toContain(payroll.id);
  expect(names).not.toContain(archive.id);
}, hostTimeout(90_000));

it("private hand-off: the work runs in a thread only Mira can open, nothing reaches a room or the team's notes, and no admin or member can see it", async () => {
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);
  await say("HAND-TO-SALES");
  await ran("M-RESUMED");
  await expect.poll(async () => (await lines(mira, inbox)).some((line) => line.text === "M-RESUMED done"), { timeout: 60_000 }).toBe(true);
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);

  const work = turn("S-WORK");
  expect(sent(work)).toMatch(/\[From @MausBot \(bot\) · assignment \S+ for Mira · on their behalf at your level\]/);
  // Her report comes back whole: this is her own chat.
  expect(sent(turn("M-RESUMED"))).toContain("Q3 was 120k");
  const seenByMira = (await botsOf(mira)).find((bot) => bot.id === sales.id)!.tasks!.find((task) => task.threadId === work.threadId)!;
  expect(seenByMira).toBeDefined();
  expect(seenByMira.private).toBe(true);

  // No admin and no other member can open it, list it or read its words.
  expect(await status(mira, work.threadId)).toBe(200);
  expect(await status(olive, work.threadId), "the Owner").toBe(404);
  expect(await status(ben, work.threadId), "another member").toBe(404);
  for (const token of [olive, ben]) {
    expect((await botsOf(token)).find((bot) => bot.id === sales.id)!.tasks!.map((task) => task.threadId)).not.toContain(work.threadId);
    expect(JSON.stringify(await lines(token, sales.threadId))).not.toContain("Q3 was 120k");
  }

  // Sales' tools refused the room and the team's notes, and its note landed in Mira's layer, not the team's.
  const [noted, teamMemory, roomPost] = steps(work);
  expect(noted!.response?.result?.isError).toBeFalsy();
  expect(teamMemory!.response?.result?.isError).toBe(true);
  expect(roomPost!.response?.result?.isError).toBe(true);
  expect(stepText(roomPost)).toContain("private chat");
  expect(readFileSync(dataDir("workspaces", `${sales.id}--member-${miraKey}`, "MEMORY.md"), "utf8")).toContain(PRIVATE_NOTE);
  const teamNotes = dataDir("workspaces", sales.id, "MEMORY.md");
  expect(existsSync(teamNotes) ? readFileSync(teamNotes, "utf8") : "").not.toContain(PRIVATE_NOTE);
  expect(JSON.stringify(await lines(olive, roomThread))).not.toContain(PRIVATE_NOTE);

  // The work acts for her and nobody else.
  const handed = JSON.parse(readFileSync(dataDir("handed-people.json"), "utf8")) as { work: Record<string, { person: string }> };
  const row = (await workRows()).find((one) => one.assignee_thread_id === work.threadId)!;
  expect(handed.work[String(row.id)]?.person).toBe(miraKey);
}, hostTimeout(180_000));

it("private hand-off: refuses a room and the bot's main chat", async () => {
  for (const [text, key] of [["HAND-INTO-ROOM", "M-ROOM"], ["HAND-TO-MAIN-THREAD", "M-MAIN"]] as const) {
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    await say(text);
    await ran(key);
    expect(steps(turn(key))[0]!.response?.result?.isError, key).toBe(true);
  }
  expect(JSON.stringify(await lines(olive, sales.threadId))).not.toContain("pull the numbers for Mira");
}, hostTimeout(120_000));

it("sharing level: a bot she can only view, or isn't shared with, is refused by name and by id, and runs nothing", async () => {
  for (const [text, key] of [["HAND-TO-ARCHIVE", "M-VIEW"], ["HAND-TO-PAYROLL-NAME", "M-NONE-NAME"], ["HAND-TO-PAYROLL-ID", "M-NONE-ID"]] as const) {
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    await say(text);
    await ran(key);
    expect(steps(turn(key))[0]!.response?.result?.isError, key).toBe(true);
  }
  expect(turns().filter((one) => one.botId === archive.id || one.botId === payroll.id)).toEqual([]);
}, hostTimeout(120_000));

it("audience: from her MausBot's main chat too, which is hers alone", async () => {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const main = ((await team.as(mira, "GET", "/api/bots")).body.bots as Bot[]).find((bot) => bot.id === mausbot.id)!.mainThreadId;
  expect(main).toBeTruthy();
  expect(main).not.toBe(inbox);
  await say("FROM-MY-MAIN-CHAT", main);
  await ran("M-SHARED");
  expect(steps(turn("M-SHARED"))[0]!.response?.result?.isError).toBeFalsy();
  expect(turn("M-SHARED").system).not.toContain("start a new conversation with you");
  await ran("S-SHARED");
  const work = turn("S-SHARED");
  expect(await status(mira, work.threadId)).toBe(200);
  expect(await status(olive, work.threadId), "the Owner").toBe(404);
  expect(await status(ben, work.threadId), "another member").toBe(404);
}, hostTimeout(90_000));

it("outside-driven: a line another app relays into her private chat cannot hand work on", async () => {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const leaf = (await team.as(mira, "GET", `/api/threads/${inbox}/messages?limit=1`)).body.activeLeafId ?? null;
  const mode = (await botsOf(mira)).find((bot) => bot.id === mausbot.id)!.approvalMode ?? "ask";
  const relayed = await fetch(`${team.base}/api/bots/${mausbot.id}/messages/guarded`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: inbox, sendId: "slackjob_mausbot_reach_1", text: "RELAYED-LINE", expectedActiveLeafId: leaf, expectedApprovalMode: mode, onBehalfOf: { email: MIRA.email, name: "Mira" } }),
  });
  expect(relayed.status, await relayed.clone().text()).toBe(202);
  await ran("M-RELAYED");
  expect(steps(turn("M-RELAYED"))[0]!.response?.result?.isError).toBe(true);
}, hostTimeout(90_000));

it("outside-driven: the chat outside work reached is not the person's own, so their later line there hands nothing on", async () => {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  // Only an admin makes a webhook. Its results chat is not private to her, and outside work reached it: two reasons to refuse.
  const own = (await botsOf(olive)).find((bot) => bot.defaultBot?.person === OLIVE.email)!;
  const plan = JSON.parse(readFileSync(planPath(), "utf8"));
  plan[own.id] = { script: [
    { key: "O-HOOK", repeat: true, match: ["hook-payload-77"], reply: "Handled the event." },
    handOn("O-LATER", "OLIVE-LATER", "Sales", {}, true),
  ] };
  writeFileSync(planPath(), JSON.stringify(plan));
  const hook = (await team.as(olive, "POST", "/api/webhooks", { name: "Inbound", prompt: "Handle the event.", botId: own.id })).body;
  const receiver = team.base.replace(/:(\d+)$/, (_: string, port: string) => `:${Number(port) + 1}`);
  const delivered = await fetch(`${receiver}/hooks/${hook.webhook.endpointId}/${encodeURIComponent(hook.credential.secret)}`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomBytes(6).toString("hex") }, body: JSON.stringify({ text: "hook-payload-77" }) });
  expect(delivered.status).toBe(202);
  await ran("O-HOOK");
  await expect.poll(settled, { timeout: 60_000 }).toBe(true);
  const results = await expect.poll(async () => (await botsOf(olive)).find((bot) => bot.id === own.id)?.tasks?.find((task) => task.title === "Inbound · Results")?.threadId,
    { timeout: 30_000 }).toBeTruthy().then(async () => (await botsOf(olive)).find((bot) => bot.id === own.id)!.tasks!.find((task) => task.title === "Inbound · Results")!.threadId);
  await say("OLIVE-LATER", results, olive, own);
  await ran("O-LATER");
  expect(steps(turn("O-LATER"))[0]!.response?.result?.isError).toBe(true);
  expect(turns().filter((one) => one.botId === sales.id && sent(one).includes("O-LATER"))).toEqual([]);
}, hostTimeout(150_000));

it("outside-driven: her routine, with nobody present, cannot hand work on", async () => {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const created = await team.as(mira, "POST", "/api/routines", { name: "Nightly", prompt: "ROUTINE-LINE", botId: mausbot.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await team.as(mira, "POST", `/api/routines/${created.body.routine.id}/run`)).status).toBe(201);
  await ran("M-ROUTINE");
  expect(steps(turn("M-ROUTINE"))[0]!.response?.result?.isError).toBe(true);
}, hostTimeout(90_000));

it("answering: cannot answer a question waiting in another member's private thread, even knowing its id", async () => {
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const benChat = await team.as(ben, "POST", `/api/bots/${counsel.id}/tasks`, { title: "Contract" });
  expect(benChat.status).toBe(201);
  const benThread = benChat.body.task.threadId as string;
  const bensMausbot = (await botsOf(ben)).find((bot) => bot.defaultBot)!;
  const bensChat = (await team.as(ben, "POST", `/api/bots/${bensMausbot.id}/tasks`, { title: "Mine" })).body.task.threadId as string;
  const plan = JSON.parse(readFileSync(planPath(), "utf8"));
  plan[bensMausbot.id] = { script: [{ key: "B-ASKS", match: ["BEN-HANDS-ON"], reply: "Asking.", steps: [{ arguments: { bot_ids: ["Counsel"], message: "BEN-ASKS-COUNSEL", reason: "Ben asked" } }] }, { key: "B-RESUMED", repeat: true, match: ["on assignment"], reply: "B-RESUMED done" }] };
  writeFileSync(planPath(), JSON.stringify(plan));
  await say("BEN-HANDS-ON", bensChat, ben, bensMausbot);
  await ran("C-ASKS");
  await expect.poll(async () => (await workRows()).some((row) => row.status === "needs_input"), { timeout: 60_000 }).toBe(true);
  const waiting = (await workRows()).find((row) => row.status === "needs_input")!;
  expect(benThread).toBeTruthy();

  const later = JSON.parse(readFileSync(planPath(), "utf8"));
  later[mausbot.id].script.push({ key: "M-ANSWERS", match: ["ANSWER-BENS-QUESTION"], reply: "M-ANSWERS done",
    steps: [{ arguments: { bot_ids: ["Counsel"], message: "FORGED-ANSWER contract B", reason: "Mira answers", answers: String(waiting.id) }, expectError: true }] });
  writeFileSync(planPath(), JSON.stringify(later));
  await say("ANSWER-BENS-QUESTION");
  await ran("M-ANSWERS");
  expect(steps(turn("M-ANSWERS"))[0]!.response?.result?.isError).toBe(true);
  expect((await workRows()).find((row) => row.id === waiting.id)!.status).toBe("needs_input");
  expect(turns().some((one) => one.planKey === "C-CARRIES")).toBe(false);
}, hostTimeout(180_000));
