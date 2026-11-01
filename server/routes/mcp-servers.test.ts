import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type RequestOptions, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openCredentialBroker, type CredentialBroker } from "../bot-box/broker.ts";
import type { BrokerPath } from "../bot-box/broker-probe.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import type { TeamConnectionsHost } from "../host/team-connections-host.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { listMcpServers } from "../mcp-registry.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { createMcpServerRoutes } from "./mcp-servers.ts";
import { dispatchRoutes } from "./table.ts";

let server: Server | undefined;
afterEach(async () => {
  const active = server;
  server = undefined;
  if (active) await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
});

async function serve(options: { botsPath?: () => BrokerPath | null } = {}) {
  const cfg: Pick<AppConfig, "mcpServers"> = { mcpServers: {} };
  const changes: string[] = [];
  let busy = false;
  const route = createMcpServerRoutes({
    cfg,
    sessions: { isLive: () => true },
    mcpOAuth: new McpOAuthManager({ file: join(DATA_DIR, "mcp-route-oauth.json") }),
    teamConnections: { personMcp: () => ["private"], people: {} as TeamConnectionsHost["people"] },
    cloudHome: null,
    fallbackPublicUrl: null,
    mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
    mcpServerResponse: () => ({ servers: listMcpServers(cfg.mcpServers) }),
    mcpPolicyRefusal: () => undefined,
    persistMcpServers: (next) => { cfg.mcpServers = next; },
    savedCustomDomain: () => null,
    connectionsChanged: (change) => { changes.push(change); },
    ...(options.botsPath ? { botsPath: options.botsPath } : {}),
  });
  const active = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes([route], {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
  });
  server = active;
  await new Promise<void>((ready) => active.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(active.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { cfg, post, changes, get: () => fetch(`${base}/api/mcp/servers`), remove: (name: string) => fetch(`${base}/api/mcp/servers/${name}`, { method: "DELETE" }) };
}

it("says when a server is added, imported or removed on purpose, so a Cloud home's routines can wait while none is left", async () => {
  const { post, remove, changes } = await serve();
  const added = await post("/api/mcp/servers", { name: "warehouse", url: "https://data.example.com/mcp", headers: { Authorization: "" } });
  expect(added.status, await added.clone().text()).toBe(201);
  const imported = await post("/api/mcp/servers/import", { json: JSON.stringify({ mcpServers: { nightwatch: { type: "http", url: "https://nightwatch.example.com/mcp" } } }) });
  expect(imported.status, await imported.clone().text()).toBe(201);
  expect((await remove("warehouse")).status).toBe(200);
  expect((await remove("missing")).status).toBe(404);
  expect(changes).toEqual(["added", "added", "removed"]);
});

it.each([["private", "person"], ["public", "team"]])("lists the scope of %s in reads and mutation responses", async (name, scope) => {
  const { post, get } = await serve();
  const response = await post("/api/mcp/servers", { name, url: "https://mail.example.com/mcp", headers: { Authorization: "" } });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ servers: [{ name, scope }] });
  expect(await (await get()).json()).toMatchObject({ servers: [{ name, scope }] });
});

it.each(["create", "import"])("rejects personal header values on %s without saving any server", async (action) => {
  const { cfg, post } = await serve();
  const entry = { url: "https://mail.example.com/mcp", headers: { Authorization: "Bearer private-secret" } };
  const response = action === "create"
    ? await post("/api/mcp/servers", { name: "private", ...entry })
    : await post("/api/mcp/servers/import", { json: JSON.stringify({ mcpServers: { public: { url: "https://public.example.com/mcp" }, private: entry } }) });

  expect(response.status).toBe(400);
  const body = await response.json() as { error: string };
  expect(body.error).toMatch(/personal.*header|header.*personal/i);
  expect(JSON.stringify(body)).not.toContain("private-secret");
  expect(cfg.mcpServers).toEqual({});
});

it.each(["create", "import"])("accepts blank personal headers on %s and retains team header values", async (action) => {
  const { cfg, post } = await serve();
  for (const [name, value] of [["private", ""], ["public", "Bearer team-secret"]] as const) {
    const entry = { type: "http", url: "https://mail.example.com/mcp", headers: { Authorization: value } };
    const response = action === "create"
      ? await post("/api/mcp/servers", { name, ...entry })
      : await post("/api/mcp/servers/import", { json: JSON.stringify({ mcpServers: { [name]: entry } }) });
    expect(response.status).toBe(201);
    expect(cfg.mcpServers?.[name]).toMatchObject({ headers: { Authorization: value } });
  }
});

// The broker listens on a unix socket, which Windows refuses at a file path; the box runs only on a Linux Cloud home.
describe.skipIf(process.platform === "win32")("Test, where bots reach URL servers through the credential broker", () => {
  const HEADERS = { Authorization: "Bearer team-orders", "CF-Access-Client-Id": "5c1d0e9a.access", "CF-Access-Client-Secret": "0f9e8d7c6b5a4938271605" };
  let dir = "", broker: CredentialBroker | undefined, mcp: FakeHttpMcp | undefined;
  afterEach(async () => {
    await broker?.close();
    await mcp?.close();
    broker = undefined; mcp = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  /** A broker; `slash` forwards a request for the server's own address with a slash added, as the broker once did. */
  async function brokerPath(slash = false): Promise<BrokerPath> {
    dir = mkdtempSync(join(tmpdir(), "omb-mcp-test-route-"));
    const request = ((target: RequestOptions, callback: Parameters<typeof httpRequest>[1]) =>
      httpRequest({ ...target, path: slash ? String(target.path).replace(/^\/mcp(?=\?|$)/, "/mcp/") : target.path }, callback as never)) as typeof httpRequest;
    broker = await openCredentialBroker({ socketPath: join(dir, "b.sock"), request });
    return { broker: { port: 18080, mintForThread: broker.mintForThread, revokeThread: broker.revokeThread }, socketPath: broker.socketPath };
  }
  async function tested(path: BrokerPath, url: string) {
    const route = await serve({ botsPath: () => path });
    expect((await route.post("/api/mcp/servers", { name: "orders", type: "http", url, headers: HEADERS })).status).toBe(201);
    return await (await route.post("/api/mcp/servers/orders/test", {})).json() as Record<string, unknown>;
  }

  it("connects through the broker, which adds the server's headers, as a bot's turn does", async () => {
    mcp = await startFakeHttpMcp({ exactPath: true, tools: [{ name: "lookup_order" }], requireHeaders: HEADERS });
    expect(await tested(await brokerPath(), mcp.url)).toMatchObject({ ok: true, tools: [{ name: "lookup_order" }] });
    expect(broker!.stats(), "every request went through the broker, and its grant is gone").toMatchObject({ tokens: 0 });
    expect(broker!.stats().forwarded).toBeGreaterThanOrEqual(2);
  });

  it("never says Connected when bots can't reach a server that answers directly, and says the fault is ours", async () => {
    mcp = await startFakeHttpMcp({ exactPath: true, tools: [{ name: "lookup_order" }], requireHeaders: HEADERS });
    const result = await tested(await brokerPath(true), mcp.url);
    expect(result).toEqual({ ok: false, reason: "unreachable", error: "Your bots can't reach this server: The server answered HTTP 404. It answers when tested directly, so the fault is on our side, not in your settings: tell us with @devs in any chat." });
  });

  it("says a server that answers neither way can't be reached, as before", async () => {
    mcp = await startFakeHttpMcp({});
    const url = mcp.url;
    await mcp.close();
    mcp = undefined;
    expect(await tested(await brokerPath(), url)).toEqual({ ok: false, error: "Could not reach this address. Check the URL and your network.", reason: "unreachable" });
  });
});
