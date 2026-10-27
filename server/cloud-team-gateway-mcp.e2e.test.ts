// A Team Cloud (OMB_CLOUD_ROLE=team) with an MCP server behind a gateway that checks two service-token headers, as
// Cloudflare Access does. An admin pastes the `claude mcp add` command into Add MCP server and fills in the two values
// its variables stood for; the server is added for the whole team through the panel's own routes. A member's turn on
// the synthetic Claude CLI then lists and calls its tool, and neither value reaches the engine's environment, the logs or
// anything a route answers. The bot box is Linux-only, so here the engine is the MCP client and its MCP config holds
// the headers, as Claude Code's own `claude mcp add --header` keeps them.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { readMcpPaste } from "../src/lib/mcp-paste.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const CLIENT_ID = `${randomBytes(8).toString("hex")}.access`;
const CLIENT_SECRET = randomBytes(24).toString("hex");
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";`;

let fx: CloudSendFixture, team: CloudTeamFixture, gateway: FakeHttpMcp;
let admin = "", ada = "";
let bot: { id: string };
const answers: string[] = [];

/** One request as a person, kept for the no-secret check. */
async function as(token: string, method: string, path: string, body?: unknown) {
  const answer = await team.as(token, method, path, body);
  answers.push(JSON.stringify(answer.body));
  return answer;
}

beforeAll(async () => {
  gateway = await startFakeHttpMcp({
    tools: [{ name: "lookup_order", inputSchema: { type: "object", properties: { id: { type: "string" } } } }],
    requireHeaders: { "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": CLIENT_SECRET },
    callResult: (params) => ({ content: [{ type: "text", text: `order ${String((params as { arguments?: { id?: unknown } }).arguments?.id)} shipped` }] }),
  });
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(ADA)).token!;
  const created = await as(admin, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  await gateway?.close();
});

/** What Add MCP server sends for a pasted command, with what the person typed for each value the command left out. */
function pastedBody(command: string, typed: Record<string, string>) {
  const read = readMcpPaste(command);
  const server = read?.ok ? read.servers[0] : undefined;
  if (server?.transport !== "remote") throw new Error(`not read: ${JSON.stringify(read)}`);
  return { name: server.name, type: server.type, url: server.url, headers: Object.fromEntries(server.headers.map((header) => [header.name, header.gap ? typed[header.name] : header.value])) };
}

const command = (url: string) => `claude mcp add --transport http orders ${url} \\
  --header "CF-Access-Client-Id: $CF_ID" \\
  --header "CF-Access-Client-Secret: $CF_SECRET"`;

it("lets the gateway answer only a request that carries both headers with the right values", async () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const post = (headers: Record<string, string>) => fetch(gateway.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(initialize) });
  expect((await post({})).status).toBe(403);
  expect((await post({ "CF-Access-Client-Id": CLIENT_ID })).status).toBe(403);
  expect((await post({ "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": "wrong" })).status).toBe(403);
  expect((await post({ "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": CLIENT_SECRET })).status).toBe(200);
});

it("adds the pasted command for the whole team, tests it through the gateway and turns it on", async () => {
  const wrong = pastedBody(command(gateway.url), { "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": "not-the-secret" });
  expect(wrong).toEqual({ name: "orders", type: "http", url: gateway.url, headers: { "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": "not-the-secret" } });
  expect((await as(admin, "POST", "/api/mcp/servers", wrong)).status).toBe(201);
  const refused = await as(admin, "POST", "/api/mcp/servers/orders/test");
  expect(refused.body).toEqual({ ok: false, error: "The server didn't accept the keys (HTTP 403). Check the header values.", reason: "keys", status: 403 });
  expect((await as(admin, "DELETE", "/api/mcp/servers/orders")).status).toBe(200);

  const added = await as(admin, "POST", "/api/mcp/servers", pastedBody(command(gateway.url), { "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": CLIENT_SECRET }));
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  expect(added.body.servers).toEqual([expect.objectContaining({ name: "orders", url: gateway.url, headerKeys: ["CF-Access-Client-Id", "CF-Access-Client-Secret"], enabled: false })]);
  const tested = await as(admin, "POST", "/api/mcp/servers/orders/test");
  expect(tested.body).toMatchObject({ ok: true, tools: [{ name: "lookup_order" }] });
  expect((await as(admin, "PATCH", "/api/mcp/servers/orders", { enabled: true })).status).toBe(200);
  // A member can't change the team's servers.
  expect((await as(ada, "POST", "/api/mcp/servers", { name: "mine", type: "http", url: gateway.url })).status).toBe(403);
}, hostTimeout(60_000));

type Engine = { env: Record<string, string>; argv: string[]; mcpConfig: { mcpServers: Record<string, unknown> } };

/** One turn in `token`'s own chat with Scout, with these scripted tool calls; what the engine was launched with. */
async function turn(token: string, text: string, calls: unknown[], until: string): Promise<Engine> {
  const thread = await as(token, "POST", `/api/bots/${bot.id}/tasks`, { title: text });
  expect(thread.status, JSON.stringify(thread.body)).toBe(201);
  const threadId = thread.body.task.threadId as string;
  writeFileSync(join(team.home, "tool-calls.json"), JSON.stringify(calls));
  rmSync(join(team.home, "dump.json"), { force: true });
  const sent = await as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const messages = async () => (await as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body;
  await expect.poll(async () => JSON.stringify(await messages()).includes(until) && existsSync(join(team.home, "dump.json")),
    { timeout: 60_000, interval: 200 }).toBe(true);
  return JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as Engine;
}

it("lets a member's turn list and call the gateway's tool, with both values sent only to the gateway", async () => {
  const calledBefore = gateway.calls.length;
  const engine = await turn(ada, "Where is order 1042?", [{ name: "lookup_order", server: "orders", input: { id: "1042" } }], "order 1042 shipped");

  expect(gateway.calls.slice(calledBefore)).toEqual([{ name: "lookup_order", arguments: { id: "1042" } }]);
  expect(gateway.toolsLists).toBeGreaterThan(0);
  expect(engine.mcpConfig.mcpServers.orders).toEqual({ type: "http", url: gateway.url, headers: { "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": CLIENT_SECRET } });

  for (const secret of [CLIENT_ID, CLIENT_SECRET]) {
    expect(JSON.stringify(engine.env), "the engine's environment").not.toContain(secret);
    expect(JSON.stringify(engine.argv), "the engine's arguments").not.toContain(secret);
    expect(fx.logs(), "the servers' logs").not.toContain(secret);
    expect(answers.join("\n"), "what the routes answered").not.toContain(secret);
  }
  for (const read of [await as(admin, "GET", "/api/mcp/servers"), await as(admin, "GET", "/api/config"), await as(ada, "GET", "/api/team/my-connections"), await team.signed("GET", "/api/cloud/team/admin")]) {
    expect(JSON.stringify(read.body)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(read.body)).not.toContain(CLIENT_ID);
  }
}, hostTimeout(120_000));

it("keeps a one-key server Only for me: the admin's own chat gets it with their key, a member's chat doesn't", async () => {
  const own = "Bearer ben-own-key-5521";
  const mail = await startFakeHttpMcp({ tools: [{ name: "read_inbox" }], requireHeader: { name: "Authorization", value: own } });
  try {
    expect((await as(admin, "POST", "/api/mcp/servers", { name: "mail", type: "http", url: mail.url, headers: { Authorization: own } })).status).toBe(201);
    expect((await as(admin, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "mail", scope: "person" })).body).toEqual({ scopes: { apps: [], mcp: ["mail"] } });
    expect((await as(admin, "PUT", "/api/team/my-connections/mcp/mail/key", { value: own })).body).toEqual({ ok: true });
    expect((await as(admin, "POST", "/api/mcp/servers/mail/test")).body).toMatchObject({ ok: true });
    expect((await as(admin, "PATCH", "/api/mcp/servers/mail", { enabled: true })).status).toBe(200);

    const bens = await turn(admin, "Check my inbox.", [{ name: "read_inbox", server: "mail", input: {} }], "remote execution recorded");
    expect(bens.mcpConfig.mcpServers.mail).toMatchObject({ url: mail.url, headers: { Authorization: own } });
    expect(mail.calls).toHaveLength(1);
    const adas = await turn(ada, "Check the inbox.", [{ name: "read_inbox", server: "mail", input: {} }], "no mail MCP server was launched for this turn");
    expect(Object.keys(adas.mcpConfig.mcpServers)).not.toContain("mail");
    expect(JSON.stringify(adas)).not.toContain("ben-own-key-5521");
    expect(mail.calls).toHaveLength(1);
  } finally {
    await mail.close();
  }
}, hostTimeout(120_000));
