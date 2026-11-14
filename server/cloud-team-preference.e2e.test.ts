// One preference for all of a person's bots on a Team Cloud, end to end. Bob tells Scout, in his private chat, that his
// reminders go to his task app: Scout saves that once in Bob's About me with memory_update action prefer and hands one
// piece of work to Quill, which saves another preference of Bob's from the work Bob's message handed on. Every bot reads
// both lines in Bob's work, nothing goes to each bot, and Olive's About me never changes. The engine is the synthetic
// Claude CLI playing a scripted plan through the real agents tools, so it proves where things land, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const REMINDERS = "Reminders go to the task app";
const STYLE = "Updates as short bullet points";
const ASK = "From now on my reminders go to my task app, for every bot. And have Quill draft Friday's update.";
const DONE = "Saved for every bot, and Quill's draft is in.";

type Bot = { id: string; name: string; threadId: string };
type Evidence = { step?: { tool?: string }; response?: { result?: { isError?: boolean; content?: Array<{ text: string }> } } };
type Turn = { botId: string; turnIndex: number; system: string; prompt: unknown; evidence: Evidence[] };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", bob = "";
let scout: Bot, quill: Bot;
let bobsChat = "";

const planPath = () => join(team.home, "plan.json");
const turns = (): Turn[] => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn) : [];
const create = async (body: Record<string, unknown>) => {
  const created = await team.as(olive, "POST", "/api/bots", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};
const aboutMe = async (token: string) => ((await team.as(token, "GET", "/api/me")).body.aboutMe ?? "") as string;
const preferResults = (turn: Turn) => turn.evidence.filter((entry) => entry.step?.tool === "memory_update").map((entry) => entry.response!.result!.content![0]!.text);
const settled = async () => {
  const bots = (await team.as(olive, "GET", "/api/bots?messages=0")).body.bots as Array<{ busy?: boolean; waitingForTeammates?: boolean; tasks?: Array<{ busy?: boolean; waitingForTeammates?: boolean }> }>;
  return bots.every((one) => !one.busy && !(one.tasks ?? []).some((task) => task.busy || task.waitingForTeammates));
};

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-2", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  bob = (await team.pair(BOB)).token!;
  expect((await team.as(bob, "PUT", "/api/me", { name: "Bob" })).status).toBe(200);
  scout = await create({ name: "Scout", title: "Assistant", section: "Support", reportsTo: BOB.email });
  quill = await create({ name: "Quill", title: "Writer", section: "Support", reportsTo: BOB.email });
  writeFileSync(planPath(), JSON.stringify({
    [scout.id]: { turns: [
      { steps: [
        { tool: "memory_update", arguments: { action: "prefer", text: REMINDERS } },
        { arguments: { bot_ids: ["Quill"], message: "Draft Friday's update for Bob.", reason: "Bob asked for Friday's update" } },
      ], reply: "Saved. Quill is drafting the update." },
      { reply: DONE },
    ] },
    [quill.id]: { turns: [
      { steps: [
        { tool: "memory_update", arguments: { action: "prefer", text: STYLE } },
        { tool: "propose_team_memory", expectError: true, arguments: { kind: "decision", name: "Update style", detail: STYLE } },
      ], reply: "Friday's update: shipped the inbox." },
    ] },
  }));
  const opened = await team.as(bob, "POST", `/api/bots/${scout.id}/tasks`, { title: "Preferences" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  bobsChat = opened.body.task.threadId;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("saves a preference once in Bob's About me, from his own chat and from work his message handed on, for every bot to read", async () => {
  const before = await aboutMe(olive);
  const sent = await team.as(bob, "POST", `/api/bots/${scout.id}/messages`, { text: ASK, threadId: bobsChat });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => ((await team.as(bob, "GET", `/api/threads/${bobsChat}/messages?limit=200`)).body.messages as Array<{ text?: string }>)
    .some((message) => message.text === DONE), { timeout: 60_000 }).toBe(true);
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);

  const asked = turns().find((turn) => turn.botId === scout.id && turn.turnIndex === 0)!;
  expect(preferResults(asked)).toEqual(["Saved in Bob's About me, which every bot reads in their work. Don't pass it on to other bots or save it in your own notes too."]);
  const handed = turns().find((turn) => turn.botId === quill.id)!;
  expect(preferResults(handed)).toEqual(["Saved in Bob's About me, which every bot reads in their work. Don't pass it on to other bots or save it in your own notes too."]);
  // Team memory stays closed to Bob's private work, and says where his own preference goes instead.
  const shared = handed.evidence.find((entry) => entry.step?.tool === "propose_team_memory")!.response!.result!;
  expect(shared.isError).toBe(true);
  expect(shared.content![0]!.text).toContain("A preference of the person's own goes in their About me with memory_update action=prefer.");

  const bobs = await aboutMe(bob);
  expect(bobs).toMatch(new RegExp(`· learned by Scout · ${REMINDERS}`));
  expect(bobs).toMatch(new RegExp(`· learned by Quill · ${STYLE}`));
  expect(await aboutMe(olive), "Olive's About me is hers alone").toBe(before);

  // The next turn in Bob's work reads both lines, with no bot told them one by one.
  const next = turns().find((turn) => turn.botId === scout.id && turn.turnIndex === 1)!;
  expect(next.system).toContain(REMINDERS);
  expect(next.system).toContain(STYLE);
  expect(turns().filter((turn) => turn.botId === quill.id)).toHaveLength(1);
}, hostTimeout(120_000));
