// Check before done on a Team Cloud: a member's private chat with a checked bot stays theirs. The thread the check runs
// in belongs to that member like a hand-off's would: another member, and the team's owner, can neither list nor open it.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const CAROL = { email: "carol@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const SECRET = "Bob's private draft about the Henderson account";
const ANSWER = `Here is the tightened draft. ${"Every number stays as it was in the source. ".repeat(12).trim()}`;

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", bob = "", carol = "";
type Bot = { id: string; name: string; threadId: string };
let nib: Bot, vera: Bot;

const planPath = () => join(team.home, "plan.json");
const turns = () => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { botId: string; threadId: string; prompt: unknown }) : [];

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-check", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  bob = (await team.pair(BOB)).token!;
  carol = (await team.pair(CAROL)).token!;
  const create = async (name: string) => {
    const created = await team.as(olive, "POST", "/api/bots", { name, visibility: "everyone" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  nib = await create("Nib");
  vera = await create("Vera");
  expect((await team.as(olive, "PATCH", `/api/bots/${nib.id}`, { checkWork: { checker: vera.id } })).status).toBe(200);
  writeFileSync(planPath(), JSON.stringify({ [nib.id]: { reply: ANSWER }, [vera.id]: { reply: "pass" } }));
}, hostTimeout(120_000));

afterAll(async () => { await fx?.close(); });

it("keeps the check of a member's private chat in that member's audience", async () => {
  const opened = await team.as(bob, "POST", `/api/bots/${nib.id}/tasks`, { title: "Henderson" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const bobsChat = opened.body.task.threadId as string;
  expect((await team.as(bob, "POST", `/api/bots/${nib.id}/messages`, { text: `${SECRET}: tighten it and keep every number.`, threadId: bobsChat })).status).toBe(202);
  const read = async (token: string, threadId: string) => team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
  await expect.poll(async () => ((await read(bob, bobsChat)).body.messages ?? []).some((message: { tool?: { name?: string } }) => message.tool?.name === "Checked by Vera · passed in round 1"),
    { timeout: 60_000 }).toBe(true);

  const check = turns().find((turn) => turn.botId === vera.id)!;
  expect(JSON.stringify(check.prompt)).toContain(SECRET);
  expect((await read(bob, check.threadId)).status).toBe(200);
  for (const token of [olive, carol]) {
    expect((await read(token, check.threadId)).status).toBe(404);
    const listed = (await team.as(token, "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; tasks?: Array<{ threadId: string }> }>;
    expect(listed.find((bot) => bot.id === vera.id)?.tasks?.some((task) => task.threadId === check.threadId) ?? false).toBe(false);
  }
}, hostTimeout(120_000));
