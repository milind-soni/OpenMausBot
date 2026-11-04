// The same question from two teammates gets one answer, end to end on a Team Cloud. In Bob's private chat Scout asks
// Bolt for a migration estimate and has Quill look into it too; Quill asks Bolt the same while Bolt still works on it.
// Bolt answers once, Quill gets that answer, and Bolt's thread for Quill says why it ran no turn of its own. Olive asks
// Bolt the same from her own private chat while it still works on it: Bob's answer is never hers, so Bolt answers her
// separately. The engine is the synthetic Claude CLI playing a scripted plan through the real agents tools, so it proves
// the routing, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const ASK = "How many days would the database migration to the new hosting provider take, roughly?";
const ASKED_AGAIN = "How many days would the database migration to the new hosting provider take roughly";
const ANSWER = "About 15 working days, most of it testing.";
const JOINED = "Another teammate asked this a moment ago, so it was answered once, for both of you:";
const DONE = "Bolt estimates about 15 working days.";

type Bot = { id: string; name: string; threadId: string; tasks?: Array<{ threadId: string; title: string; busy?: boolean }> };
type Turn = { botId: string; turnIndex: number; system: string; prompt: unknown };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", bob = "";
let scout: Bot, quill: Bot, bolt: Bot, pip: Bot;

const planPath = () => join(team.home, "plan.json");
/** Bolt works on its answer until this file exists. */
const boltGo = () => join(team.home, "bolt-go");
const turns = (): Turn[] => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn) : [];
const create = async (body: Record<string, unknown>) => {
  const created = await team.as(olive, "POST", "/api/bots", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};
const messages = async (token: string, threadId: string) =>
  ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Array<{ text?: string; tool?: { name: string } }>;
const settled = async () => {
  const bots = (await team.as(olive, "GET", "/api/bots?messages=0")).body.bots as Array<{ busy?: boolean; waitingForTeammates?: boolean; tasks?: Array<{ busy?: boolean; waitingForTeammates?: boolean }> }>;
  return bots.every((one) => !one.busy && !(one.tasks ?? []).some((task) => task.busy || task.waitingForTeammates));
};
const boltRuns = () => turns().filter((turn) => turn.botId === bolt.id).length;
const boltTasks = async (token: string) =>
  ((await team.as(token, "GET", "/api/bots")).body.bots as Bot[]).find((bot) => bot.id === bolt.id)?.tasks ?? [];
/** The notes in Bolt's threads this person reads that a request waited for another's answer. */
const joinedNotes = async (token: string) => (await Promise.all((await boltTasks(token)).map((task) => messages(token, task.threadId).catch(() => []))))
  .flat().filter((message) => message.tool?.name.startsWith("notice: Another teammate asked the same a moment ago")).length;
const privateChat = async (token: string, bot: Bot, title: string) => {
  const opened = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body.task.threadId as string;
};

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-3", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  bob = (await team.pair(BOB)).token!;
  scout = await create({ name: "Scout", title: "Assistant", section: "Support", reportsTo: BOB.email });
  quill = await create({ name: "Quill", title: "Analyst", section: "Support", reportsTo: BOB.email });
  bolt = await create({ name: "Bolt", title: "Developer", section: "Dev", reportsTo: OLIVE.email });
  pip = await create({ name: "Pip", title: "Assistant", section: "Dev", reportsTo: OLIVE.email });
  writeFileSync(planPath(), JSON.stringify({
    [scout.id]: { turns: [
      { steps: [
        { arguments: { bot_ids: ["Bolt"], message: ASK, consult: true, reason: "Bob asked for the estimate" } },
        { arguments: { bot_ids: ["Quill"], message: "Get Bolt's estimate for the database migration too.", reason: "Bob asked Quill to look into it" } },
      ], reply: "Asked Bolt and Quill." },
      { reply: DONE },
    ] },
    [quill.id]: { turns: [
      { steps: [{ arguments: { bot_ids: ["Bolt"], message: ASKED_AGAIN, consult: true, reason: "Scout asked for Bolt's estimate" } }], reply: "Asked Bolt." },
      { reply: "Bolt's estimate is in." },
    ] },
    [pip.id]: { turns: [
      { steps: [{ arguments: { bot_ids: ["Bolt"], message: ASK, consult: true, reason: "Olive asked for the estimate" } }], reply: "Asked Bolt." },
      { reply: "Bolt answered." },
    ] },
    [bolt.id]: { reply: ANSWER, gateFile: boltGo() },
  }));
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("answers the same question from two of Bob's teammates once, and Olive's, which Bob's answer may not reach, on its own", async () => {
  const bobChat = await privateChat(bob, scout, "Migration estimate");
  const sent = await team.as(bob, "POST", `/api/bots/${scout.id}/messages`, { text: "How long will the migration take? Ask Bolt, and have Quill look too.", threadId: bobChat });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  // Quill asked while Bolt still works on Scout's question: its request waits for that answer.
  await expect.poll(() => joinedNotes(bob), { timeout: 90_000 }).toBe(1);

  const oliveChat = await privateChat(olive, pip, "Estimate");
  const asked = await team.as(olive, "POST", `/api/bots/${pip.id}/messages`, { text: "Ask Bolt how long the migration takes.", threadId: oliveChat });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  // Olive asks the same while Bolt still works on it, but Bob's answer is never hers: Bolt works on hers too.
  await expect.poll(async () => (await boltTasks(olive)).some((task) => task.busy), { timeout: 90_000 }).toBe(true);

  writeFileSync(boltGo(), "go");
  await expect.poll(async () => (await messages(bob, bobChat)).some((message) => message.text === DONE), { timeout: 90_000 }).toBe(true);
  await expect.poll(async () => (await messages(olive, oliveChat)).some((message) => message.text === "Bolt answered."), { timeout: 90_000 }).toBe(true);
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);

  expect(boltRuns(), "Bolt worked out the estimate once for Bob and once for Olive").toBe(2);
  const quillResumed = JSON.stringify(turns().find((turn) => turn.botId === quill.id && turn.turnIndex === 1)!.prompt);
  expect(quillResumed).toContain(JOINED);
  expect(quillResumed).toContain(ANSWER);
  const pipResumed = JSON.stringify(turns().find((turn) => turn.botId === pip.id && turn.turnIndex === 1)!.prompt);
  expect(pipResumed).toContain(ANSWER);
  expect(pipResumed).not.toContain(JOINED);
  expect(await joinedNotes(bob)).toBe(1);
  expect(await joinedNotes(olive)).toBe(0);
}, hostTimeout(240_000));
