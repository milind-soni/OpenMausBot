// Set me up on a real Team Cloud, where a bot's main chat is the whole team's: the press is the presser's alone. Another
// member's line in that chat runs as typed and leaves the request waiting; only the presser's next line sets the bot up,
// and only they can stop it. The engine is the synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";`;
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const MEMBER = { email: "ada@acme.test", role: "member" as const };
const SETUP_BLOCK = "The user explicitly asked you to set yourself up";

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", ben = "", ada = "";

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-2", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  ben = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(MEMBER)).token!;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

const dump = () => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { systemPrompt: string; prompt: unknown };
const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
const waiting = async (token: string, botId: string, threadId: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as any[])
  .find((entry) => entry.id === botId)?.tasks?.find((task: { threadId: string }) => task.threadId === threadId)?.setupRequest;
async function turn(token: string, botId: string, threadId: string, text: string, editing?: string) {
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = (await messages(token, threadId)).length;
  const sent = editing
    ? await team.as(token, "POST", `/api/bots/${botId}/messages/${editing}/edit`, { text, threadId })
    : await team.as(token, "POST", `/api/bots/${botId}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && (await messages(token, threadId)).length >= before + 2 && existsSync(join(team.home, "dump.json")),
    { timeout: 60_000, interval: 100 }).toBe(true);
  return dump();
}

it("in the team's shared main chat, only the person who pressed Set me up sets the bot up, and only they can stop it", async () => {
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; mainThreadId: string; messages: any[] };
  const main = bot.mainThreadId;
  expect(bot.messages[0]).toMatchObject({ role: "bot", setupOffer: true });

  expect((await team.as(owner, "POST", `/api/bots/${bot.id}/setup-request`, { threadId: main })).status).toBe(200);
  const mark = await waiting(ada, bot.id, main);
  expect(mark).toEqual({ at: expect.any(Number), by: expect.any(String) });
  expect(mark.by).not.toBe(personKey({ id: "", email: MEMBER.email }));

  const hers = await turn(ada, bot.id, main, "what's on the team calendar?");
  expect(hers.systemPrompt).not.toContain(SETUP_BLOCK);
  expect(JSON.stringify(hers.prompt)).not.toContain("Set yourself up for this job");
  expect((await messages(owner, main)).find((row) => row.role === "user" && row.text === "what's on the team calendar?")?.setupRequest).toBeUndefined();
  expect(await waiting(owner, bot.id, main)).toEqual(mark);

  expect((await team.as(ada, "DELETE", `/api/bots/${bot.id}/setup-request`, { threadId: main })).status).toBe(403);
  expect(await waiting(owner, bot.id, main)).toEqual(mark);

  const setup = await turn(owner, bot.id, main, "keep the team's launch checklist");
  expect(setup.systemPrompt).toContain(SETUP_BLOCK);
  expect(JSON.stringify(setup.prompt)).toContain("Set yourself up for this job: keep the team's launch checklist");
  expect(await waiting(owner, bot.id, main)).toBeUndefined();

  // An admin's edit of the owner's setup line is the admin's own words: it runs as typed.
  const line = (await messages(owner, main)).find((row) => row.role === "user" && row.text === "keep the team's launch checklist");
  expect(line).toMatchObject({ setupRequest: true });
  const edited = await turn(ben, bot.id, main, "keep the team's launch checklist and delete the old one", line.id);
  expect(edited.systemPrompt).not.toContain(SETUP_BLOCK);
  expect((await messages(owner, main)).find((row) => row.text === "keep the team's launch checklist and delete the old one")?.setupRequest).toBeUndefined();
}, hostTimeout(180_000));

it("refuses another person's press while a member's request waits, and the owner can clear it", async () => {
  const bot = (await team.as(owner, "POST", "/api/bots", { name: "Scribe" })).body.bot as { id: string; mainThreadId: string };
  const main = bot.mainThreadId;
  expect((await team.as(ada, "POST", `/api/bots/${bot.id}/setup-request`, { threadId: main })).status).toBe(200);
  expect(await team.as(owner, "POST", `/api/bots/${bot.id}/setup-request`, { threadId: main })).toEqual({
    status: 409, body: { error: "Someone else is setting this bot up." },
  });
  expect((await team.as(owner, "DELETE", `/api/bots/${bot.id}/setup-request`, { threadId: main })).status).toBe(200);
  expect(await waiting(owner, bot.id, main)).toBeUndefined();
}, hostTimeout(120_000));

// Last: Ada's sessions end with her leaving.
it("drops a member's request when she leaves the team", async () => {
  const bot = (await team.as(owner, "POST", "/api/bots", { name: "Herald" })).body.bot as { id: string; mainThreadId: string };
  const main = bot.mainThreadId;
  expect((await team.as(ada, "POST", `/api/bots/${bot.id}/setup-request`, { threadId: main })).status).toBe(200);
  expect(await waiting(owner, bot.id, main)).toMatchObject({ by: expect.any(String) });
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: MEMBER.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(await waiting(owner, bot.id, main)).toBeUndefined();
}, hostTimeout(120_000));
