// A URL server that lists its tools to anyone and refuses every tool call without a sign-in, reached the way a boxed turn
// reaches it: the turn's grant, a real broker on its socket and the box's own bridge to the broker's loopback port.
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openBridge } from "./box-bridge.ts";
import type { BoxBroker } from "./box.ts";
import { refusedCallAnswer } from "./broker-mcp-refusal.ts";
import { brokerRemoteMcp, forgetBrokeredMcp } from "./broker-mcp.ts";
import { brokeredServer } from "./broker-probe.ts";
import { brokerUrl, openCredentialBroker, type CredentialBroker } from "./broker.ts";
import type { McpServerSpec, RemoteMcpSpec } from "../contracts.ts";
import { McpHttpError, RemoteMcpClient } from "../mcp-http.ts";
import { probeMcpServer } from "../mcp-probe.ts";
import type { McpServerApp } from "../mcp-server-app.ts";
import { startFakeHttpMcp, type FakeHttpMcp, type FakeHttpMcpOptions } from "../testing/fake-http-mcp-server.ts";
import { startFakeOAuth, type FakeOAuth } from "../testing/fake-oauth-server.ts";

const READ = { name: "get_thread", annotations: { readOnlyHint: true }, inputSchema: { type: "object", required: ["threadId"] } };
const TURN = { botId: "bot-1", threadId: "thread-1" };

describe.skipIf(process.platform === "win32")("an MCP server that refuses a boxed turn's tool call", () => {
  let dir = "", credentials: CredentialBroker | undefined, bridge: Server | undefined, server: FakeHttpMcp | undefined, oauth: FakeOAuth | undefined;
  afterEach(async () => {
    forgetBrokeredMcp();
    await new Promise((resolve) => (bridge ? bridge.close(resolve) : resolve(undefined)));
    await credentials?.close();
    await server?.close();
    await oauth?.close();
    credentials = bridge = server = oauth = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function boxed(options: FakeHttpMcpOptions, headers: Record<string, string> = {}, app?: McpServerApp) {
    oauth = await startFakeOAuth();
    server = await startFakeHttpMcp({ guard: "listed-tools", acceptBearer: () => false, wwwAuthenticate: oauth.challenge, tools: [READ], ...options });
    dir = mkdtempSync(join(tmpdir(), "omb-broker-refusal-"));
    credentials = await openCredentialBroker({ socketPath: join(dir, "b.sock") });
    bridge = await openBridge({ port: 0, socket: credentials.socketPath });
    const broker: BoxBroker = { port: (bridge.address() as AddressInfo).port, mintForThread: credentials.mintForThread, touchThread: credentials.touchThread, revokeThread: credentials.revokeThread, lookup: credentials.lookup };
    const custom: Record<string, McpServerSpec> = { mail: { type: "http", url: server.url, headers } };
    const mounted = brokerRemoteMcp(custom, TURN, broker, app ? () => app : undefined).mail as RemoteMcpSpec;
    return { mounted, target: { type: "http" as const, url: server.url, headers, enabled: true }, path: { broker, socketPath: credentials.socketPath } };
  }
  const callTool = async (spec: RemoteMcpSpec) => {
    const client = new RemoteMcpClient(spec);
    const signal = AbortSignal.timeout(10_000);
    try {
      await client.initialize("engine", signal);
      expect(await client.request("tools/list", {}, signal)).toMatchObject({ tools: [{ name: "get_thread" }] });
      return await client.request("tools/call", { name: "get_thread", arguments: { threadId: "t" } }, signal) as { isError?: boolean; content: Array<{ text: string }> };
    } finally { await client.close(); }
  };

  it("tells the engine which server needs a sign-in and what to do, and Test no longer says it works", async () => {
    const { mounted, target, path } = await boxed({});
    const result = await callTool(mounted);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('The MCP server "mail" needs a sign-in');
    expect(result.content[0]!.text).toContain("Call mcp_server with action sign_in and name mail");
    expect(server!.calls).toEqual([]);

    const grant = brokeredServer(path, "mail", target);
    try {
      await expect(probeMcpServer(target, 8_000, undefined, { tryReadOnlyTool: true, via: { url: grant.url, fetch: grant.fetch } }))
        .resolves.toEqual({ ok: false, auth: "required", error: "This server needs you to sign in." });
    } finally { await grant.done(); }
  });

  it("offers the connected app's card when the server stands for an app this turn can connect", async () => {
    const { mounted } = await boxed({}, {}, { slug: "gmail", label: "Gmail", connected: false });
    const text = (await callTool(mounted)).content[0]!.text;
    expect(text).toContain('Call COMPOSIO_MANAGE_CONNECTIONS with toolkits ["gmail"] to show the card in this chat, then end your turn.');
    expect(text).toContain("If the card can't be shown, call mcp_server with action sign_in and name mail");
    expect(server!.calls).toEqual([]);
  });

  it("says the key or sign-in was refused when the broker sent one", async () => {
    const { mounted } = await boxed({}, { Authorization: "Bearer stale" });
    const result = await callTool(mounted);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('The MCP server "mail" refused the sign-in or key it was sent');
    expect(result.content[0]!.text).not.toContain("stale");
  });

  it("leaves a tool call the server accepts alone", async () => {
    const { mounted } = await boxed({ acceptBearer: () => true });
    await expect(callTool(mounted)).resolves.toEqual({ content: [{ type: "text", text: "remote execution recorded" }] });
  });

  it("still passes a refused initialize through, so the engine reports the server as not connected", async () => {
    const { mounted } = await boxed({ guard: "every-request" });
    const client = new RemoteMcpClient(mounted);
    await expect(client.initialize("engine", AbortSignal.timeout(10_000))).rejects.toMatchObject({ status: 401 });
    await expect(client.initialize("engine", AbortSignal.timeout(10_000))).rejects.toBeInstanceOf(McpHttpError);
    await client.close();
  });

  it("keeps a 401 as a 401 on a grant that isn't a turn's MCP server", async () => {
    const { target, path } = await boxed({});
    const { token } = credentials!.mintForThread({ threadId: "other", grants: { "mcp-mail": { upstream: target.url, headers: {} } } });
    const client = new RemoteMcpClient({ type: "http", url: brokerUrl(path.broker.port, token, "mcp-mail"), headers: {} });
    const signal = AbortSignal.timeout(10_000);
    await client.initialize("engine", signal);
    await expect(client.request("tools/call", { name: "get_thread", arguments: {} }, signal)).rejects.toMatchObject({ status: 401 });
    await client.close();
  });
});

describe("the answer to a refused call", () => {
  const textOf = (answer: string | null) => (JSON.parse(answer!) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  const CALL = '{"jsonrpc":"2.0","id":1,"method":"tools/call"}';
  const SIGN_IN = "Call mcp_server with action sign_in and name mail, then end your turn; if you can't, tell the person to sign in to mail in Apps, MCP servers.";
  const REFUSED = 'The MCP server "mail" needs a sign-in before its tools work, and nobody has signed in (HTTP 401), so nothing ran. Don\'t retry.';

  it("names only the server's own sign-in when no connected app stands in for it", () => {
    expect(textOf(refusedCallAnswer("mail", false, CALL))).toBe(`${REFUSED} ${SIGN_IN}`);
  });

  it("offers the app's connect card first, and the server's sign-in second", () => {
    expect(textOf(refusedCallAnswer("mail", false, CALL, { slug: "gmail", label: "Gmail", connected: false }))).toBe(`${REFUSED} `
      + "Gmail can be connected in one step with its connect card. Call COMPOSIO_MANAGE_CONNECTIONS with toolkits [\"gmail\"] to show the card in this chat, then end your turn. "
      + "Once it is connected, use the connected app's Gmail tools instead of this MCP server. "
      + `If the card can't be shown, call ${SIGN_IN.slice("Call ".length)}`);
  });

  it("points to the app already connected, with no card", () => {
    const text = textOf(refusedCallAnswer("mail", false, CALL, { slug: "googlecalendar", label: "Google Calendar", connected: true }));
    expect(text).toBe(`${REFUSED} Google Calendar is already connected as a connected app here, so use the connected app's Google Calendar tools instead of this MCP server. Don't show a connect card for it.`);
    expect(text).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
  });

  it("keeps a refused key or sign-in about the server alone", () => {
    const text = textOf(refusedCallAnswer("mail", true, CALL, { slug: "gmail", label: "Gmail", connected: false }));
    expect(text).toContain('The MCP server "mail" refused the sign-in or key it was sent');
    expect(text).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
  });

  it("keeps the request's own id, string or number", () => {
    expect(JSON.parse(refusedCallAnswer("mail", false, '{"jsonrpc":"2.0","id":"a-1","method":"tools/call"}')!)).toMatchObject({ id: "a-1", result: { isError: true } });
    expect(JSON.parse(refusedCallAnswer("mail", false, '{"jsonrpc":"2.0","id":7,"method":"tools/call"}')!)).toMatchObject({ id: 7, result: { isError: true } });
  });

  it.each([
    ["another method", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
    ["a notification", '{"jsonrpc":"2.0","method":"tools/call"}'],
    ["a batch", '[{"jsonrpc":"2.0","id":1,"method":"tools/call"}]'],
    ["not JSON", "<html>"],
  ])("passes %s through", (_label, body) => {
    expect(refusedCallAnswer("mail", false, body)).toBeNull();
  });
});
