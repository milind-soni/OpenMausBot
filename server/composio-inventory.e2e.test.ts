import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import * as composio from "./composio.ts";
import { createTeamConnectionsHost } from "./host/team-connections-host.ts";

const directories: string[] = [];
afterEach(() => {
  composio.setManagedBrokerAccess(null);
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each(["connected_accounts", "toolkits"])("refuses opaque calls from the actual broker's malformed %s inventory", async (walker) => {
  const { brokerHarness } = await import(new URL("../cloudflare/composio-broker/src/test-harness.ts", import.meta.url).href);
  const h = brokerHarness();
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  try {
    const owner = await h.install();
    const gmail = h.account(owner);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(`/${walker}`)) return Response.json({ items: [{}] });
      if (path.endsWith("/connected_accounts") || path.endsWith("/toolkits")) return Response.json({ items: [] });
      return h.composio.fetchImpl(input, init);
    });
    const inventory = await h.call(owner, "/v1/connectors/connected");
    const body = await inventory.json();
    vi.stubGlobal("fetch", h.composio.fetchImpl);
    const rpc = await h.call(owner, "/v1/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: {} } }),
    });
    const result = await rpc.json() as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(result.result.content[0]!.text)).toMatchObject({ accounts: [gmail] });

    composio.setManagedBrokerAccess({ url: `https://malformed.test/${walker}`, token: owner.token });
    vi.stubGlobal("fetch", async () => Response.json(body, { status: inventory.status }));
    const dataDir = mkdtempSync(join(tmpdir(), "omb-inventory-e2e-"));
    directories.push(dataDir);
    const host = createTeamConnectionsHost({
      team: { id: "fixture", name: "Fixture" }, dataDir, cfg: () => ({}), adminOrigin: null,
      harnessUrl: "http://127.0.0.1:1", audienceOf: () => "room:fixture", requester: () => null,
      mint: () => "fixture", mcpOAuth: {} as never, botMcp: () => ({}), isSessionLive: () => true,
      brokerUrl: () => null, composio,
    });
    host.scopes.set("app", "gmail", "person");
    await expect(host.callRefusal({ threadId: "room", generation: "g" }, [{ slug: "COMPOSIO_PROXY_EXECUTE" }]))
      .resolves.toEqual(expect.stringMatching(/inventory.*could not be verified/));
    expect(inventory.status).toBe(503);
  } finally {
    h.d1.db.close();
  }
});

it.each(["legacy", "incomplete", "cycle", "page cap"])("ordinary calls keep their cached service inventory during %s discovery failure", async (failure) => {
  let mode = "complete";
  const executed: string[] = [];
  const broker = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/connectors/connected") {
      if (mode === "cycle" || mode === "page cap") {
        res.writeHead(503);
        return res.end(JSON.stringify({ error: "service unavailable" }));
      }
      return res.end(JSON.stringify({ services: { slack: { connected: true }, bland: { connected: true }, bland_ai: { connected: true } },
        ...(mode === "legacy" ? {} : { complete: mode === "complete" }) }));
    }
    if (req.url === "/v1/mcp") {
      const frame = JSON.parse(raw);
      executed.push(frame.params.name);
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id,
        result: { content: [{ type: "text", text: "synthetic direct tool success" }] } }));
    }
    res.writeHead(404);
    res.end("{}");
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback broker port");
  const scratch = mkdtempSync(join(tmpdir(), "omb-direct-inventory-"));
  directories.push(scratch);
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    fixture = await launchVerificationServer({ ...process.env,
      OMB_COMPOSIO_BROKER_URL: `http://127.0.0.1:${address.port}`, OMB_COMPOSIO_BROKER_TOKEN: "c".repeat(64),
      FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(scratch, "finish"),
    });
    const api = async (method: string, path: string, body: unknown) => {
      const response = await fetch(fixture!.info.url + path, { method,
        headers: { "content-type": "application/json", origin: fixture!.info.url }, body: JSON.stringify(body) });
      const result = await response.json() as any;
      expect(response.status, JSON.stringify(result)).toBeLessThan(300);
      return result;
    };
    const { bot } = await api("POST", "/api/bots", { name: "Fixture" });
    await api("PATCH", `/api/bots/${bot.id}`, { composio: true, approvalMode: "full", connectorTools: { slack: { tools: "*" }, bland: { tools: "*" } } });
    await api("POST", `/api/bots/${bot.id}/messages`, {
      threadId: bot.threadId, text: "Hold the fixture turn", sendId: "direct-inventory-fixture-0001",
    });
    let bridge: { env: Record<string, string> } | undefined;
    await expect.poll(() => {
      try { bridge = JSON.parse(readFileSync(fixture!.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.composio; }
      catch { return false; }
      return Boolean(bridge);
    }, { timeout: 20_000 }).toBe(true);
    const call = async (name: string) => {
      const response = await fetch(bridge!.env.OMB_CONNECTOR_UPSTREAM_URL!, { method: "POST",
        headers: { ...JSON.parse(bridge!.env.OMB_CONNECTOR_UPSTREAM_HEADERS!), "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name, arguments: {} } }),
      });
      const body = await response.json() as any;
      expect.soft(response.status, JSON.stringify(body)).toBe(200);
      return body;
    };
    mode = failure;
    await api("PATCH", `/api/bots/${bot.id}`, { connectorTools: null });
    expect((await call("SLACK_LIST_CHANNELS")).result).toEqual({ content: [{ type: "text", text: "synthetic direct tool success" }] });
    expect(executed).toEqual(["SLACK_LIST_CHANNELS"]);
    for (const permissions of [
      { connectorScopes: { apps: { slack: "read", bland: "write" } } },
      { connectorScopes: null, connectorTools: { slack: { tools: "*" }, bland: { tools: "*" } } },
    ]) {
      await api("PATCH", `/api/bots/${bot.id}`, permissions);
      expect((await call("SLACK_LIST_CHANNELS")).result).toEqual({ content: [{ type: "text", text: "synthetic direct tool success" }] });
      expect((await call("BLAND_AI_SEND_MESSAGE")).result.isError).toBe(true);
    }
    expect(executed).toEqual(["SLACK_LIST_CHANNELS", "SLACK_LIST_CHANNELS", "SLACK_LIST_CHANNELS"]);
  } finally {
    await fixture?.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
}, 60_000);
