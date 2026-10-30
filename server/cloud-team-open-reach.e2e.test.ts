// Every bot reaches every bot on a Team Cloud, end to end. Acme's Support has Scout and Quill, which report to Bob, a
// member with a Chief of Staff of his own; Dev has Bolt, which reports to Olive. In Bob's private chat he asks Scout to
// write to Bolt; Scout asks Bolt and Bolt's answer comes back to that chat, with nothing set up first. The chat stays
// Bob's alone, his Chief still supervises only his own bots, and nothing from his private chat goes into a room. The
// engine is the synthetic Claude CLI playing a scripted plan through the real agents tools, so it proves the routing,
// not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const ASK = "can you write @Bolt please, and ask him if we can upgrade to the latest PHP version?";
const ANSWER = "Yes: we can upgrade to the latest PHP version. Our code already runs on it.";
const RELAYED = "Bolt says yes: we can upgrade to the latest PHP version, our code already runs on it.";

type Bot = { id: string; name: string; threadId: string };
type Message = { role: string; kind?: string; text?: string; tool?: { name: string; ok?: boolean }; threadRef?: { botId: string; threadId: string } };
type Turn = { botId: string; turnIndex: number; system: string; prompt: unknown; evidence: Array<{ step?: unknown; response?: { result?: { isError?: boolean; content?: Array<{ text: string }> } }; result?: { content?: Array<{ text: string }> } }> };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", bob = "";
let scout: Bot, quill: Bot, bolt: Bot, chief: Bot;
let room: { id: string; threadId: string };
let bobsChat = "";

const planPath = () => join(team.home, "plan.json");
const turns = (): Turn[] => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn) : [];
const messages = async (token: string, threadId: string) => {
  const read = await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
  return { status: read.status, messages: (read.body.messages ?? []) as Message[] };
};
const create = async (body: Record<string, unknown>) => {
  const created = await team.as(olive, "POST", "/api/bots", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};
const settled = async () => {
  const bots = (await team.as(olive, "GET", "/api/bots?messages=0")).body.bots as Array<{ busy?: boolean; waitingForTeammates?: boolean; tasks?: Array<{ busy?: boolean; waitingForTeammates?: boolean }> }>;
  return bots.every((one) => !one.busy && !(one.tasks ?? []).some((task) => task.busy || task.waitingForTeammates));
};

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  bob = (await team.pair(BOB)).token!;
  scout = await create({ name: "Scout", title: "Support agent", section: "Support", reportsTo: BOB.email });
  quill = await create({ name: "Quill", title: "Support writer", section: "Support", reportsTo: BOB.email });
  bolt = await create({ name: "Bolt", title: "Developer", section: "Dev", reportsTo: OLIVE.email });
  chief = await create({ name: "Bob's Chief", reportsTo: BOB.email });
  expect((await team.as(olive, "PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
  const made = await team.as(olive, "POST", "/api/groups", { name: "Launch", memberIds: [scout.id, bolt.id], section: "Support",
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: scout.id } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  room = made.body.group;
  writeFileSync(planPath(), JSON.stringify({
    [scout.id]: { turns: [
      { steps: [{ arguments: { bot_ids: ["Bolt"], message: "Can we upgrade to the latest PHP version?", consult: true, reason: "Bob asked about upgrading PHP" } }], reply: "I've asked Bolt; I'll tell you what he says." },
      { reply: RELAYED },
      { steps: [
        { expectError: true, arguments: { group_id: room.id, bot_ids: ["Bolt"], message: "Bob's PHP question, for the room" } },
        { tool: "post_to_room", expectError: true, arguments: { group_id: room.id, message: "Bob's PHP question, for the room" } },
      ], reply: "That stays here: I can't post your private chat into a room." },
    ] },
    [bolt.id]: { reply: ANSWER },
  }));
  const opened = await team.as(bob, "POST", `/api/bots/${scout.id}/tasks`, { title: "PHP upgrade" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  bobsChat = opened.body.task.threadId;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("lets Scout, in Bob's private chat, ask Bolt in another department and brings Bolt's answer back", async () => {
  const sent = await team.as(bob, "POST", `/api/bots/${scout.id}/messages`, { text: ASK, threadId: bobsChat });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => (await messages(bob, bobsChat)).messages.some((message) => message.text === RELAYED), { timeout: 60_000 }).toBe(true);
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);

  const asked = turns().find((turn) => turn.botId === scout.id && turn.turnIndex === 0)!;
  expect(asked.system).toContain("You can reach every other bot on this team, in every department");
  expect(asked.system).toContain(`- Bolt — Developer (Dev) [id: ${bolt.id}]`);
  expect(asked.system).toContain(`- Quill — Support writer (Support) [id: ${quill.id}]`);
  expect(asked.system).toContain(`[Chief of Staff] [id: ${chief.id}]`);
  expect(asked.system).not.toMatch(/allowed peer|team membership/i);
  expect(`${asked.system}\n${JSON.stringify(asked.prompt)}`).toContain(`The user named these existing teammates: Bolt (${bolt.id})`);
  const handoff = asked.evidence.find((entry) => entry.step)!.response!.result!;
  expect(handoff.isError).toBeFalsy();
  expect(handoff.content![0]!.text).toContain("Bolt");

  const answered = turns().find((turn) => turn.botId === bolt.id)!;
  expect(answered).toBeTruthy();

  const chat = (await messages(bob, bobsChat)).messages;
  const chip = chat.find((message) => message.kind === "activity" && message.tool?.name === "Sent to Bolt");
  expect(chip?.tool?.ok).toBe(true);
  expect(chip?.threadRef?.botId).toBe(bolt.id);
  expect(chat.findIndex((message) => message.text === RELAYED)).toBeGreaterThan(chat.indexOf(chip!));

  // Bob's chat and the question it sent Bolt stay Bob's: Olive, who owns Bolt and the team, reads neither.
  const boltThread = chip!.threadRef!.threadId;
  expect((await messages(bob, boltThread)).messages.some((message) => message.text === ANSWER)).toBe(true);
  expect((await messages(olive, boltThread)).status).toBe(404);
  expect((await messages(olive, bobsChat)).status).toBe(404);
}, hostTimeout(120_000));

it("keeps Bob's Chief supervising only Bob's bots, while it can reach Bolt too", async () => {
  const before = turns().length;
  const sent = await team.as(bob, "POST", `/api/bots/${chief.id}/messages`, { text: "Who is on my side?", threadId: chief.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => turns().length, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);
  const system = turns().filter((turn) => turn.botId === chief.id).at(-1)!.system;
  const [, mine = "", others = ""] = system.split(/Bots that report to Bob \(your team\):|Other bots you can reach \(they report to someone else\):/);
  expect(mine).toContain("Scout");
  expect(mine).toContain("Quill");
  expect(mine).not.toContain("Bolt");
  expect(others).toContain("Bolt");
  expect(system).toContain("Reaching a bot gives you no authority over it");
}, hostTimeout(90_000));

it("never carries Bob's private chat into a room, by a hand-off or a post", async () => {
  const sent = await team.as(bob, "POST", `/api/bots/${scout.id}/messages`, { text: "Post that in the Launch room too", threadId: bobsChat });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => turns().some((turn) => turn.botId === scout.id && turn.turnIndex === 2), { timeout: 60_000 }).toBe(true);
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);
  const attempt = turns().find((turn) => turn.botId === scout.id && turn.turnIndex === 2)!;
  expect(JSON.parse(attempt.evidence[1]!.result!.content![0]!.text).rooms).toEqual([]);
  const refusals = attempt.evidence.filter((entry) => entry.step).map((entry) => entry.response!.result!);
  expect(refusals).toHaveLength(2);
  for (const refused of refusals) {
    expect(refused.isError).toBe(true);
    expect(refused.content![0]!.text).toContain("This is a private chat");
  }
  expect((await messages(olive, room.threadId)).messages).toEqual([]);
}, hostTimeout(90_000));
