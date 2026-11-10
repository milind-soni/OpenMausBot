// What a turn already running keeps when the team's rules change under it, and what it loses at once. A stand-in Admin
// holds the document; the synthetic Claude CLI waits inside its turn while the rule lands, then calls what it was launched
// with. Disposable homes, fake connected-apps service and MCP server; nothing leaves this machine.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { TEAM_POLICY_ADMIN_PATH, teamPolicyFingerprint } from "./cloud-team-policy.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";
process.env.FAKE_CLAUDE_RELEASE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/release";
process.env.FAKE_CLAUDE_REPLY_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/reply.txt";`;
const FINISHED = "Finished with what it had.";
const WAIT = { name: "Read", input: { file_path: "notes.txt" }, hold: true, output: "the notes" };
const ORDERS = { name: "lookup_order", server: "orders", input: {} };
const GMAIL = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", server: "composio", input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 1 } }] } };

let adminServer: Server, relay: Server, gateway: FakeHttpMcp, broker: BrokerFake, fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", botId = "", teamUser = "";
let answer: unknown = { policy: null }, version = 0;
const reports: { loaded: { fingerprint: string } | null }[] = [];

async function rules(limits: Record<string, unknown> | null) {
  const document = limits && { schema: 1, limits };
  const fingerprint = document && teamPolicyFingerprint(document);
  answer = { policy: document && { version: ++version, fingerprint, document } };
  const nudge = await team.signed("POST", "/api/cloud/team/policy-changed", {});
  expect(nudge.status, JSON.stringify(nudge.body)).toBe(200);
  await expect.poll(() => reports.at(-1)?.loaded?.fingerprint ?? null, { timeout: 15_000, interval: 50 }).toBe(fingerprint);
}

type Dump = { pid: number; mcpConfig?: { mcpServers?: Record<string, unknown> } };
const dumpPath = () => join(team.home, "dump.json");
const dump = () => JSON.parse(readFileSync(dumpPath(), "utf8")) as Dump;
const script = (calls: unknown[]) => writeFileSync(join(team.home, "tool-calls.json"), JSON.stringify(calls));
const orderCalls = () => (gateway.calls as { name?: string }[]).filter((call) => call.name === "lookup_order").length;
const thread = async (id: string) => JSON.stringify((await team.as(owner, "GET", `/api/threads/${id}/messages?limit=200`)).body);

async function newThread(title: string) {
  const created = await team.as(owner, "POST", `/api/bots/${botId}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
}
async function send(threadId: string, text: string) {
  rmSync(dumpPath(), { force: true });
  rmSync(join(team.home, "release"), { force: true });
  return team.as(owner, "POST", `/api/bots/${botId}/messages`, { text, threadId });
}
const idle = async () => ((await team.as(owner, "GET", "/api/bots")).body.bots as { activity?: string; busy?: boolean }[]).every((bot) => bot.activity !== "working" && !bot.busy);
/** A turn that runs straight through, and what its engine was launched with. */
async function fullTurn(threadId: string, text: string) {
  script([]);
  const sent = await send(threadId, text);
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => existsSync(dumpPath()) && (await thread(threadId)).includes(FINISHED) && await idle(), { timeout: 60_000, interval: 100 }).toBe(true);
  return dump();
}
/** Starts a turn that waits inside itself, with no rules in force; the rule lands while it waits; then it carries on. */
async function ruleLandsMidTurn(limits: Record<string, unknown>, calls: unknown[], title: string, { ended = FINISHED, ready = () => true }: { ended?: string; ready?: () => boolean } = {}) {
  await rules(null);
  const threadId = await newThread(title);
  script(calls);
  const sent = await send(threadId, title);
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => existsSync(dumpPath()), { timeout: 60_000, interval: 50 }).toBe(true);
  const launched = dump();
  await expect.poll(ready, { timeout: 60_000, interval: 50 }).toBe(true);
  await rules(limits);
  writeFileSync(join(team.home, "release"), "");
  await expect.poll(async () => (await thread(threadId)).includes(ended) && await idle(), { timeout: 60_000, interval: 100 }).toBe(true);
  return { threadId, launched, words: await thread(threadId) };
}

beforeAll(async () => {
  adminServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      expect(req.url).toBe(TEAM_POLICY_ADMIN_PATH);
      reports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => adminServer.listen(0, "127.0.0.1", resolve));
  relay = createServer((_req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  gateway = await startFakeHttpMcp({ tools: [{ name: "lookup_order", inputSchema: { type: "object", properties: {} } }], callResult: () => ({ content: [{ type: "text", text: "order 7 shipped" }] }) });
  broker = await startBrokerFake();
  fx = await launchCloudSendFixture({ onePasswordToken: "ops_fake-running-turn", broker, team: { id: "team-acme-1", name: "Acme", engine: ENGINE, env: {
    OMB_BOT_BOX: "0", FIXTURE_ADMIN_STAND_IN: `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`,
    OMB_CLOUD_BOAT_URL: `http://127.0.0.1:${(relay.address() as AddressInfo).port}/relay/api/box/v1`, OMB_CLOUD_BOAT_TOKEN: "box_omb_running",
  } } });
  team = fx.team!;
  writeFileSync(join(team.home, "reply.txt"), FINISHED);
  owner = (await team.pair({ email: "owner@acme.test", role: "owner" })).token!;
  botId = (await team.as(owner, "POST", "/api/bots", { name: "Scout" })).body.bot.id;
  expect((await team.as(owner, "POST", "/api/bots", { name: "Helper" })).status).toBe(201);
  teamUser = broker.userFor(broker.installationIds().filter((id) => id !== fx.desktopInstallation?.id && broker.actingUser(id) === broker.userFor(id)).at(-1)!);
  broker.account(teamUser, "gmail", "team@acme.test");
  expect((await team.as(owner, "POST", "/api/mcp/servers", { name: "orders", type: "http", url: gateway.url })).status).toBe(201);
  expect((await team.as(owner, "PATCH", "/api/mcp/servers/orders", { enabled: true })).status).toBe(200);
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  await gateway?.close();
  await broker?.close();
  await new Promise((resolve) => adminServer?.close(resolve));
  await new Promise((resolve) => relay?.close(resolve));
});

it("keeps its engine and the MCP servers it began with, and finishes, though the engine and the server are now blocked", async () => {
  const before = orderCalls();
  const { launched, words, threadId } = await ruleLandsMidTurn({ allowedEngines: ["codex"], allowedMcpServers: ["approved"] }, [WAIT, ORDERS], "keeps what it had");
  expect(Object.keys(launched.mcpConfig?.mcpServers ?? {})).toContain("orders");
  expect(orderCalls()).toBe(before + 1);
  expect(words).toContain("order 7 shipped");
  expect(words).toContain(FINISHED);
  expect(words).not.toMatch(/Acme (does not allow|allows only)/);
  const next = await send(threadId, "and the next one");
  expect(next.status, JSON.stringify(next.body)).toBe(409);
  expect(next.body.error).toMatch(/^Acme does not allow the Claude engine\./);
  expect(existsSync(dumpPath())).toBe(false);
}, hostTimeout(120_000));

it("the next turn in the same chat gets the new rules, even with the engine's process still warm", async () => {
  await rules(null);
  const threadId = await newThread("stays warm");
  const first = await fullTurn(threadId, "first");
  const second = await fullTurn(threadId, "second");
  expect(second.pid).toBe(first.pid);
  expect(Object.keys(second.mcpConfig?.mcpServers ?? {})).toContain("orders");
  await rules({ allowedMcpServers: ["approved"] });
  const third = await fullTurn(threadId, "third");
  expect(third.pid).not.toBe(first.pid);
  expect(Object.keys(third.mcpConfig?.mcpServers ?? {})).not.toContain("orders");
}, hostTimeout(180_000));

it("a hand-off it starts after the change gets the new rules", async () => {
  await rules(null);
  const threadId = await newThread("hands on");
  script([WAIT, { name: "coordinate_bots", server: "agents", input: { bot_ids: ["Helper"], message: "Please check the stock.", reason: "It asked for the stock" } }]);
  const sent = await send(threadId, "hands on");
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => existsSync(dumpPath()), { timeout: 60_000, interval: 50 }).toBe(true);
  expect(Object.keys(dump().mcpConfig?.mcpServers ?? {})).toContain("orders");
  await rules({ allowedMcpServers: ["approved"] });
  script([]);
  rmSync(dumpPath(), { force: true });
  writeFileSync(join(team.home, "release"), "");
  await expect.poll(() => existsSync(dumpPath()), { timeout: 60_000, interval: 50 }).toBe(true);
  const helper = dump() as Dump & { prompt?: unknown };
  expect(JSON.stringify(helper.prompt)).toContain("Please check the stock.");
  expect(Object.keys(helper.mcpConfig?.mcpServers ?? {})).not.toContain("orders");
  // Helper's answer then wakes Scout for one more turn in this chat. Wait for that turn here: started after this test,
  // it would play the next test's scripted calls, and its Gmail call would count as that test's own.
  await expect.poll(async () => existsSync(dumpPath()) && JSON.stringify(dump()).includes("own account, not verification") && await idle(),
    { timeout: 60_000, interval: 100 }).toBe(true);
}, hostTimeout(120_000));

it("a connected-app tool is refused from the moment the rule lands, mid-turn, and the turn still finishes", async () => {
  const callsBy = () => broker.mcpCalls.filter((call) => call.method === "tools/call" && call.user === teamUser).length;
  const before = callsBy();
  const { launched, words } = await ruleLandsMidTurn({ allowedApps: ["slack"] }, [GMAIL, WAIT, GMAIL], "uses an app", { ready: () => callsBy() === before + 1 });
  expect(Object.keys(launched.mcpConfig?.mcpServers ?? {})).toContain("composio");
  expect(callsBy()).toBe(before + 1);
  expect(words).toMatch(/Acme does not allow bots to use Gmail\. Ask a team admin\./);
}, hostTimeout(120_000));

it("a computer it has not claimed yet is refused from the moment the rule lands: the turn stops there, in the rule's words", async () => {
  const refusal = "Acme does not allow bots to use cloud computers. Ask a team admin.";
  expect((await team.as(owner, "PATCH", `/api/bots/${botId}`, { computer: "cloud" })).status).toBe(200);
  try {
    const { launched, words } = await ruleLandsMidTurn({ allowedComputers: ["vps"] }, [WAIT, { name: "screenshot", server: "computer", input: {} }], "uses a computer", { ended: refusal });
    expect(Object.keys(launched.mcpConfig?.mcpServers ?? {})).toContain("computer");
    expect(words).not.toMatch(/didn't start/);
    expect(words).not.toContain(FINISHED);
  } finally {
    expect((await team.as(owner, "PATCH", `/api/bots/${botId}`, { computer: null })).status).toBe(200);
  }
}, hostTimeout(120_000));
