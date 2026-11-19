import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSseSessions, mcpRequest } from "./mcp-client.ts";
import { type Json } from "./mcp-common.ts";
import { checkConnection } from "./status.ts";
import { findApp } from "./catalog.ts";
import { saveAppSettings, removeAppSettings, appConnection } from "./store.ts";
import { listAppsForBuddy, useApp } from "./use.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  closeSseSessions();
  removeAppSettings("affinity");
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Mode = "normal" | "foreign" | "redirect" | "unauthorized" | "malformed" | "silent" | "close" | "hang-post" | "no-endpoint" | "wrong-version" | "post-redirect";
async function fixture(mode: Mode = "normal") {
  const streams = new Map<string, ServerResponse>();
  const readPreamble = new Set<string>();
  const calls: Array<{ session: string; method: string; params: Json }> = [];
  let count = 0;
  let foreignHits = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/sse") {
      if (mode === "redirect") { res.writeHead(302, { location: "/other" }); res.end(); return; }
      if (mode === "unauthorized") { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      const session = String(++count);
      streams.set(session, res);
      const address = mode === "foreign" ? "http://example.com/message" : `/message?session=${session}`;
      const frame = `: connected\r\n\r\nevent: endpoint\r\ndata: ${address}\r\n\r\n`;
      if (mode !== "no-endpoint") {
        res.write(frame.slice(0, 37));
        res.write(frame.slice(37));
      }
      return;
    }
    if (!req.url?.startsWith("/message")) { foreignHits++; res.end(); return; }
    const session = new URL(req.url, "http://localhost").searchParams.get("session")!;
    let data = ""; for await (const part of req) data += part;
    const msg = JSON.parse(data);
    calls.push({ session, method: msg.method, params: msg.params });
    if (mode === "post-redirect") { res.writeHead(302, { location: "/other" }); res.end(); return; }
    if (mode !== "hang-post" || msg.method !== "tools/call") { res.writeHead(202); res.end(); }
    if (msg.id === undefined) return;
    const stream = streams.get(session)!;
    if (msg.method === "tools/call" && mode === "silent") return;
    if (msg.method === "tools/call" && mode === "close") { stream.end(); return; }
    if (msg.method === "tools/call" && mode === "malformed") { stream.write('event: message\ndata: invalid JSON\n\n'); return; }
    let result: Json = {};
    if (msg.method === "initialize") result = { protocolVersion: mode === "wrong-version" ? "old" : "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-affinity", version: "1" } };
    if (msg.method === "tools/list") result = { tools: ["execute_script", "read_sdk_documentation_topic", "render_spread"].map(name => ({ name, inputSchema: { type: "object" } })) };
    if (msg.method === "tools/call") {
      if (msg.params.name === "read_sdk_documentation_topic") { readPreamble.add(session); result = { content: [{ type: "text", text: "TEST · préamble 🎨" }] }; }
      else if (msg.params.name === "render_spread") result = { content: [{ type: "image", mimeType: "image/jpeg", data: "TEST-image" }] };
      else if (!readPreamble.has(session)) {
        stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "Read preamble first" } })}\n\n`); return;
      } else result = { content: [{ type: "text", text: String(msg.params.arguments?.script) }] };
    }
    // Multi-line data and a multibyte character split across byte chunks.
    const body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    const frame = Buffer.from(`event: message\r\ndata: ${body.slice(0, 1)}\r\ndata: ${body.slice(1)}\r\n\r\n`);
    const index = frame.indexOf(Buffer.from("🎨"));
    const cut = index > 0 ? index + 1 : 35;
    stream.write(frame.subarray(0, cut)); stream.write(frame.subarray(cut));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/sse`;
  const target = { endpoint, transport: "local-mcp-sse" as const, timeoutMs: 1000 };
  return { target, calls, sessions: () => count, foreignHits: () => foreignHits };
}
const tool = (name: string, args = {}) => ({ name, arguments: args });

describe("Affinity SSE transport", () => {
  it("initializes once and preserves preamble state across concurrent calls", async () => {
    const { target, calls, sessions } = await fixture();
    await Promise.all([mcpRequest(target, "tools/list", {}), mcpRequest(target, "tools/list", {})]);
    expect(sessions()).toBe(1);
    expect(calls.filter(c => c.method === "initialize")).toHaveLength(1);
    expect(calls[0].params.protocolVersion).toBe("2025-11-25");
    await expect(mcpRequest(target, "tools/call", tool("execute_script"))).rejects.toThrow("Read preamble");
    expect(await mcpRequest(target, "tools/call", tool("read_sdk_documentation_topic", { filename: "preamble" }))).toMatchObject({ content: [{ text: "TEST · préamble 🎨" }] });
    const results = await Promise.all(["one", "two"].map(script => mcpRequest(target, "tools/call", tool("execute_script", { script }))));
    expect(results.map(r => (r.content as Array<{text:string}>)[0].text)).toEqual(["one", "two"]);
    expect(new Set(calls.map(c => c.session)).size).toBe(1);
  });

  it("exposes token-free status, schemas, tags and image results through app routing", async () => {
    const { target } = await fixture();
    const app = findApp("affinity")!;
    expect(await checkConnection(app, target.endpoint, undefined)).toMatchObject({ state: "ready" });
    saveAppSettings("affinity", { endpoint: target.endpoint, token: "ignored-token" });
    expect(appConnection("affinity").token).toBeUndefined();
    expect((await listAppsForBuddy("affinity"))[0]).toMatchObject({ id: "affinity", status: "ready", actions: expect.arrayContaining([{ name: "execute_script", inputSchema: { type: "object" } }]) });
    expect(await useApp("affinity", "read_sdk_documentation_topic", { filename: "preamble" })).toMatchObject({ content: [{ text: expect.stringContaining("préamble") }] });
    expect(await useApp("affinity", "render_spread", {})).toEqual({ content: [{ type: "image", mimeType: "image/jpeg", data: "TEST-image" }] });
  });

  it.each(["foreign", "redirect", "post-redirect", "wrong-version"] as const)("rejects %s without following unsafe addresses", async mode => {
    const { target, foreignHits } = await fixture(mode);
    await expect(mcpRequest(target, "tools/list", {})).rejects.toThrow();
    expect(foreignHits()).toBe(0);
  });

  it("maps native access refusal to token-free setup instructions", async () => {
    const { target } = await fixture("unauthorized");
    const status = await checkConnection(findApp("affinity")!, target.endpoint, undefined);
    expect(status).toMatchObject({ state: "needs_setup", message: expect.stringContaining("Model Context Protocol") });
    expect(status.message).not.toContain("token");
  });

  it.each(["silent", "hang-post", "malformed", "close"] as const)("bounds %s failures and never replays a script", async mode => {
    const { target, calls } = await fixture(mode);
    await mcpRequest(target, "tools/list", {});
    await expect(mcpRequest({ ...target, timeoutMs: 100 }, "tools/call", tool("execute_script"))).rejects.toThrow();
    expect(calls.filter(c => c.method === "tools/call")).toHaveLength(1);
  });

  it("bounds a stream that never advertises its endpoint", async () => {
    const { target } = await fixture("no-endpoint");
    await expect(mcpRequest({ ...target, timeoutMs: 100 }, "tools/list", {})).rejects.toMatchObject({ kind: "timeout" });
  });

  it("expires an idle session and initializes a fresh one on the next request", async () => {
    const { target, sessions } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mcpRequest(target, "tools/list", {});
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await mcpRequest(target, "tools/list", {});
    expect(sessions()).toBe(2);
  });

  it("closes saved sessions when settings are reset, then reconnects", async () => {
    const { target, sessions } = await fixture();
    saveAppSettings("affinity", { endpoint: target.endpoint });
    await mcpRequest(target, "tools/list", {});
    removeAppSettings("affinity");
    await mcpRequest(target, "tools/list", {});
    expect(sessions()).toBe(2);
  });
});
