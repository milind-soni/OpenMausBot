// A real Team Cloud with the fake engine: one member's private work never reaches another member's team map, as a session
// card (a busy chat, the hand-off it starts, or a room only they can see), nor by its title, cost or thread id. Each case
// first proves the work is live on the map of the member who owns it, so an empty map elsewhere is the filter, not timing.
// The engine's tool calls are scripted, so this proves the projection, not that a model would make those calls.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ENGINE = `process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";
process.env.FAKE_CLAUDE_RELEASE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/release";`;
const HOLD = { name: "Bash", input: { command: "sleep forever" }, hold: true };
const B = "b@acme.test";

let fx: CloudSendFixture, team: CloudTeamFixture;
let admin = "", memberA = "", memberB = "";
let scout = "", helper = "", vault = "";
const home = (name: string) => join(team.home, name);
const script = (calls: unknown[]) => { rmSync(home("release"), { force: true }); writeFileSync(home("tool-calls.json"), JSON.stringify(calls)); };
const map = async (token: string) => {
  const live = await team.as(token, "GET", "/api/team-map");
  expect(live.status, JSON.stringify(live.body)).toBe(200);
  return live.body as { sessions: Array<{ botId: string; threadId: string; title?: string; groupId?: string }>; queued: Array<{ threadId: string }>; running: Array<{ sourceBotId: string; targetBotId: string; threadId: string }>; doneLast24h: number };
};
/** What another member, and the team's admin, must not learn: no card, edge or field carrying any of these strings. */
const expectAbsent = async (tokens: string[], secrets: string[]) => {
  for (const token of tokens) {
    const text = JSON.stringify(await map(token));
    for (const secret of secrets) expect(text, `leaked ${secret}`).not.toContain(secret);
  }
};
const openPrivate = async (botId: string, title: string) => {
  const opened = await team.as(memberB, "POST", `/api/bots/${botId}/tasks`, { title });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body.task.threadId as string;
};
const send = async (botId: string, threadId: string, text: string) => {
  const sent = await team.as(memberB, "POST", `/api/bots/${botId}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
};

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-teammap-${randomBytes(8).toString("hex")}`,
    team: { id: "team-acme-teammap", name: "Acme", engine: ENGINE, env: { OMB_BOT_BOX: "0" } } });
  team = fx.team!;
  writeFileSync(home("tool-calls.json"), "[]");
  admin = (await team.pair({ email: "admin@acme.test", role: "owner" })).token!;
  memberA = (await team.pair({ email: "a@acme.test", role: "member" })).token!;
  memberB = (await team.pair({ email: B, role: "member" })).token!;
  const make = async (name: string) => {
    const created = await team.as(admin, "POST", "/api/bots", { name, visibility: "everyone" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot.id as string;
  };
  scout = await make("Scout");
  helper = await make("Helper");
  vault = await make("Vault");
  expect((await team.as(admin, "PUT", `/api/bots/${vault}/access`, { everyone: "none", people: { [B]: "chat" } })).status).toBe(200);
}, hostTimeout(120_000));

afterEach(async () => {
  writeFileSync(home("release"), "");
  writeFileSync(home("tool-calls.json"), "[]");
  await expect.poll(async () => (await map(memberB)).sessions.filter((one) => one.botId === scout || one.botId === helper || one.botId === vault).length, { timeout: hostTimeout(30_000), interval: 200 }).toBe(0);
}, hostTimeout(60_000));

afterAll(async () => {
  await fx?.close();
});

it("a member's private busy chat on a shared bot is absent from another member's team map, and from the admin's too", async () => {
  const title = "B_PRIVATE_TITLE_TEXT";
  const mine = await openPrivate(scout, title);
  script([HOLD]);
  await send(scout, mine, "Work on my private thing");
  await expect.poll(async () => (await map(memberB)).sessions.some((one) => one.threadId === mine), { timeout: hostTimeout(30_000), interval: 100 }).toBe(true);
  const own = (await map(memberB)).sessions.find((one) => one.threadId === mine);
  expect(own).toMatchObject({ botId: scout, title });

  await expectAbsent([memberA, admin], [title, mine]);
}, hostTimeout(120_000));

it("a hand-off started from a member's private chat is absent from another member's team map, as an edge or a card", async () => {
  const title = "B_PRIVATE_HANDOFF_TITLE";
  const mine = await openPrivate(scout, title);
  // Scout hands the work on and keeps its turn open; Helper's turn reads the same script and holds too.
  script([{ name: "coordinate_bots", server: "agents", input: { bot_ids: [helper], message: "B_PRIVATE_HANDOFF_TEXT" } }, HOLD]);
  await send(scout, mine, "Hand my private thing to Helper");
  await expect.poll(async () => (await map(memberB)).running.some((edge) => edge.sourceBotId === scout && edge.targetBotId === helper), { timeout: hostTimeout(45_000), interval: 200 }).toBe(true);
  const edge = (await map(memberB)).running.find((one) => one.sourceBotId === scout && one.targetBotId === helper)!;

  for (const token of [memberA, admin]) {
    const live = await map(token);
    expect(live.running.concat(live.queued as never[]).some((one) => one.threadId === edge.threadId)).toBe(false);
    expect(live.sessions.some((one) => one.threadId === edge.threadId || one.threadId === mine)).toBe(false);
  }
  await expectAbsent([memberA, admin], [title, mine, edge.threadId, "B_PRIVATE_HANDOFF_TEXT"]);
}, hostTimeout(120_000));

it("a busy room another member cannot see is absent from their team map", async () => {
  // Every bot in a room is shared with the same people, so a room only B sees is one whose bots only B sees.
  const name = "B_PRIVATE_ROOM_NAME";
  const made = await team.as(memberB, "POST", "/api/groups", { name, memberIds: [vault], setup: { bulletin: "", defaultResponder: { kind: "member", botId: vault } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const room = made.body.group as { id: string; threadId: string };
  script([HOLD]);
  expect((await team.as(memberB, "POST", `/api/groups/${room.id}/messages`, { text: "Start the private room work", threadId: room.threadId })).status).toBeLessThan(300);
  await expect.poll(async () => (await map(memberB)).sessions.some((one) => one.threadId === room.threadId), { timeout: hostTimeout(30_000), interval: 100 }).toBe(true);

  expect((await map(memberB)).sessions.find((one) => one.threadId === room.threadId)).toMatchObject({ botId: vault, groupId: room.id });

  await expectAbsent([memberA], [name, room.threadId, room.id, vault]);
}, hostTimeout(120_000));
