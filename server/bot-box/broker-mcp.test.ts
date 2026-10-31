import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { customMcpServers, loadConfig, saveConfig } from "../config.ts";
import type { McpServerSpec, RemoteMcpSpec } from "../contracts.ts";
import { attachCustomMcp, prepareCustomMcp } from "../mcp-result-budget.ts";
import { McpOAuthManager, withMcpSignIn } from "../mcp-oauth.ts";
import { McpOAuthStore } from "../mcp-oauth-store.ts";
import { RemoteMcpClient } from "../mcp-http.ts";
import { probeMcpServer } from "../mcp-probe.ts";
import { startFakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { botBox, BOX_BROKER_PORT, type BoxBroker } from "./box.ts";
import { brokerRemoteMcp, forgetBrokeredMcp, mcpGrantName, mcpReconnectLine, retryBrokeredMcp } from "./broker-mcp.ts";
import { openCredentialBroker, type CredentialBroker } from "./broker.ts";

const custom = {
  notion: { type: "http" as const, url: "https://mcp.notion.example/mcp", headers: { authorization: "Bearer notion-secret" } },
  files: { command: "npx", args: ["files-mcp"], env: { FILES_TOKEN: "stdio-secret" } },
};

describe("remote MCP servers through the broker", () => {
  let dir: string, credentials: CredentialBroker;
  afterEach(async () => { vi.restoreAllMocks(); await credentials?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); forgetBrokeredMcp(); });
  // The broker listens on a unix socket, which Windows refuses at a file path; the box runs only on a Linux Cloud home
  // (detect.ts says "not-linux" anywhere else), so Windows gets "off" below.
  const withBroker = it.skipIf(process.platform === "win32");
  const broker = async (now?: () => number): Promise<BoxBroker> => {
    dir = mkdtempSync(join(tmpdir(), "omb-bmcp-"));
    credentials = await openCredentialBroker({ socketPath: join(dir, "b.sock"), now });
    return { port: BOX_BROKER_PORT, mintForThread: credentials.mintForThread, touchThread: credentials.touchThread, revoke: credentials.revoke, revokeThread: credentials.revokeThread, lookup: credentials.lookup };
  };

  const call = (url: string) => new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: credentials.socketPath, path: new URL(url).pathname }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });

  withBroker.each(["headers", "url", "removed", "stdio", "empty"])("revokes the old grant when the turn's MCP configuration is %s", async (change) => {
    let clock = 1_800_000_000_000;
    const b = await broker(() => clock);
    const upstream = createHttpServer((req, res) => { res.writeHead(req.headers.authorization === "Bearer notion-secret" ? 200 : 403).end(); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const servers = { ...custom, notion: { ...custom.notion, url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp` } };
      const turn = { botId: "b1", threadId: "t1" };
      const first = (brokerRemoteMcp(servers, turn, b).notion as RemoteMcpSpec).url;
      const other = (brokerRemoteMcp(servers, { ...turn, threadId: "t2" }, b).notion as RemoteMcpSpec).url;
      expect(await call(first)).toBe(200);
      const changed: Record<string, McpServerSpec> = change === "empty" ? {} : change === "removed" ? { files: custom.files }
        : { ...servers, notion: change === "stdio" ? custom.files : { ...servers.notion, ...(change === "url" ? { url: `${servers.notion.url}-new` } : { headers: { authorization: "Bearer rotated" } }) } };
      brokerRemoteMcp(changed, turn, b);
      const statusAtChange = await call(first);
      expect(await call(other)).toBe(200);
      clock += 13 * 60 * 60_000;
      brokerRemoteMcp(changed, turn, b);
      clock += 12 * 60 * 60_000;
      brokerRemoteMcp(changed, turn, b);
      expect(await call(first)).toBe(401);
      expect(statusAtChange).toBe(401);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  withBroker.each(["headers", "url", "disabled", "removed", "empty"])("revokes affected conversations immediately when saved MCP configuration is %s", async (change) => {
    const b = await broker();
    const turn = { botId: "b1", threadId: "t1" };
    const notion = { ...custom.notion, enabled: true };
    saveConfig({ mcpServers: { notion, files: custom.files } });
    const first = (brokerRemoteMcp(custom, turn, b).notion as RemoteMcpSpec).url;
    const token = new URL(first).pathname.split("/")[2]!;
    expect(credentials.lookup(token, "mcp-notion").ok).toBe(true);
    const other = (brokerRemoteMcp({ docs: custom.notion }, { ...turn, threadId: "t2" }, b).docs as RemoteMcpSpec).url;
    const next = change === "empty" ? {} : change === "removed" ? { files: custom.files }
      : { notion: { ...notion, ...(change === "url" ? { url: "https://new.example/mcp" } : change === "disabled" ? { enabled: false } : { headers: { authorization: "Bearer rotated" } }) }, files: custom.files };
    saveConfig({ mcpServers: next });
    expect(credentials.lookup(token, "mcp-notion").ok).toBe(false);
    expect(credentials.lookup(new URL(other).pathname.split("/")[2]!, "mcp-docs").ok).toBe(true);
  });

  withBroker("reconciles an empty server list through the turn integration caller", async () => {
    const b = await broker();
    vi.spyOn(botBox, "broker").mockReturnValue(b);
    const turn = { botId: "b1", threadId: "t1" };
    const first = (brokerRemoteMcp(custom, turn, b).notion as RemoteMcpSpec).url;
    const integrations = {};
    attachCustomMcp(integrations, {}, {}, turn);
    expect(integrations).toEqual({});
    expect(credentials.lookup(new URL(first).pathname.split("/")[2]!, "mcp-notion").ok).toBe(false);
  });

  withBroker("does not regrant a removed server after another server's OAuth refresh resumes", async () => {
    const b = await broker();
    vi.spyOn(botBox, "broker").mockReturnValue(b);
    let entered!: () => void, resume!: () => void;
    const refreshing = new Promise<void>((resolve) => { entered = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    const upstream = createHttpServer((req, res) => {
      if (req.url === "/token") {
        entered();
        void release.then(() => res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ access_token: "refreshed", token_type: "Bearer", expires_in: 3600 })));
      } else res.writeHead(req.headers.authorization === "Bearer notion-secret" ? 200 : 403).end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const file = join(dir, "oauth.json");
    const manager = new McpOAuthManager({ file });
    new McpOAuthStore(file).put("slow", { url: `${url}/slow`, state: "signed-in", clientId: "fixture",
      tokenEndpoint: `${url}/token`, tokens: { access: "expired", refresh: "refresh", expiresAt: 1 } });
    try {
      const notion = { ...custom.notion, url: `${url}/mcp`, enabled: true };
      const slow = { type: "http", url: `${url}/slow`, headers: {}, enabled: true };
      saveConfig({ mcpServers: { notion, slow } });
      const cfg = loadConfig(), turn = { botId: "b1", threadId: "t1" };
      const first = (brokerRemoteMcp(customMcpServers(cfg), turn, b).notion as RemoteMcpSpec).url;
      expect(await call(first)).toBe(200);
      const integrations: Parameters<typeof attachCustomMcp>[0] = {};
      const pending = prepareCustomMcp(integrations, withMcpSignIn(customMcpServers(cfg), manager), cfg, turn)
        .then(() => null, (error: unknown) => error);
      await refreshing;
      saveConfig({ mcpServers: { slow } });
      expect(await call(first)).toBe(401);
      resume();
      const error = await pending;
      const stale = integrations.custom?.notion as RemoteMcpSpec | undefined;
      expect(stale ? await call(stale.url) : 401).toBe(401);
      expect(error).toBeInstanceOf(Error);
      expect(credentials.stats().tokens).toBe(0);
    } finally {
      resume();
      manager.dispose();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  withBroker("moves a URL server's headers to the broker and leaves stdio servers alone", async () => {
    const out = brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, await broker());
    expect(out.files).toEqual(custom.files);
    const notion = out.notion as { type: string; url: string; headers: Record<string, string> };
    expect(notion.type).toBe("http");
    expect(notion.headers).toEqual({});
    const match = /^http:\/\/127\.0\.0\.1:18080\/b\/(omb_t0_[a-f0-9]{48})\/mcp-notion$/.exec(notion.url);
    expect(match).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain("notion-secret");
    expect(credentials.lookup(match![1]!, "mcp-notion")).toMatchObject({ ok: true, botId: "b1", threadId: "t1", grant: { upstream: "https://mcp.notion.example/mcp", headers: { authorization: "Bearer notion-secret" } } });
    expect(credentials.lookup(match![1]!, "mcp-files").ok).toBe(false);
  });

  withBroker("the same conversation keeps its token across turns; another conversation or changed headers get a new one", async () => {
    const b = await broker();
    const url = (servers: Record<string, unknown>) => (servers.notion as { url: string }).url;
    const first = url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, b));
    expect(url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, b))).toBe(first);
    expect(url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t2" }, b))).not.toBe(first);
    const changed = { ...custom, notion: { ...custom.notion, headers: { authorization: "Bearer rotated" } } };
    expect(url(brokerRemoteMcp(changed, { botId: "b1", threadId: "t1" }, b))).not.toBe(first);
    credentials.revokeThread("t1");
    expect(url(brokerRemoteMcp(changed, { botId: "b1", threadId: "t1" }, b))).not.toBe(first);
    expect(credentials.stats().tokens).toBe(2);
  });

  withBroker("gives a conversation a new token after a URL server failed as its engine started, so the engine reconnects", async () => {
    const b = await broker();
    const url = (servers: Record<string, unknown>) => (servers.notion as { url: string }).url;
    const first = url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, b));
    const other = url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t2" }, b));
    expect(retryBrokeredMcp({ botId: "b1", threadId: "t1" }, ["files"]), "a command server is checked elsewhere").toEqual([]);
    expect(retryBrokeredMcp({ botId: "b1", threadId: "t9" }, ["notion"]), "a conversation with nothing brokered").toEqual([]);
    expect(url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, b)), "nothing failed here: same token, same warm engine").toBe(first);
    expect(retryBrokeredMcp({ botId: "b1", threadId: "t1" }, ["notion", "files"])).toEqual(["notion"]);
    expect(credentials.lookup(new URL(first).pathname.split("/")[2]!, "mcp-notion").ok, "the failed conversation's old token is revoked immediately").toBe(false);
    expect(credentials.lookup(new URL(other).pathname.split("/")[2]!, "mcp-notion").ok, "another conversation keeps its grant").toBe(true);
    const next = url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, b));
    expect(next, "a new token, so the engine's server list changes and it starts again").not.toBe(first);
    expect(url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, b)), "then kept again").toBe(next);
  });

  it("says which servers didn't connect, and that they connect again on the next message", () => {
    expect(mcpReconnectLine(["notion"])).toBe("The MCP server notion didn't connect, so its tools weren't available this time. It connects again on your next message.");
    expect(mcpReconnectLine(["notion", "hq", "mail"])).toBe("The MCP servers notion, hq, and mail didn't connect, so their tools weren't available this time. They connect again on your next message.");
  });

  withBroker("takes a gateway's two service-token headers to it, while the engine's server list holds neither", async () => {
    const id = "id-5c1d.access", secret = "secret-0f9e8d7c6b5a";
    const gateway = await startFakeHttpMcp({ tools: [{ name: "lookup_order" }], requireHeaders: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } });
    const b = await broker();
    // In a box the broker's port is a loopback bridge to its socket; a TCP listener stands in for that bridge here.
    const bridge = createServer((socket) => {
      const upstream = connect(credentials.socketPath);
      socket.pipe(upstream).pipe(socket);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    try {
      const custom = { orders: { type: "http" as const, url: gateway.url, headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } } };
      const out = brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, { ...b, port: (bridge.address() as AddressInfo).port });
      const orders = out.orders as RemoteMcpSpec;
      expect(orders.headers).toEqual({});
      expect(JSON.stringify(out)).not.toContain(id);
      expect(JSON.stringify(out)).not.toContain(secret);

      expect(await probeMcpServer({ ...custom.orders, headers: {}, enabled: true })).toMatchObject({ ok: false, reason: "keys", status: 403 });
      expect(await probeMcpServer({ ...orders, enabled: true })).toMatchObject({ ok: true, tools: [{ name: "lookup_order" }] });
      const client = new RemoteMcpClient({ ...orders, headers: { "CF-Access-Client-Secret": "the engine's own guess" } });
      const signal = AbortSignal.timeout(10_000);
      await client.initialize("engine", signal);
      expect(await client.request("tools/call", { name: "lookup_order", arguments: { id: "1042" } }, signal)).toEqual({ content: [{ type: "text", text: "remote execution recorded" }] });
      await client.close();
      expect(gateway.calls).toEqual([{ name: "lookup_order", arguments: { id: "1042" } }]);
      expect(gateway.seenHeaders.filter((headers) => headers["cf-access-client-id"] === id && headers["cf-access-client-secret"] === secret).length).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise((resolve) => bridge.close(resolve));
      await gateway.close();
    }
  });

  it("off: the servers come back untouched", () => {
    expect(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, null)).toBe(custom);
    expect(mcpGrantName("My Server!")).toBe("mcp-my-server-");
  });
});
