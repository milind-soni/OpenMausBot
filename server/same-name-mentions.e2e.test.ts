// Two bots on a Team Cloud share a name, end to end. In a room with both, the one a person picks from the @ list is the
// one that answers, also when the line waits behind a running turn; the same name typed with no pick is refused in plain
// words before anything is queued; a name only one bot has still works. In a one-to-one chat the picked teammate is the
// one the bot is told about. The engine is the synthetic Claude CLI playing a scripted plan, so it proves the routing,
// not a model's judgement.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const REFUSED = 'Two bots here are named "Marlowe": Marlowe, Analyst and Marlowe, Chief of Staff. Pick the one you mean from the @ list.';
const HOLD = "hold the room for a moment";

type Bot = { id: string; name: string; threadId: string };
type Message = { role: string; kind?: string; text?: string; from?: { botId: string } };
type Turn = { botId: string; system: string; prompt: unknown };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "";
let lead: Bot, analyst: Bot, chief: Bot;
let room: { id: string; threadId: string };

const planPath = () => join(team.home, "plan.json");
const leadGo = () => join(team.home, "lead-go");
const turns = (): Turn[] => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn) : [];
const ran = (bot: Bot) => turns().filter((turn) => turn.botId === bot.id).length;
const create = async (body: Record<string, unknown>) => {
  const created = await team.as(olive, "POST", "/api/bots", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};
const transcript = async () =>
  ((await team.as(olive, "GET", `/api/threads/${room.threadId}/messages?limit=200`)).body.messages ?? []) as Message[];
const repliesFrom = async (bot: Bot) => (await transcript()).filter((message) => message.kind === "text" && message.from?.botId === bot.id).length;
const roomNow = async () => ((await team.as(olive, "GET", "/api/bots?messages=0")).body.groups as Array<{ id: string; busyBotId?: string | null; working?: boolean }>)
  .find((group) => group.id === room.id);
const settled = async () => {
  const listed = (await team.as(olive, "GET", "/api/bots?messages=0")).body as { bots: Array<{ busy?: boolean; tasks?: Array<{ busy?: boolean }> }>; groups: Array<{ id: string; working?: boolean; busyBotId?: string | null }> };
  const group = listed.groups.find((one) => one.id === room.id);
  return listed.bots.every((one) => !one.busy && !(one.tasks ?? []).some((task) => task.busy)) && !group?.working && !group?.busyBotId;
};
const say = (text: string, extra: Record<string, unknown> = {}) =>
  team.as(olive, "POST", `/api/groups/${room.id}/messages`, { text, sendId: randomUUID(), ...extra });

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  lead = await create({ name: "Tessaly", title: "Support lead", reportsTo: OLIVE.email });
  analyst = await create({ name: "Marlowe", title: "Analyst", reportsTo: OLIVE.email });
  chief = await create({ name: "Marlowe", reportsTo: OLIVE.email });
  expect((await team.as(olive, "PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
  const made = await team.as(olive, "POST", "/api/groups", { name: "Launch", memberIds: [lead.id, analyst.id, chief.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  room = made.body.group;
  writeFileSync(planPath(), JSON.stringify({
    [lead.id]: { byPrompt: [{ promptIncludes: HOLD, plan: { reply: "Holding.", gateFile: leadGo() } }], reply: "Tessaly here." },
    [analyst.id]: { reply: "The analyst here." },
    [chief.id]: { reply: "The chief here." },
  }));
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("sends a line with a picked bot to that bot alone, never the older one of the same name", async () => {
  const sent = await say("@Marlowe please check the launch numbers", { mentions: [chief.id] });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => repliesFrom(chief), { timeout: 60_000 }).toBe(1);
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  expect(ran(chief)).toBe(1);
  expect(ran(analyst)).toBe(0);
  expect(ran(lead)).toBe(0);
}, hostTimeout(120_000));

it("refuses the shared name typed with no pick, in plain words, before anything is queued", async () => {
  const opened = await say(`@Tessaly ${HOLD}`);
  expect(opened.status, JSON.stringify(opened.body)).toBe(202);
  await expect.poll(async () => (await roomNow())?.busyBotId, { timeout: 30_000 }).toBe(lead.id);

  const refused = await say("@Marlowe are you there?");
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe(REFUSED);
  const waiting = await say("@Marlowe are the numbers in?", { mentions: [analyst.id] });
  expect(waiting.status, JSON.stringify(waiting.body)).toBe(202);
  expect(waiting.body.queued).toBe(true);

  writeFileSync(leadGo(), "go");
  await expect.poll(() => repliesFrom(analyst), { timeout: 60_000 }).toBe(1);
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  const lines = await transcript();
  expect(lines.some((message) => message.text?.includes("are you there?"))).toBe(false);
  expect(lines.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
    "@Marlowe please check the launch numbers", `@Tessaly ${HOLD}`, "@Marlowe are the numbers in?",
  ]);
  expect(ran(analyst)).toBe(1);
  expect(ran(chief)).toBe(1);
}, hostTimeout(120_000));

it("still sends a name only one bot has, and refuses picks that are not a list of ids", async () => {
  const before = ran(lead);
  const sent = await say("@Tessaly how are we doing?");
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => ran(lead), { timeout: 60_000 }).toBe(before + 1);
  await expect.poll(settled, { timeout: 30_000 }).toBe(true);
  for (const mentions of ["not-a-list", [42], Array.from({ length: 21 }, (_, i) => `bot-${i}`)]) {
    const bad = await say("@Marlowe hello", { mentions });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("mentions must be a list of up to 20 bot ids");
  }
}, hostTimeout(120_000));

it("tells a bot in a one-to-one chat about the teammate picked, and about both when the name was typed", async () => {
  const opened = await team.as(olive, "POST", `/api/bots/${lead.id}/tasks`, { title: "Numbers" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const chat = opened.body.task.threadId as string;
  const asked = async (text: string, mentions?: string[]) => {
    const before = ran(lead);
    const sent = await team.as(olive, "POST", `/api/bots/${lead.id}/messages`, { text, threadId: chat, ...(mentions ? { mentions } : {}) });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(() => ran(lead), { timeout: 60_000 }).toBe(before + 1);
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    const turn = turns().filter((one) => one.botId === lead.id).at(-1)!;
    return `${turn.system}\n${JSON.stringify(turn.prompt)}`;
  };
  const picked = await asked("can you ask @Marlowe for the launch numbers?", [analyst.id]);
  expect(picked).toContain(`The user named these existing teammates: Marlowe (${analyst.id})`);
  expect(picked).not.toContain(`Marlowe (${chief.id})`);
  const typed = (await asked("can you ask @Marlowe for the launch numbers again?")).match(/The user named these existing teammates: [^.]*\./)?.[0];
  expect(typed).toContain(`Marlowe (${analyst.id})`);
  expect(typed).toContain(`Marlowe (${chief.id})`);
}, hostTimeout(120_000));
