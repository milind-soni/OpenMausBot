// A Team Cloud with its team's rules, from the Admin's signed answer to the turn. A stand-in Admin holds the document and
// checks each request's signature. A chat turn, a routine, one bot asking another, a person connecting something and
// a lent computer all meet the same refusal, for an Admin as for a User, and all pass again once the rule lifts, with no
// restart. Disposable homes, a synthetic Claude CLI; nothing leaves this machine.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { TEAM_POLICY_ADMIN_PATH, TEAM_POLICY_FILE, teamPolicyFingerprint } from "./cloud-team-policy.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "owner@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";`;

type Limits = Record<string, unknown>;
const admin = {
  answer: { status: 200, body: { policy: null } as unknown, type: "application/json" },
  reports: [] as { loaded: { fingerprint: string; version: number } | null; problem: string | null }[],
  signed: [] as boolean[],
  version: 0,
};
let adminServer: Server, gateway: FakeHttpMcp, relay: Server, broker: BrokerFake, fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", ada = "";
let botId = "", peerId = "";

function publish(limits: Limits | null) {
  if (!limits) { admin.answer = { status: 200, body: { policy: null }, type: "application/json" }; return null; }
  const document = { schema: 1, limits };
  const policy = { version: ++admin.version, fingerprint: teamPolicyFingerprint(document), document };
  admin.answer = { status: 200, body: { policy }, type: "application/json" };
  return policy;
}
/** The Admin's nudge, as it sends one after a save; then the Cloud's report that the rules are in force. */
async function nudged(fingerprint: string | null) {
  const nudge = await team.signed("POST", "/api/cloud/team/policy-changed", {});
  expect(nudge.status, JSON.stringify(nudge.body)).toBe(200);
  await expect.poll(() => admin.reports.at(-1)?.loaded?.fingerprint ?? null, { timeout: 15_000, interval: 50 }).toBe(fingerprint);
}
async function rules(limits: Limits | null) {
  const policy = publish(limits);
  await nudged(policy?.fingerprint ?? null);
}

async function dumped(token: string, text: string, until: (messages: string) => boolean) {
  const thread = await team.as(token, "POST", `/api/bots/${botId}/tasks`, { title: text });
  expect(thread.status, JSON.stringify(thread.body)).toBe(201);
  const threadId = thread.body.task.threadId as string;
  rmSync(join(team.home, "dump.json"), { force: true });
  const sent = await team.as(token, "POST", `/api/bots/${botId}/messages`, { text, threadId });
  const messages = async () => JSON.stringify((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body);
  if (sent.status === 202) await expect.poll(async () => until(await messages()), { timeout: 60_000, interval: 150 }).toBe(true);
  return { sent, threadId, messages: await messages() };
}
const engineRan = () => existsSync(join(team.home, "dump.json"));
const engineSaw = () => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { mcpConfig?: { mcpServers?: Record<string, unknown> } };

/** One routine run by hand, as an Admin starts one: what it answered, and the finished run's words. */
async function routineRun(name: string) {
  const created = await team.as(owner, "POST", "/api/routines", { name, prompt: `Run ${name}.`, botId, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  rmSync(join(team.home, "dump.json"), { force: true });
  const started = await team.as(owner, "POST", `/api/routines/${created.body.routine.id}/run`);
  if (started.status !== 201) return { status: started.status, words: JSON.stringify(started.body) };
  const runId = started.body.run.id as string, deadline = Date.now() + 60_000;
  for (;;) {
    const run = ((await team.as(owner, "GET", "/api/routines")).body.runs as { id: string; status: string; threadId: string }[]).find((candidate) => candidate.id === runId)!;
    if (!["queued", "running", "starting", "waiting", "pending"].includes(run.status)) {
      const messages = await team.as(owner, "GET", `/api/threads/${run.threadId}/messages?limit=200`);
      return { status: started.status, words: `${JSON.stringify(run)} ${JSON.stringify(messages.body)}` };
    }
    if (Date.now() > deadline) throw new Error(`routine did not finish: ${JSON.stringify(run)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

beforeAll(async () => {
  adminServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      expect(req.url).toBe(TEAM_POLICY_ADMIN_PATH);
      const headers = req.headers as Record<string, string>;
      admin.signed.push(/^v1=[\w-]{43}$/.test(headers["x-omb-cloud-signature"] ?? "") && Boolean(headers["x-omb-cloud-machine"]) && createHash("sha256").update(body).digest().length === 32);
      admin.reports.push(JSON.parse(body));
      res.writeHead(admin.answer.status, { "content-type": admin.answer.type });
      res.end(typeof admin.answer.body === "string" ? admin.answer.body : JSON.stringify(admin.answer.body));
    });
  });
  await new Promise<void>((resolve) => adminServer.listen(0, "127.0.0.1", resolve));
  relay = createServer((_req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  gateway = await startFakeHttpMcp({ tools: [{ name: "lookup_order", inputSchema: { type: "object", properties: {} } }], callResult: () => ({ content: [{ type: "text", text: "ok" }] }) });
  broker = await startBrokerFake();
  const relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  fx = await launchCloudSendFixture({ onePasswordToken: "ops_fake-rules", broker, team: { id: "team-acme-1", name: "Acme", engine: ENGINE, env: {
    OMB_BOT_BOX: "0", FIXTURE_ADMIN_STAND_IN: `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`,
    OMB_CLOUD_BOAT_URL: `${relayBase}/relay/api/box/v1`, OMB_CLOUD_BOAT_TOKEN: "box_omb_rules",
  } } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  ada = (await team.pair(ADA)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout", visibility: "everyone" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  botId = created.body.bot.id;
  peerId = (await team.as(owner, "POST", "/api/bots", { name: "Helper", visibility: "everyone" })).body.bot.id;
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

it("with no rules, everything is as it was and nobody sees a badge; the fetch is signed", async () => {
  await rules(null);
  expect(admin.signed.every(Boolean)).toBe(true);
  expect((await team.as(ada, "GET", "/api/config")).body.managedPolicy).toBeNull();
  const { messages } = await dumped(owner, "before any rule", (text) => text.includes("\"role\":\"bot\"") || text.includes("before any rule") && engineRan());
  expect(messages).not.toContain("Acme");
  await expect.poll(engineRan, { timeout: 30_000, interval: 100 }).toBe(true);
  await expect.poll(() => engineSaw().mcpConfig?.mcpServers?.orders !== undefined, { timeout: 10_000 }).toBe(true);
}, hostTimeout(90_000));

it("a blocked engine is refused for a chat turn and a routine, for an Admin and a User, naming the team; it passes again once the rule lifts, with no restart", async () => {
  await rules({ allowedEngines: ["codex"] });
  const summary = (await team.as(ada, "GET", "/api/config")).body.managedPolicy;
  expect(summary).toMatchObject({ organizationName: "Acme", allowedEngines: ["codex"], companyModelsOnly: false, team: true });

  for (const token of [owner, ada]) {
    const { sent } = await dumped(token, "blocked engine", () => true);
    expect(sent.status, JSON.stringify(sent.body)).toBe(409);
    expect(sent.body.error).toMatch(/^Acme does not allow the Claude engine\. .*ask a team admin\.$/);
    expect(engineRan()).toBe(false);
  }
  // A bot a User made is the team's too: the rule applies to it as to any other.
  const own = await team.as(ada, "POST", "/api/bots", { name: "Ada's own", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  expect(own.status, JSON.stringify(own.body)).toBe(201);
  const ownTurn = await team.as(ada, "POST", `/api/bots/${own.body.bot.id}/messages`, { text: "blocked on my own bot" });
  expect([ownTurn.status, ownTurn.body.error], JSON.stringify(ownTurn.body)).toEqual([409, expect.stringMatching(/^Acme does not allow the Claude engine\./)]);
  expect(engineRan()).toBe(false);
  const routine = await routineRun("Blocked engine");
  expect(routine.words).toMatch(/Acme does not allow the Claude engine/);
  expect(engineRan()).toBe(false);
  // One bot asking another: the same refusal, and the engine never starts.
  const thread = await team.as(owner, "POST", `/api/bots/${botId}/tasks`, { title: "asks a teammate" });
  const capability = await team.capability(botId, thread.body.task.threadId);
  rmSync(join(team.home, "dump.json"), { force: true });
  const asked = await fetch(`${team.base}/api/internal/coordinate-bots`, { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" }, body: JSON.stringify({ botIds: [peerId], message: "Please check this.", reply: "none", thread: "fresh" }) });
  const askedWords = await asked.text();
  expect(asked.status, askedWords).toBeLessThan(500);
  const peerWords = async () => {
    const bots = (await team.as(owner, "GET", "/api/bots")).body.bots as { id: string; threadId?: string; tasks: { threadId: string }[] }[];
    const threads = bots.filter((bot) => bot.id === peerId || bot.id === botId).flatMap((bot) => [...(bot.threadId ? [bot.threadId] : []), ...bot.tasks.map((task) => task.threadId)]);
    const lines = await Promise.all(threads.map(async (id) => JSON.stringify((await team.as(owner, "GET", `/api/threads/${id}/messages?limit=200`)).body)));
    return lines.join(" ") + askedWords;
  };
  await expect.poll(peerWords, { timeout: 15_000, interval: 200 }).toMatch(/Acme does not allow the Claude engine/);
  expect(engineRan()).toBe(false);
  // The engine stays listed, with the reason: never hidden.
  const claude = (await team.as(owner, "GET", "/api/instances")).body.instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
  expect(claude.policy).toMatchObject({ organizationName: "Acme", team: true });

  await rules(null);
  expect((await team.as(ada, "GET", "/api/config")).body.managedPolicy).toBeNull();
  await dumped(ada, "engine allowed again", () => engineRan());
  expect(engineRan()).toBe(true);
  const again = await routineRun("Engine allowed again");
  expect(again.words).not.toMatch(/Acme does not allow/);
  expect(engineRan()).toBe(true);
}, hostTimeout(180_000));

it("a blocked MCP server never reaches a chat turn or a routine, and can't be added; it returns once the rule lifts", async () => {
  await rules({ allowedMcpServers: ["approved"] });
  await dumped(owner, "blocked server", () => engineRan());
  expect(engineSaw().mcpConfig?.mcpServers?.orders).toBeUndefined();
  await routineRun("Blocked server");
  expect(engineRan()).toBe(true);
  expect(engineSaw().mcpConfig?.mcpServers?.orders).toBeUndefined();
  const listed = await team.as(owner, "GET", "/api/mcp/servers");
  expect(listed.body.managed).toMatchObject({ organizationName: "Acme", allowlist: ["approved"] });
  expect(listed.body.servers.find((server: { name: string }) => server.name === "orders")).toMatchObject({ managedBy: "Acme" });
  const added = await team.as(owner, "POST", "/api/mcp/servers", { name: "other", type: "http", url: gateway.url });
  expect([added.status, added.body.code]).toEqual([403, "managed_policy"]);
  expect(added.body.error).toMatch(/^Acme allows only MCP servers it has approved\. Ask a team admin/);

  await rules({ allowedMcpServers: ["orders"] });
  await dumped(owner, "approved server", () => engineRan());
  expect(engineSaw().mcpConfig?.mcpServers?.orders).toBeDefined();
  await rules(null);
  await routineRun("Server allowed again");
  expect(engineSaw().mcpConfig?.mcpServers?.orders).toBeDefined();
}, hostTimeout(180_000));

it("only the team's own servers: an admin still adds one, a bot can't, and a turn keeps the team's", async () => {
  await rules({ allowedMcpServers: "team" });
  const added = await team.as(owner, "POST", "/api/mcp/servers", { name: "second", type: "http", url: gateway.url });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  expect((await team.as(owner, "DELETE", "/api/mcp/servers/second")).status).toBe(200);
  await dumped(ada, "the team's own", () => engineRan());
  expect(engineSaw().mcpConfig?.mcpServers?.orders).toBeDefined();
  const thread = await team.as(owner, "POST", `/api/bots/${botId}/tasks`, { title: "adds a server" });
  const capability = await team.capability(botId, thread.body.task.threadId);
  const byBot = await fetch(`${team.base}/api/internal/mcp-servers`, { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" }, body: JSON.stringify({ action: "add", name: "mine", type: "http", url: gateway.url }) });
  expect([byBot.status, (await byBot.json() as { error?: string }).error]).toEqual([403, "Acme uses only the MCP servers its admins add. Ask a team admin."]);
  await rules(null);
}, hostTimeout(90_000));

it("a connected app the rules don't allow: its tools and its sign-in are refused, whatever the bot asks; it lifts", async () => {
  await rules({ allowedApps: ["gmail"] });
  const thread = await team.as(owner, "POST", `/api/bots/${botId}/tasks`, { title: "uses an app" });
  const capability = await team.capability(botId, thread.body.task.threadId, "connectors");
  const call = async (name: string, args: unknown = {}) => {
    const answer = await fetch(`${team.base}/api/internal/connectors/mcp`, { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.stringify(await answer.json());
  };
  expect(await call("SLACK_SEND_MESSAGE")).toContain("Acme does not allow bots to use Slack. Ask a team admin.");
  expect(await call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "SLACK_SEND_MESSAGE" }] })).toContain("Acme does not allow bots to use Slack.");
  expect(await call("COMPOSIO_REMOTE_WORKBENCH", { code: "run()" })).toContain("can't run code");
  expect(await call("GMAIL_FETCH_EMAILS")).not.toContain("Acme does not allow");
  const signIn = await team.as(owner, "POST", "/api/connectors/slack/authorize", {});
  expect([signIn.status, signIn.body.code]).toEqual([403, "managed_policy"]);
  await rules(null);
  expect(await call("SLACK_SEND_MESSAGE")).not.toContain("Acme does not allow");
}, hostTimeout(60_000));

it("a blocked cloud desktop is refused for a chat turn and a routine; a lent computer is refused too; both lift", async () => {
  const setComputer = await team.as(owner, "PATCH", `/api/bots/${botId}`, { computer: "cloud" });
  expect(setComputer.status, JSON.stringify(setComputer.body)).toBe(200);
  await rules({ allowedComputers: ["vps"] });
  const { sent, messages } = await dumped(owner, "blocked computer", (text) => /Acme does not allow bots to use cloud computers/.test(text));
  expect(`${JSON.stringify(sent.body)} ${messages}`).toMatch(/Acme does not allow bots to use cloud computers\. Ask a team admin\./);
  const routine = await routineRun("Blocked computer");
  expect(routine.words).toMatch(/Acme does not allow bots to use cloud computers/);

  const thread = await team.as(owner, "POST", `/api/bots/${botId}/tasks`, { title: "lent" });
  const capability = await team.capability(botId, thread.body.task.threadId);
  const lent = await fetch(`${team.base}/api/internal/shared-computers`, { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" }, body: JSON.stringify({ action: "list_files", computer_id: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" }) });
  const lentBody = await lent.json() as { error?: string };
  expect([lent.status, lentBody.error]).toEqual([403, "Acme does not allow bots to use a member's own computer. Ask a team admin."]);

  await rules(null);
  const after = await dumped(owner, "computer allowed again", () => engineRan());
  expect(after.messages).not.toMatch(/Acme does not allow/);
  expect((await team.as(owner, "PATCH", `/api/bots/${botId}`, { computer: null })).status).toBe(200);
}, hostTimeout(180_000));

it("remote access off refuses a phone code and signs phones out, while every member's app still pairs; it lifts", async () => {
  const code = await team.as(ada, "POST", "/api/team/phone-pairing", {});
  expect(code.status, JSON.stringify(code.body)).toBe(200);
  const phone = await fetch(`${team.base}/api/auth/pair`, { method: "POST", headers: { ...fx.edge, "content-type": "application/json" }, body: JSON.stringify({ code: code.body.code, label: "Phone" }) });
  const phoneToken = ((await phone.json()) as { token: string }).token;
  expect((await team.as(phoneToken, "GET", "/api/config")).status).toBe(200);
  const unused = await team.as(ada, "POST", "/api/team/phone-pairing", {});
  expect(unused.status).toBe(200);

  await rules({ remoteAccess: "off" });
  const refused = await team.as(ada, "POST", "/api/team/phone-pairing", {});
  expect([refused.status, refused.body.code]).toEqual([403, "managed_policy"]);
  expect(refused.body.error).toBe("Acme does not allow opening this Cloud on a phone or with a link. Ask a team admin.");
  expect((await team.as(phoneToken, "GET", "/api/config")).status).toBe(401);
  // A code made before the rule stops working too.
  const late = await fetch(`${team.base}/api/auth/pair`, { method: "POST", headers: { ...fx.edge, "content-type": "application/json" }, body: JSON.stringify({ code: unused.body.code }) });
  expect(late.status).toBe(401);
  // The Admin's signed pairing is how every member's app reaches the Cloud: a rule never locks the team out.
  const app = await team.pair(ADA);
  expect(app.status, JSON.stringify(app.body)).toBe(200);
  ada = app.token!;

  await rules(null);
  expect((await team.as(ada, "POST", "/api/team/phone-pairing", {})).status).toBe(200);
}, hostTimeout(60_000));

it("a kept policy applies at once after a restart with the Admin unreachable, and never lapses; a document it can't read keeps the last good one and says so", async () => {
  const policy = publish({ allowedEngines: ["codex"] })!;
  await nudged(policy.fingerprint);
  const kept = JSON.parse(readFileSync(join(team.home, ".openmausbot", TEAM_POLICY_FILE), "utf8"));
  expect(kept).toMatchObject({ teamId: team.id, fingerprint: policy.fingerprint, version: policy.version });

  admin.answer = { status: 503, body: "down", type: "text/plain" };
  await team.relaunch();
  owner = (await team.pair(OWNER)).token!;
  expect((await team.as(owner, "GET", "/api/config")).body.managedPolicy).toMatchObject({ organizationName: "Acme", allowedEngines: ["codex"] });
  expect((await dumped(owner, "while the Admin is down", () => true)).sent.status).toBe(409);

  // A proxy's 404 is not the Admin's word: only JSON from it lifts the rules.
  admin.answer = { status: 404, body: "<html>not found</html>", type: "text/html" };
  await team.signed("POST", "/api/cloud/team/policy-changed", {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await team.as(owner, "GET", "/api/config")).body.managedPolicy).not.toBeNull();

  // A newer kind of document: it stays alive, keeps the last good rules and reports that.
  const newer = { schema: 2, limits: {}, settings: {} };
  admin.answer = { status: 200, body: { policy: { version: ++admin.version, fingerprint: teamPolicyFingerprint(newer), document: newer } }, type: "application/json" };
  await team.signed("POST", "/api/cloud/team/policy-changed", {});
  await expect.poll(() => admin.reports.at(-1)?.problem ?? null, { timeout: 15_000, interval: 50 }).toMatch(/newer kind/);
  expect(admin.reports.at(-1)?.loaded?.fingerprint).toBe(policy.fingerprint);
  expect((await team.as(owner, "GET", "/api/config")).body.managedPolicy).toMatchObject({ allowedEngines: ["codex"] });

  // An older Admin, or its switch off: a JSON 404 is no policy.
  admin.answer = { status: 404, body: { error: "Not found." }, type: "application/json" };
  await team.signed("POST", "/api/cloud/team/policy-changed", {});
  await expect.poll(async () => (await team.as(owner, "GET", "/api/config")).body.managedPolicy, { timeout: 15_000, interval: 100 }).toBeNull();
  expect(existsSync(join(team.home, ".openmausbot", TEAM_POLICY_FILE))).toBe(false);
}, hostTimeout(120_000));

it("require a fresh policy: with none to be had, new turns are refused in plain words; a good fetch lets them through", async () => {
  const policy = publish({ requireFreshPolicy: true })!;
  await nudged(policy.fingerprint);
  await dumped(owner, "fresh rules", () => engineRan());
  expect(engineRan()).toBe(true);

  // A restart long after the last good fetch, with the Admin down: the kept rules say a fresh one is required.
  const file = join(team.home, ".openmausbot", TEAM_POLICY_FILE);
  admin.answer = { status: 503, body: "down", type: "text/plain" };
  await team.relaunch();
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), fetchedAt: Date.now() - 3_600_000 }));
  await team.relaunch();
  owner = (await team.pair(OWNER)).token!;
  const { sent } = await dumped(owner, "stale rules", () => true);
  expect(sent.status, JSON.stringify(sent.body)).toBe(409);
  expect(sent.body.error).toBe("Acme requires up-to-date rules, and this Cloud can't confirm them right now. Try again in a few minutes, or ask a team admin.");

  publish(null);
  await team.signed("POST", "/api/cloud/team/policy-changed", {});
  await expect.poll(async () => (await team.as(owner, "GET", "/api/config")).body.managedPolicy, { timeout: 15_000, interval: 100 }).toBeNull();
  await dumped(owner, "rules lifted", () => engineRan());
  expect(engineRan()).toBe(true);
}, hostTimeout(120_000));
