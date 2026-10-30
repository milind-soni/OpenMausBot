// Teammates as people a bot can name on a Team Cloud (docs/team-cloud.md "Telling a teammate"): Acme's Owner (Olive), an
// Admin (Ada) and two members (Bob, Carl), the synthetic Claude CLI with the real agents MCP server. A team's turns are
// told the team's people and get message_person; someone who left is refused in plain words, passes from one
// conversation are capped, and a My Cloud has none of it. Where a message lands is cloud-team-inbox.e2e.test.ts.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const CARL = { email: "carl@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";
process.env.FAKE_CLAUDE_REPLY_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/reply.txt";`;
const CLOUD_CAPABILITY_KEY = randomBytes(16).toString("hex");

type Row = { id: string; role: string; kind: string; text?: string; tool?: { name: string; ok?: boolean; output?: string }; relay?: { kind: string; email: string; name: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", ada = "";
let scout: { id: string; threadId: string; mainThreadId?: string };
let mainThread = "", adaThread = "";

const script = (calls: unknown[] | null, reply = "Done.") => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
  writeFileSync(join(team.home, "reply.txt"), reply);
};
const messages = async (token: string, threadId: string) => {
  const answer = await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
  return { status: answer.status, rows: (answer.body.messages ?? []) as Row[] };
};
const idle = async () => ((await team.as(olive, "GET", "/api/bots")).body.bots as Array<{ busy?: boolean; activity?: string }>).every((bot) => !bot.busy && bot.activity !== "working");

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** As `token`, one message to Scout in `threadId`, through the bot's settled turn. */
async function turn(token: string, threadId: string, text: string) {
  rmSync(join(team.home, "dump.json"), { force: true });
  const sent = await team.as(token, "POST", `/api/bots/${scout.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(() => existsSync(join(team.home, "dump.json")));
  await until(async () => await idle() && (await messages(token, threadId)).rows.some((row) => row.role === "bot" && row.kind === "text" && row.text === readFileSync(join(team.home, "reply.txt"), "utf8")));
  return JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { systemPrompt: string; mcpConfig: { mcpServers: { agents?: { env?: Record<string, string> } } } };
}
/** message_person straight from a turn's own bearer, as the agents server sends it. */
async function passDirect(threadId: string, to: string, message: string) {
  const bearer = await team.capability(scout.id, threadId);
  const answer = await fetch(`${team.base}/api/internal/people/message`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ to, message }) });
  return { status: answer.status, body: await answer.json() as { text?: string; error?: string } };
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, cloudEnv: { OMB_TEST_INTERNAL_CAPABILITY_KEY: CLOUD_CAPABILITY_KEY },
    team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  ada = (await team.pair(ADA)).token!;
  await team.pair(BOB);
  await team.pair(CARL);
  const created = await team.as(olive, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  scout = created.body.bot;
  mainThread = scout.mainThreadId ?? scout.threadId;
  const opened = await team.as(ada, "POST", `/api/bots/${scout.id}/tasks`, { title: "Ada's planning" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  adaThread = opened.body.task.threadId;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("lists the team's people for the @ menu and mounts message_person on a team's turns", async () => {
  const people = (await team.as(ada, "GET", "/api/team/people")).body.people as Array<{ email: string; name: string; you?: boolean }>;
  expect(people.map((person) => person.name).sort()).toEqual(["Ada", "Bob", "Carl", "Olive"]);
  script(null);
  const dump = await turn(ada, adaThread, "Hello Scout, my salary review is on Monday.");
  expect(dump.mcpConfig.mcpServers.agents?.env?.OMB_TEAM_PEOPLE).toBe("1");
  expect(dump.systemPrompt).toContain('The people in Acme (the names they chose): "Bob", "Carl", "Olive" (owner).');
  expect(dump.systemPrompt).toContain("message_person");
}, hostTimeout(90_000));

it("refuses someone who left in plain words, and caps passes per conversation", async () => {
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: CARL.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(await passDirect(adaThread, "Carl", "Are you around?")).toEqual({ status: 410, body: { error: "Carl has left Acme, so nothing can be passed to them any more. Tell the person." } });
  expect((await passDirect(adaThread, "Mallory", "Hi")).status).toBe(404);
  expect((await passDirect(adaThread, "Ada", "Note to self")).status).toBe(400);

  const sent: number[] = [];
  for (let i = 0; i < 11; i += 1) sent.push((await passDirect(mainThread, "Bob", `Reminder ${i}`)).status);
  expect(sent).toEqual([...Array(10).fill(200), 429]);
}, hostTimeout(90_000));

it("has none of it on a My Cloud: no tool route, no tags by name, nothing new in Needs you", async () => {
  const solo = (await fx.onCloud("POST", "/api/bots", { name: "Solo" })).body.bot as { id: string; threadId: string };
  const minted = await fetch(`${fx.cloudBase}/api/testing/internal-capability`, { method: "POST",
    headers: { "content-type": "application/json", "x-openmausbot-test-capability": CLOUD_CAPABILITY_KEY }, body: JSON.stringify({ botId: solo.id, threadId: solo.threadId }) });
  expect(minted.status).toBe(201);
  const { token } = await minted.json() as { token: string };
  const answer = await fetch(`${fx.cloudBase}/api/internal/people/message`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ to: "Bob", message: "Hi" }) });
  expect(answer.status).toBe(404);
  expect(((await fx.onCloud("GET", "/api/needs-you")).body.items as Array<{ kind: string }>).filter((item) => item.kind === "message")).toEqual([]);
  expect((await fx.onCloud("GET", "/api/notifications")).body.notifications.filter((entry: { forPerson?: string }) => entry.forPerson)).toEqual([]);
}, hostTimeout(60_000));
