// A move to the person's own Cloud carries this computer's connections, end to end: this computer's server and a Cloud
// home (scripts/testing/cloud-send-fixture.ts), main's own functions between them (electron/cloud-connections.mjs) over
// the private port and the owner session, OpenMausBot's connected-apps service with a fake Composio behind it, a fake
// sign-in server for an MCP server's own account, and a fake HighLevel with its relay. Disposable homes; no network.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { collectConnections, sendConnections, type ConnectionsLocal, type ConnectionsTarget } from "../electron/cloud-connections.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { FAKE_LOCATION_ID, startFakeHighLevel, startFakeRelay, type FakeHighLevel, type FakeRelay } from "./testing/fake-highlevel.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

// Obvious fakes only.
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const DODO_KEY = `dodo_test_fake_${hex(12)}`;
const DOCS_TOKEN = `fake-docs-token-${hex(8)}`;
const CLIENT_SECRET = `fake-client-secret-${hex(8)}`;
const OPENROUTER_KEY = `sk-or-v1-fake${hex(16)}`;
const ACCESS = `fake-access-${hex(8)}`, REFRESH = `fake-refresh-${hex(8)}`;
const NEW_ACCESS = `fake-access-${hex(8)}`, NEW_REFRESH = `fake-refresh-${hex(8)}`;
const SECRETS = [DODO_KEY, DOCS_TOKEN, CLIENT_SECRET, OPENROUTER_KEY, ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH];
const TOKEN = `ops_fake-send-${hex(12)}`;
const LINEAR_URL = "https://mcp.linear.example.test/mcp";

/** A command-line MCP server that lists its tool only when started with the key it was made for: it works on My Cloud
 * only if the key arrived. Only the key's hash is in its arguments. */
const DODO_SERVER = `const k = process.env.DODO_PAYMENTS_API_KEY || "";
const ok = require("crypto").createHash("sha256").update(k).digest("hex") === ${JSON.stringify(createHash("sha256").update(DODO_KEY).digest("hex"))};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = message.method === "initialize" ? { protocolVersion: message.params && message.params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "dodo-fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: ok ? [{ name: "list_payments", description: "Payments", inputSchema: { type: "object", properties: {} } }] : [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});`;

let broker: BrokerFake;
let hl: FakeHighLevel;
let relay: FakeRelay;
let fx: CloudSendFixture;
let signIns: Server;
let tokenEndpoint = "";
/** Each refresh the sign-in server took: which refresh token, from which app. */
const refreshes: Array<{ refresh: string; client: string; secret: string }> = [];

beforeAll(async () => {
  broker = await startBrokerFake();
  hl = await startFakeHighLevel();
  relay = await startFakeRelay({ onAccessToken: (token) => hl.tokens.add(token) });
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, env: { OMB_HIGHLEVEL_RELAY_URL: relay.url, OMB_HIGHLEVEL_API_URL: hl.url } });
  signIns = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      refreshes.push({ refresh: form.get("refresh_token") ?? "", client: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" });
      const good = form.get("grant_type") === "refresh_token" && form.get("refresh_token") === REFRESH && form.get("client_secret") === CLIENT_SECRET;
      res.writeHead(good ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(good ? { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600, token_type: "Bearer" } : { error: "invalid_grant" }));
    });
  });
  await new Promise<void>((resolve) => signIns.listen(0, "127.0.0.1", resolve));
  tokenEndpoint = `http://127.0.0.1:${(signIns.address() as { port: number }).port}/token`;
}, hostTimeout(60_000));
afterAll(async () => {
  await fx?.close();
  await broker?.close();
  await relay?.close();
  await hl?.close();
  await new Promise((resolve) => signIns?.close(resolve));
});

const asLocal = (fixture: CloudSendFixture): ConnectionsLocal => ({ json: async (route) => (await fixture.local("GET", route)).body, handoff: (what) => fixture.handoff(what) });
const asTarget = (fixture: CloudSendFixture): ConnectionsTarget => ({
  call: async (method, route, body) => { const answer = await fixture.onCloud(method, route, body); return { ...answer, ok: answer.status >= 200 && answer.status < 300 }; },
});
/** The Cloud home's own installation on the connected-apps service: registered as it starts, acting as its own user. */
const cloudInstallationOf = async (others: string[]) => {
  const find = () => broker.installationIds().filter((id) => !others.includes(id) && broker.actingUser(id) === broker.userFor(id)).at(-1);
  await expect.poll(find, { timeout: 20_000 }).toBeTruthy();
  return find()!;
};

it("moves the MCP servers with their secrets and sign-ins, the keys and the connected apps once; this computer lets go of the sign-ins", async () => {
  const { local, onCloud } = fx;
  const cloudInstallation = await cloudInstallationOf([fx.desktopInstallation!.id]);
  const gmail = broker.account(fx.desktopInstallation!.userId, "gmail");

  for (const server of [
    { name: "dodo", command: "node", args: ["-e", DODO_SERVER], env: { DODO_PAYMENTS_API_KEY: DODO_KEY, DODO_PAYMENTS_ENVIRONMENT: "test_mode" } },
    { name: "docs", type: "http", url: "https://mcp.docs.example.test/mcp", headers: { Authorization: `Bearer ${DOCS_TOKEN}` } },
    { name: "linear", type: "http", url: LINEAR_URL, oauth: { clientId: "omb-fixture-client", clientSecret: CLIENT_SECRET } },
    { name: "notes", type: "http", url: "http://127.0.0.1:9/mcp" },
  ]) {
    expect((await local("POST", "/api/mcp/servers", server)).status).toBe(201);
    expect((await local("PATCH", `/api/mcp/servers/${server.name}`, { enabled: true })).status).toBe(200);
  }
  // Signed in to linear with its own account here, its access token already expired: My Cloud must refresh it itself.
  const desktopSignIns = join(fx.root, "desktop", ".openmausbot", "mcp-oauth.json");
  writeFileSync(desktopSignIns, JSON.stringify({ servers: { linear: { url: LINEAR_URL, state: "signed-in", clientId: "omb-fixture-client", tokenAuth: "client_secret_post",
    tokenEndpoint, tokens: { access: ACCESS, refresh: REFRESH, expiresAt: Date.now() - 60_000 } } } }));
  expect((await local("PATCH", "/api/config", { openrouter: { key: OPENROUTER_KEY } })).status).toBe(200);
  // HighLevel, signed in here through its relay: its refresh token rotates, so only one side may ever spend it.
  const started = await local("POST", "/api/highlevel/sign-in");
  relay.complete([...relay.states.keys()].at(-1)!);
  await expect.poll(async () => (await local("GET", `/api/highlevel/sign-in/${started.body.flowId}`)).body.phase, { timeout: 8_000, interval: 200 }).toBe("connected");
  const refreshToken = [...relay.refreshTokens][0]!;

  const collected = await collectConnections(asLocal(fx));
  expect(collected.connections.map((item) => item.id)).toEqual(["mcp:dodo", "mcp:docs", "mcp:linear", "mcp:notes", "key:openrouter", "composio", "highlevel"]);
  expect(collected.connections.find((item) => item.id === "highlevel")).toMatchObject({ signIn: true });
  expect(collected.connections.find((item) => item.id === "mcp:linear")).toMatchObject({ signIn: true });
  expect(collected.connections.find((item) => item.id === "mcp:notes")).toMatchObject({ runsHere: true });
  expect(collected.computer.label).toBeTruthy();

  const progress: string[] = [];
  const result = await sendConnections(collected, asTarget(fx), { local: asLocal(fx), onProgress: ({ label }) => progress.push(label) });
  expect(result.failed).toEqual([]);
  expect(result.moved.map((item) => item.id)).toEqual(["key:openrouter", "mcp:dodo", "mcp:docs", "mcp:linear", "highlevel", "composio"]);
  expect(result.runsHere).toEqual([{ id: "mcp:notes", label: "notes" }]);
  expect(result.kept).toEqual([]);
  expect(result.release).toEqual([]);
  expect(progress).toEqual(["OpenRouter", "dodo", "docs", "linear", "notes", "HighLevel", "Connected apps"]);

  // The MCP servers arrived with their secrets, on, and the command-line one works there with its key.
  const servers = (await onCloud("GET", "/api/mcp/servers")).body.servers as Array<Record<string, unknown>>;
  expect(servers.map((server) => server.name).sort()).toEqual(["docs", "dodo", "linear", "notes"]);
  expect(servers.find((server) => server.name === "dodo")).toMatchObject({ enabled: true, envKeys: ["DODO_PAYMENTS_API_KEY", "DODO_PAYMENTS_ENVIRONMENT"] });
  expect(servers.find((server) => server.name === "docs")).toMatchObject({ enabled: true, headerKeys: ["Authorization"] });
  expect(servers.find((server) => server.name === "linear")).toMatchObject({ auth: "signed-in", oauth: { clientId: "omb-fixture-client", clientSecretConfigured: true } });
  expect((await onCloud("POST", "/api/mcp/servers/dodo/test")).body).toMatchObject({ ok: true, tools: [expect.objectContaining({ name: "list_payments" })] });

  // The server that needs this computer is kept there, marked as running here, and never started there.
  expect(servers.find((server) => server.name === "notes")).toMatchObject({ enabled: true, runsOn: collected.computer });
  const notesTest = await onCloud("POST", "/api/mcp/servers/notes/test");
  expect(notesTest).toMatchObject({ status: 409, body: { error: `This server runs on ${collected.computer.label}, so it isn't started here.` } });

  // The sign-in moved: My Cloud refreshes it with the refresh token and the app's secret that came over...
  await onCloud("POST", "/api/mcp/servers/linear/test");
  expect(refreshes).toEqual([{ refresh: REFRESH, client: "omb-fixture-client", secret: CLIENT_SECRET }]);
  expect((await onCloud("GET", "/api/mcp/servers")).body.servers.find((server: { name: string }) => server.name === "linear")).toMatchObject({ auth: "signed-in" });
  // ...and this computer let go of its own copy, without signing it out, so it never spends that refresh token too.
  expect(JSON.parse(readFileSync(desktopSignIns, "utf8")).servers.linear).toBeUndefined();
  expect((await local("GET", "/api/mcp/servers")).body.servers.find((server: { name: string }) => server.name === "linear").auth).toBeUndefined();

  // HighLevel moved with its sign-in, which only My Cloud holds now; nothing spent its refresh token on the way.
  expect((await onCloud("GET", "/api/highlevel")).body).toMatchObject({ state: "connected", kind: "oauth", location: { id: FAKE_LOCATION_ID } });
  expect((await local("GET", "/api/highlevel")).body).toEqual({ state: "signed-out" });
  expect(relay.refreshes).toBe(0);
  expect(relay.refreshTokens.has(refreshToken)).toBe(true);
  SECRETS.push(refreshToken, ...relay.issued);

  // The key arrived, and so did its engine, before anything that follows it.
  expect((await onCloud("GET", "/api/config")).body.openrouter).toMatchObject({ configured: true });
  expect((await onCloud("GET", "/api/cloud-connections")).body.engines).toContain("openrouter");

  // My Cloud acts as this computer's connected-apps user: Gmail, connected here, is connected there with no sign-in.
  expect(broker.actingUser(cloudInstallation)).toBe(fx.desktopInstallation!.userId);
  expect((await onCloud("GET", "/api/connectors/connected")).body.services.gmail).toMatchObject({ connected: true, accounts: [expect.objectContaining({ id: gmail })] });

  // A bot there that reaches for the server of this computer's is told so, in its prompt.
  const bot = (await onCloud("POST", "/api/bots", { name: "Dodo tracker" })).body.bot;
  expect((await onCloud("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["dodo", "docs", "linear", "notes"] })).status).toBe(200);
  const sections = (await onCloud("GET", `/api/bots/${bot.id}/system-prompt`)).body.sections as Array<{ id: string; text?: string }>;
  expect(sections.find((section) => section.id === "to-connect")?.text)
    .toBe(` Runs only on the person's computer ${collected.computer.label}, not on My Cloud: notes. If a task needs one, say so in plain words.`);

  // Moving again changes nothing and spends nothing.
  const again = await sendConnections(await collectConnections(asLocal(fx)), asTarget(fx), { local: asLocal(fx) });
  expect(again.failed).toEqual([]);
  expect(refreshes).toHaveLength(1);
  expect(broker.actingUser(cloudInstallation)).toBe(fx.desktopInstallation!.userId);

  for (const where of [...fx.answers, fx.logs(), JSON.stringify(collected)]) for (const value of SECRETS) expect(where).not.toContain(value);
}, hostTimeout(120_000));

it("a My Cloud with connected apps of its own keeps them, and a bot there is told which of its apps to connect once", async () => {
  const fresh = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker });
  try {
    const cloudInstallation = await cloudInstallationOf([fresh.desktopInstallation!.id, fx.desktopInstallation!.id]);
    const ownSlack = broker.account(broker.userFor(cloudInstallation), "slack");
    broker.account(fresh.desktopInstallation!.userId, "gmail");
    broker.account(fresh.desktopInstallation!.userId, "slack");

    const result = await sendConnections(await collectConnections(asLocal(fresh)), asTarget(fresh), { local: asLocal(fresh) });
    expect(result.failed).toEqual([]);
    expect(result.kept).toEqual([{ id: "composio", label: "Connected apps" }]);
    expect(result.missing).toEqual([{ slug: "gmail" }]);
    expect(broker.actingUser(cloudInstallation)).toBe(broker.userFor(cloudInstallation));
    const connected = (await fresh.onCloud("GET", "/api/connectors/connected")).body.services;
    expect(connected.slack).toMatchObject({ connected: true, accounts: [expect.objectContaining({ id: ownSlack })] });
    expect(connected.gmail).toBeUndefined();

    // A bot there with Gmail assigned (as one that came from this computer has it) is told to show the person the card
    // that connects it; once it is connected there, the line goes. A bot's apps are assigned only while connected there.
    const bot = (await fresh.onCloud("POST", "/api/bots", { name: "Inbox" })).body.bot;
    const lent = broker.account(broker.userFor(cloudInstallation), "gmail");
    expect((await fresh.onCloud("PATCH", `/api/bots/${bot.id}`, { connectorTools: { gmail: { tools: "*" }, slack: { tools: "*" } } })).status).toBe(200);
    expect((await broker.expire(lent)).status).toBe(200);
    const told = async () => ((await fresh.onCloud("GET", `/api/bots/${bot.id}/system-prompt`)).body.sections as Array<{ id: string; text?: string }>)
      .find((section) => section.id === "to-connect")?.text ?? "";
    await expect.poll(told, { timeout: 20_000, interval: 500 })
      .toBe(" Assigned to this bot but not connected on My Cloud yet: Gmail. When a task needs one, call COMPOSIO_MANAGE_CONNECTIONS for it, which shows the person a card to connect it, and end the turn.");
    broker.account(broker.userFor(cloudInstallation), "gmail");
    await expect.poll(told, { timeout: 40_000, interval: 2_000 }).toBe("");
  } finally {
    await fresh.close();
  }
}, hostTimeout(120_000));
