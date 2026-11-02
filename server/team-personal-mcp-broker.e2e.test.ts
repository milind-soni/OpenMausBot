// A Team Cloud member's own remote MCP server, and the team's server behind a gateway, reached from a boxed turn: the
// turn's server list points the engine at the box's credential broker, which adds each server's headers (the member's
// own key, the gateway's service-token headers) and forwards to the server. A server that answers only at its own path,
// as a Cloudflare Worker serves /mcp and not /mcp/, must be reached at exactly that path. The box itself is Linux-only,
// so a loopback listener bridged to the broker's socket stands in for the box's bridge, and the MCP client is the one
// the server's own probes use.
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BOX_BROKER_PORT, type BoxBroker } from "./bot-box/box.ts";
import { brokerRemoteMcp, forgetBrokeredMcp } from "./bot-box/broker-mcp.ts";
import { openCredentialBroker, type CredentialBroker } from "./bot-box/broker.ts";
import type { AppConfig } from "./config.ts";
import type { McpServerSpec, RemoteMcpSpec } from "./contracts.ts";
import { createTeamConnectionsHost } from "./host/team-connections-host.ts";
import { RemoteMcpClient } from "./mcp-http.ts";
import { McpOAuthManager } from "./mcp-oauth.ts";
import { probeMcpServer } from "./mcp-probe.ts";
import { personKey } from "./person-key.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

const ADA = personKey({ id: "", email: "ada@acme.test" });
const ADA_KEY = "Bearer ada-own-wedding-key";
const CLIENT_ID = "5c1d0e9a.access", CLIENT_SECRET = "0f9e8d7c6b5a4938271605";

// The broker listens on a unix socket, which Windows refuses at a file path; the box runs only on a Linux Cloud home.
describe.skipIf(process.platform === "win32")("a member's own MCP server and the team's gateway server, from a boxed turn", () => {
  let dir = "", own: FakeHttpMcp, gateway: FakeHttpMcp, credentials: CredentialBroker, bridge: Server, broker: BoxBroker;
  let mounted: Record<string, McpServerSpec> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-team-box-mcp-"));
    own = await startFakeHttpMcp({ exactPath: true, tools: [{ name: "plan_seating" }], requireHeader: { name: "Authorization", value: ADA_KEY } });
    gateway = await startFakeHttpMcp({
      exactPath: true, tools: [{ name: "lookup_order" }],
      requireHeaders: { "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": CLIENT_SECRET, Authorization: "Bearer team-orders" },
    });
    const cfg = { mcpServers: {
      "mi-boda-hq": { type: "http", url: own.url, headers: { Authorization: "Bearer the-admin's-own" }, enabled: true },
      orders: { type: "http", url: gateway.url, headers: { Authorization: "Bearer team-orders", "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": CLIENT_SECRET }, enabled: true },
    } } as unknown as AppConfig;
    const host = createTeamConnectionsHost({
      team: { id: "team-acme-1", name: "Acme" }, dataDir: dir, cfg: () => cfg, adminOrigin: "https://cloud.example.test", harnessUrl: "http://127.0.0.1:1",
      audienceOf: (threadId) => (threadId === "ada-chat" ? `member:${ADA}` : "team"),
      requester: (threadId) => (threadId === "ada-chat" ? ADA : null),
      mint: (capability) => `tok-${capability.threadId}`,
      mcpOAuth: new McpOAuthManager({ file: join(dir, "mcp-oauth.json") }),
      botMcp: () => Object.fromEntries(Object.entries(cfg.mcpServers ?? {}).map(([name, raw]) => {
        const server = raw as { url: string; headers: Record<string, string> };
        return [name, { type: "http", url: server.url, headers: server.headers } as McpServerSpec];
      })),
      isSessionLive: () => true,
      brokerUrl: () => null,
      composio: { configured: () => false, mcpIntegration: async () => null, connectedServices: async () => ({}), connectedServiceSlugs: async () => [], authorizeService: async () => { throw new Error("unused"); }, removeService: async () => {} } as never,
    });
    // Ada connects the wedding server with her own key; the gateway server stays the team's.
    host.scopes.set("mcp", "mi-boda-hq", "person");
    host.people.putKey(ADA, "ada@acme.test", "mi-boda-hq", { url: own.url, header: "Authorization", value: ADA_KEY });

    credentials = await openCredentialBroker({ socketPath: join(dir, "broker.sock") });
    // Inside a box, 127.0.0.1:<broker port> is a bridge to the broker's socket; a TCP listener stands in for it here.
    bridge = createServer((socket) => {
      const upstream = connect(credentials.socketPath);
      socket.pipe(upstream).pipe(socket);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    broker = { port: (bridge.address() as AddressInfo).port, mintForThread: credentials.mintForThread, touchThread: credentials.touchThread, revokeThread: credentials.revokeThread, lookup: credentials.lookup };
    expect(BOX_BROKER_PORT).toBe(18080);

    // Ada's own turn in her private chat, as the server mounts it for a boxed engine.
    const custom = await host.turnMcp({ id: "scout", name: "Scout" }, "ada-chat", "gen-1");
    expect((custom["mi-boda-hq"] as RemoteMcpSpec).headers).toEqual({ Authorization: ADA_KEY });
    mounted = brokerRemoteMcp(custom, { botId: "scout", threadId: "ada-chat" }, broker);
  });

  afterAll(async () => {
    forgetBrokeredMcp();
    await new Promise((resolve) => bridge?.close(resolve));
    await credentials?.close();
    await own?.close();
    await gateway?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("gives the engine only the broker's address for each, with no header", () => {
    for (const name of ["mi-boda-hq", "orders"]) {
      const server = mounted[name] as RemoteMcpSpec;
      expect(server.url, name).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${broker.port}/b/omb_t0_[a-f0-9]{48}/mcp-${name}$`));
      expect(server.headers, name).toEqual({});
    }
    const listed = JSON.stringify(mounted);
    for (const secret of [ADA_KEY, CLIENT_SECRET, "team-orders"]) expect(listed).not.toContain(secret);
  });

  it("reaches each server at exactly its own path, with its headers, and calls its tools", async () => {
    for (const [name, server, tool] of [["mi-boda-hq", own, "plan_seating"], ["orders", gateway, "lookup_order"]] as const) {
      expect(await probeMcpServer({ ...(mounted[name] as RemoteMcpSpec), enabled: true }), name).toMatchObject({ ok: true, tools: [{ name: tool }] });
      const client = new RemoteMcpClient(mounted[name] as RemoteMcpSpec);
      const signal = AbortSignal.timeout(10_000);
      await client.initialize("engine", signal);
      expect(await client.request("tools/call", { name: tool, arguments: {} }, signal), name).toEqual({ content: [{ type: "text", text: "remote execution recorded" }] });
      await client.close();
      expect(server.seenPaths.length, name).toBeGreaterThanOrEqual(3);
      expect(server.seenPaths.map((path) => path.split("?")[0]), name).toEqual(server.seenPaths.map(() => "/mcp"));
    }
    expect(own.seenHeaders.every((headers) => headers.authorization === ADA_KEY), "only Ada's own key, never the admin's").toBe(true);
  });
});
