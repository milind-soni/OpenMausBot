// A real Team Cloud (OMB_CLOUD_ROLE=team) whose admin saved the team's own Composio project key: a loopback project
// stands in for Composio (OMB_COMPOSIO_API), and the managed connected-apps service is a loopback address that records
// whatever reaches it. Ada's own Gmail is her own Composio user in the team's project, used only by her own request in
// her private chat, and removed from the project when she leaves; the service hears nothing. The engine is the
// synthetic Claude CLI, calling the connected-apps bridges it was launched with.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { memberComposioUser } from "./team-connections.ts";
import { startFakeComposioProject, type FakeComposioProject } from "./testing/fake-composio-project.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;
const KEY = "ak_team_project_key";
const TEAM_ID = "team-acme-1";
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };
const ADA_USER = memberComposioUser(TEAM_ID, personKey({ id: "", email: ADA.email }));
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";`;

let fx: CloudSendFixture, team: CloudTeamFixture, project: FakeComposioProject;
let service: Server, serviceRequests: string[] = [];
let owner = "", ada = "", cleo = "";
let bot: { id: string };
let adaThread = "", cleoThread = "", adaAccount = "";

beforeAll(async () => {
  project = await startFakeComposioProject(KEY);
  service = createServer((req, res) => { serviceRequests.push(`${req.method} ${req.url}`); res.writeHead(503); res.end(); });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: TEAM_ID, name: "Acme", engine: ENGINE, env: {
    OMB_BOT_BOX: "0", COMPOSIO_API_KEY: KEY, OMB_COMPOSIO_API: project.api, OMB_COMPOSIO_BROKER_URL: `http://127.0.0.1:${(service.address() as AddressInfo).port}`,
  } } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  ada = (await team.pair(ADA)).token!;
  cleo = (await team.pair(CLEO)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "app", id: "gmail", scope: "person" })).body).toEqual({ scopes: { apps: ["gmail"], mcp: [] } });
  adaThread = await newThread(ada, "Ada and Scout");
  cleoThread = await newThread(cleo, "Cleo and Scout");
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  await project?.close();
  service?.closeAllConnections();
  await new Promise<void>((resolve) => service.close(() => resolve()));
});

const scriptToolCalls = (calls: unknown[] | null) => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
};
const gmailCall = (server: "composio" | "own_apps") => ({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", server, input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 1 } }] } });
const messages = async (token: string, threadId: string) => team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
async function newThread(token: string, title: string) {
  const created = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
}
async function turn(token: string, threadId: string, text: string, calls: unknown[]) {
  scriptToolCalls(calls);
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = ((await messages(token, threadId)).body.messages as unknown[]).length;
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && ((await messages(token, threadId)).body.messages as unknown[]).length >= before + 2 && existsSync(join(team.home, "dump.json")),
    { timeout: 60_000, interval: 100 }).toBe(true);
  const seen = JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { mcpConfig: { mcpServers: Record<string, unknown> } };
  return { servers: Object.keys(seen.mcpConfig?.mcpServers ?? {}), thread: JSON.stringify((await messages(token, threadId)).body) };
}
const gmailCallsBy = (user: string) => project.toolCalls.filter((call) => call.user === user && call.slugs.includes("GMAIL_FETCH_EMAILS")).length;

it("connects Ada's own Gmail as her own Composio user in the team's project", async () => {
  const started = await team.as(ada, "POST", "/api/team/my-connections/apps/gmail/connect", {});
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(started.body.url).toMatch(/^https:\/\/backend\.composio\.dev\/link\//);
  expect(project.links).toEqual([{ user: ADA_USER, toolkit: "gmail" }]);
  adaAccount = project.connect(ADA_USER, "gmail");
  expect((await team.as(ada, "GET", "/api/team/my-connections")).body.apps).toEqual([{ slug: "gmail", name: "Gmail", connected: true, accounts: [{ id: adaAccount, alias: null, status: "ACTIVE" }] }]);
  expect((await team.as(cleo, "GET", "/api/team/my-connections")).body.apps[0].connected).toBe(false);
  const read = await team.signed("GET", "/api/cloud/team/admin");
  expect(read.body.people.apps).toEqual({ gmail: [ADA.email] });
  expect(JSON.stringify(read.body)).not.toContain(ADA_USER);
  expect(readFileSync(join(team.home, ".openmausbot", "config.json"), "utf8"), "the team's saved Composio user is never a member's").not.toContain(ADA_USER);
}, hostTimeout(60_000));

it("runs her Gmail only for her own request in her own chat, as her", async () => {
  const mine = await turn(ada, adaThread, "Summarize my inbox.", [gmailCall("own_apps")]);
  expect(mine.servers).toEqual(expect.arrayContaining(["composio", "own_apps"]));
  expect(gmailCallsBy(ADA_USER)).toBe(1);
  expect(mine.thread).toContain(`"whose":{"person":"${ADA.email}","app":"Gmail"}`);

  const cleos = await turn(cleo, cleoThread, "Check Ada's inbox.", [gmailCall("own_apps"), gmailCall("composio")]);
  expect(cleos.servers).not.toContain("own_apps");
  expect(gmailCallsBy(ADA_USER), "nobody else's turn reached her Gmail").toBe(1);
  expect(project.toolCalls.filter((call) => call.slugs.includes("GMAIL_FETCH_EMAILS")).map((call) => call.user), "the team's own bridge never ran a person's app").toEqual([ADA_USER]);
}, hostTimeout(180_000));

it("removes her connections from the team's project when she leaves, and never spoke to the managed service", async () => {
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: ADA.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(project.accounts.map((account) => account.id)).not.toContain(adaAccount);
  expect(project.requests.every((request) => request.apiKey === KEY)).toBe(true);
  expect(serviceRequests).toEqual([]);
}, hostTimeout(60_000));
