import { describe, expect, it } from "vitest";

import type { AppDocument } from "../app.ts";
import { BOT_HTML_CSP, BOT_HTML_NETWORK } from "./csp.ts";
import {
  APP_FRAME_LIMITS, createAppBridge, hostCapabilitiesFor, openableLink, RPC_HOST_REFUSED, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND,
  type AppBridgeAdapter, type AppHostContext, type JsonRpcMessage,
} from "./bridge.ts";

const FRAME = { name: "frame window" };
const OTHER = { name: "some other window" };

const botDoc = (): AppDocument => ({
  v: 1, messageId: "m1", rev: 0, srcdoc: "<!DOCTYPE html>", csp: BOT_HTML_CSP,
  network: { connect: [...BOT_HTML_NETWORK.connect], resources: [...BOT_HTML_NETWORK.resources] },
  can: { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true },
});

const mcpDoc = (over: Partial<AppDocument> = {}): AppDocument => ({
  v: 1, messageId: "m2", rev: 0, srcdoc: "<!DOCTYPE html>", csp: "default-src 'none'",
  network: { connect: ["https://api.example.com"], resources: ["https://esm.sh"] },
  tool: { name: "get-time", title: "Get time", inputSchema: { type: "object" } },
  toolInput: { zone: "UTC" },
  toolResult: { content: [{ type: "text", text: "12:00" }], structuredContent: { time: "12:00" } },
  can: { serverTools: true, serverResources: true, message: true, openLinks: true, modelContext: true },
  ...over,
});

function harness(doc: AppDocument = botDoc(), context: AppHostContext = { theme: "dark", containerDimensions: { width: 600, maxHeight: 500 } }) {
  let clock = 1_000_000;
  let engaged = true;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const sent: JsonRpcMessage[] = [];
  const calls = {
    rpc: [] as Array<{ method: string; params: unknown }>,
    messages: [] as string[], links: [] as string[], contexts: [] as unknown[], heights: [] as number[], teardowns: 0, logs: [] as unknown[],
  };
  let rpcAnswer: (method: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({ content: [] });
  const adapter: AppBridgeAdapter = {
    post: (message) => { sent.push(message); },
    callRpc: (method, params) => { calls.rpc.push({ method, params }); return rpcAnswer(method, params); },
    sendMessage: async (text) => { calls.messages.push(text); },
    openLink: (url) => { calls.links.push(url); },
    setContext: (update) => { calls.contexts.push(update); },
    resize: (height) => { calls.heights.push(height); },
    engaged: () => engaged,
    teardownRequested: () => { calls.teardowns += 1; },
    now: () => clock,
  };
  const bridge = createAppBridge({
    doc, hostContext: context, adapter, source: () => FRAME, hostVersion: "0.1.108", log: (params) => calls.logs.push(params),
    timers: {
      set: (run, ms) => { const timer = { at: clock + ms, run, live: true }; timers.push(timer); return timer; },
      clear: (handle) => { (handle as { live: boolean }).live = false; },
    },
  });
  let nextId = 1;
  const send = (data: unknown, source: unknown = FRAME) => bridge.handleMessage({ source, data });
  const flush = () => new Promise((done) => setTimeout(done, 0));
  /** A request from the View; resolves with the host's answer, or undefined when there was none. */
  const request = async (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    const before = sent.length;
    send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    await flush();
    return sent.slice(before).find((message) => "id" in message && message.id === id && !("method" in message)) as
      | { result?: any; error?: { code: number; message: string } } | undefined;
  };
  const notify = (method: string, params?: Record<string, unknown>) => send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  const connect = async () => {
    const answer = await request("ui/initialize", { appInfo: { name: "test", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
    notify("ui/notifications/initialized");
    await flush();
    return answer;
  };
  const advance = async (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((entry) => entry.live && entry.at <= clock)) { timer.live = false; timer.run(); }
    await flush();
  };
  return {
    bridge, sent, calls, send, request, notify, connect, advance, flush,
    setEngaged: (value: boolean) => { engaged = value; },
    answerRpc: (answer: typeof rpcAnswer) => { rpcAnswer = answer; },
  };
}

const methods = (messages: JsonRpcMessage[]) => messages.flatMap((message) => ("method" in message ? [message.method] : []));

describe("handshake", () => {
  it("answers ui/initialize with the protocol, host, capabilities and context", async () => {
    const h = harness(mcpDoc());
    const answer = await h.request("ui/initialize", { appInfo: { name: "x", version: "1" }, appCapabilities: {}, protocolVersion: "2025-06-18" });
    expect(answer?.result).toEqual({
      protocolVersion: "2026-01-26",
      hostInfo: { name: "mausbot", version: "0.1.108" },
      hostCapabilities: {
        openLinks: {}, logging: {}, updateModelContext: { text: {}, structuredContent: {} }, message: { text: {} },
        serverTools: {}, serverResources: {},
        sandbox: { permissions: {}, csp: { connectDomains: ["https://api.example.com"], resourceDomains: ["https://esm.sh"] } },
      },
      hostContext: { theme: "dark", containerDimensions: { width: 600, maxHeight: 500 }, toolInfo: { tool: mcpDoc().tool } },
    });
  });

  it("sends nothing before initialized but the initialize answer, then tool-input once, before tool-result", async () => {
    const h = harness(mcpDoc());
    // Before ui/initialize: nothing, not even an error.
    expect(await h.request("ping")).toBeUndefined();
    expect(await h.request("tools/call", { name: "get-time" })).toBeUndefined();
    h.notify("ui/notifications/initialized");
    h.bridge.contextChanged({ theme: "light" });
    expect(h.sent).toEqual([]);
    await h.request("ui/initialize", { protocolVersion: "2026-01-26" });
    expect(h.sent).toHaveLength(1);
    // Between the answer and `initialized`: still nothing.
    expect(await h.request("ping")).toBeUndefined();
    h.notify("ui/notifications/size-changed", { height: 300 });
    h.bridge.contextChanged({ theme: "dark" });
    expect(h.sent).toHaveLength(1);
    expect(h.calls.heights).toEqual([]);
    h.notify("ui/notifications/initialized");
    expect(h.sent.slice(1)).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { zone: "UTC" } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: mcpDoc().toolResult },
      { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } },
    ]);
    // A second initialize (a pasted SDK view beside the helper) is answered; tool-input is never sent again.
    await h.request("ui/initialize", { protocolVersion: "2026-01-26" });
    h.notify("ui/notifications/initialized");
    expect(methods(h.sent).filter((method) => method === "ui/notifications/tool-input")).toHaveLength(1);
    expect(h.bridge.initialized).toBe(true);
  });

  it("sends no tool notifications to a bot's page, and an empty result to an MCP app that has none", async () => {
    const bot = harness(botDoc());
    await bot.connect();
    expect(methods(bot.sent)).toEqual([]);
    const bare = harness(mcpDoc({ toolInput: undefined, toolResult: undefined }));
    await bare.connect();
    expect(bare.sent.slice(1)).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [] } },
    ]);
  });

  it("ignores `initialized` that arrives before any initialize answer", async () => {
    const h = harness(mcpDoc());
    h.notify("ui/notifications/initialized");
    expect(h.bridge.initialized).toBe(false);
    await h.connect();
    expect(h.bridge.initialized).toBe(true);
  });
});

describe("the method table", () => {
  it("answers ping, display mode (always inline) and context changes after initialized", async () => {
    const h = harness();
    await h.connect();
    expect((await h.request("ping"))?.result).toEqual({});
    expect((await h.request("ui/request-display-mode", { mode: "fullscreen" }))?.result).toEqual({ mode: "inline" });
    h.bridge.contextChanged({ theme: "light", containerDimensions: { width: 400, maxHeight: 300 } });
    expect(h.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light", containerDimensions: { width: 400, maxHeight: 300 } } });
  });

  it("refuses methods outside the v1 table with -32601", async () => {
    const h = harness(mcpDoc());
    await h.connect();
    for (const method of ["ui/download-file", "sampling/createMessage", "resources/templates/list", "prompts/list", "completion/complete", "initialize", "anything"]) {
      expect((await h.request(method))?.error, method).toEqual({ code: RPC_METHOD_NOT_FOUND, message: "Method not found" });
    }
    expect(h.calls.rpc).toEqual([]);
  });

  it("refuses tools/* and resources/* on a bot's page with -32601", async () => {
    const h = harness(botDoc());
    await h.connect();
    for (const method of ["tools/call", "tools/list", "resources/read", "resources/list"]) {
      expect((await h.request(method, { name: "x", uri: "ui://x" }))?.error?.code, method).toBe(RPC_METHOD_NOT_FOUND);
    }
    expect(h.calls.rpc).toEqual([]);
  });

  it("relays an MCP app's server calls, engaged or not, and passes refusals through", async () => {
    const h = harness(mcpDoc());
    await h.connect();
    h.answerRpc(async (method) => (method === "tools/list" ? { tools: [{ name: "get-time" }] } : { content: [{ type: "text", text: "13:00" }] }));
    expect((await h.request("tools/call", { name: "get-time", arguments: {} }))?.result).toEqual({ content: [{ type: "text", text: "13:00" }] });
    h.setEngaged(false);
    expect((await h.request("tools/list"))?.result).toEqual({ tools: [{ name: "get-time" }] });
    expect(h.calls.rpc).toEqual([
      { method: "tools/call", params: { name: "get-time", arguments: {} } },
      { method: "tools/list", params: {} },
    ]);
    h.answerRpc(async () => { throw { code: RPC_HOST_REFUSED, message: "This bot asks before it changes anything." }; });
    expect((await h.request("tools/call", { name: "save" }))?.error).toEqual({ code: RPC_HOST_REFUSED, message: "This bot asks before it changes anything." });
    h.answerRpc(async () => { throw new Error("Offline"); });
    expect((await h.request("resources/read", { uri: "ui://x" }))?.error).toEqual({ code: RPC_HOST_REFUSED, message: "Offline" });
    expect((await h.request("tools/call", { arguments: {} }))?.error?.code).toBe(RPC_INVALID_PARAMS);
    expect((await h.request("tools/call", { name: "x", arguments: [1] }))?.error?.code).toBe(RPC_INVALID_PARAMS);
    expect((await h.request("resources/read", {}))?.error?.code).toBe(RPC_INVALID_PARAMS);
  });

  it("refuses server calls an MCP app may not make right now, with the strip's words", async () => {
    const h = harness(mcpDoc({
      can: { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true },
      blocked: { reason: "signed-out", text: "Sign in to Debug again" },
    }));
    const init = await h.request("ui/initialize", {});
    expect(init?.result.hostCapabilities).not.toHaveProperty("serverTools");
    expect(init?.result.hostCapabilities).not.toHaveProperty("serverResources");
    h.notify("ui/notifications/initialized");
    expect((await h.request("tools/call", { name: "x" }))?.error).toEqual({ code: RPC_HOST_REFUSED, message: "Sign in to Debug again" });
    expect((await h.request("resources/list"))?.error?.code).toBe(RPC_HOST_REFUSED);
    expect(h.calls.rpc).toEqual([]);
  });

  it("clamps the reported height and ignores the width", async () => {
    const h = harness(botDoc(), { containerDimensions: { width: 600, maxHeight: 500 } });
    await h.connect();
    for (const height of [10, 200.4, 9_000, Number.NaN, -5]) h.notify("ui/notifications/size-changed", { width: 9_999, height });
    h.notify("ui/notifications/size-changed", { width: 300 });
    h.notify("ui/notifications/size-changed", { height: "400" });
    expect(h.calls.heights).toEqual([APP_FRAME_LIMITS.minHeight, 200, 500, APP_FRAME_LIMITS.minHeight]);
  });

  it("drops notifications/message past 50 a minute, and passes the View's teardown request on", async () => {
    const h = harness();
    await h.connect();
    for (let index = 0; index < 60; index += 1) h.notify("notifications/message", { level: "info", data: index });
    expect(h.calls.logs).toHaveLength(50);
    await h.advance(60_000);
    h.notify("notifications/message", { level: "info", data: "later" });
    expect(h.calls.logs).toHaveLength(51);
    h.notify("ui/notifications/request-teardown");
    expect(h.calls.teardowns).toBe(1);
    // Other notifications are dropped without an answer.
    const before = h.sent.length;
    h.notify("notifications/tools/list_changed");
    h.notify("ui/notifications/tool-cancelled");
    expect(h.sent).toHaveLength(before);
  });
});

describe("engagement and limits", () => {
  it("refuses ui/message and ui/open-link without engagement, and does nothing", async () => {
    const h = harness();
    await h.connect();
    h.setEngaged(false);
    expect((await h.request("ui/message", { role: "user", content: [{ type: "text", text: "hi" }] }))?.error?.code).toBe(RPC_HOST_REFUSED);
    expect((await h.request("ui/open-link", { url: "https://example.com" }))?.error?.code).toBe(RPC_HOST_REFUSED);
    expect(h.calls.messages).toEqual([]);
    expect(h.calls.links).toEqual([]);
    // Engagement does not gate context or display mode.
    expect((await h.request("ui/update-model-context", { content: [{ type: "text", text: "viewing" }] }))?.result).toEqual({});
  });

  it("sends a text message once engaged, at most one per 3 s and ten per 10 minutes", async () => {
    const h = harness();
    await h.connect();
    const message = (text: string) => h.request("ui/message", { role: "user", content: [{ type: "text", text }] });
    expect((await message("one"))?.result).toEqual({});
    expect((await message("too soon"))?.error?.code).toBe(RPC_HOST_REFUSED);
    for (let index = 0; index < 9; index += 1) {
      await h.advance(3_000);
      expect((await message(`n${index}`))?.result, `message ${index}`).toEqual({});
    }
    await h.advance(3_000);
    expect((await message("eleventh"))?.error?.code).toBe(RPC_HOST_REFUSED);
    await h.advance(600_000);
    expect((await message("later"))?.result).toEqual({});
    expect(h.calls.messages).toHaveLength(11);
    expect(h.calls.messages[0]).toBe("one");
  });

  it("takes text only, 1 to 4,000 characters, as the person", async () => {
    const h = harness();
    await h.connect();
    for (const params of [
      { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [] },
      { role: "user", content: [{ type: "text", text: "   " }] },
      { role: "user", content: [{ type: "text", text: "x".repeat(4_001) }] },
      { role: "user" },
    ]) {
      expect((await h.request("ui/message", params))?.error?.code, JSON.stringify(params).slice(0, 80)).toBe(RPC_INVALID_PARAMS);
      await h.advance(3_000);
    }
    expect((await h.request("ui/message", { role: "user", content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] }))?.result).toEqual({});
    expect(h.calls.messages).toEqual(["line one\nline two"]);
  });

  it("opens only http(s) links without userinfo, up to 2,048 characters, one per 2 s", async () => {
    const h = harness();
    await h.connect();
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "mailto:a@b.c", "https://user:pw@example.com", "https://user@example.com", `https://example.com/${"a".repeat(2_048)}`, "", 42, "not a url"]) {
      expect((await h.request("ui/open-link", { url: url as string }))?.error?.code, String(url).slice(0, 40)).toBe(RPC_INVALID_PARAMS);
    }
    expect(h.calls.links).toEqual([]);
    expect((await h.request("ui/open-link", { url: "https://example.com/a b" }))?.result).toEqual({});
    expect((await h.request("ui/open-link", { url: "http://example.com" }))?.error?.code).toBe(RPC_HOST_REFUSED);
    await h.advance(2_000);
    expect((await h.request("ui/open-link", { url: "http://example.com" }))?.result).toEqual({});
    expect(h.calls.links).toEqual(["https://example.com/a%20b", "http://example.com/"]);
    expect(openableLink("HTTPS://EXAMPLE.COM")).toBe("https://example.com/");
  });

  it("limits server calls to 10 per 10 s and 120 per 10 minutes", async () => {
    const h = harness(mcpDoc());
    await h.connect();
    for (let index = 0; index < 10; index += 1) expect((await h.request("tools/list"))?.result).toBeDefined();
    expect((await h.request("tools/list"))?.error?.code).toBe(RPC_HOST_REFUSED);
    for (let round = 1; round < 12; round += 1) {
      await h.advance(10_000);
      for (let index = 0; index < 10; index += 1) await h.request("tools/list");
    }
    // 120 within the last 10 minutes: the window is full.
    expect(h.calls.rpc).toHaveLength(120);
    await h.advance(10_000);
    expect((await h.request("tools/list"))?.error?.code).toBe(RPC_HOST_REFUSED);
    expect(h.calls.rpc).toHaveLength(120);
  });

  it("coalesces model context to one update a second, the latest winning", async () => {
    const h = harness();
    await h.connect();
    const update = (text: string) => h.request("ui/update-model-context", { content: [{ type: "text", text }] });
    expect((await update("a"))?.result).toEqual({});
    expect(h.calls.contexts).toEqual([{ content: [{ type: "text", text: "a" }] }]);
    await update("b");
    await update("c");
    expect(h.calls.contexts).toHaveLength(1);
    await h.advance(1_000);
    expect(h.calls.contexts).toEqual([{ content: [{ type: "text", text: "a" }] }, { content: [{ type: "text", text: "c" }] }]);
    expect((await h.request("ui/update-model-context", { structuredContent: { page: 2 } }))?.result).toEqual({});
    await h.advance(1_000);
    expect(h.calls.contexts.at(-1)).toEqual({ structuredContent: { page: 2 } });
    expect((await h.request("ui/update-model-context", { content: "not a list" }))?.error?.code).toBe(RPC_INVALID_PARAMS);
  });

  it("hands a waiting context update over before a message, so the bot reads the message against the latest view", async () => {
    const h = harness();
    await h.connect();
    const update = (text: string) => h.request("ui/update-model-context", { content: [{ type: "text", text }] });
    await update("1 cup");
    await update("2 cups");
    expect(h.calls.contexts).toHaveLength(1);
    expect((await h.request("ui/message", { role: "user", content: [{ type: "text", text: "I had 2 cups" }] }))?.result).toEqual({});
    expect(h.calls.contexts.at(-1)).toEqual({ content: [{ type: "text", text: "2 cups" }] });
    expect(h.calls.messages).toEqual(["I had 2 cups"]);
    await h.advance(1_000);
    expect(h.calls.contexts).toHaveLength(2);
  });

  it("honours `can`: a frame that may not message, open links or set context is refused", async () => {
    const h = harness({ ...botDoc(), can: { serverTools: false, serverResources: false, message: false, openLinks: false, modelContext: false } });
    const init = await h.request("ui/initialize", {});
    expect(Object.keys(init?.result.hostCapabilities).sort()).toEqual(["logging", "sandbox"]);
    h.notify("ui/notifications/initialized");
    expect((await h.request("ui/message", { role: "user", content: [{ type: "text", text: "x" }] }))?.error?.code).toBe(RPC_HOST_REFUSED);
    expect((await h.request("ui/open-link", { url: "https://example.com" }))?.error?.code).toBe(RPC_HOST_REFUSED);
    expect((await h.request("ui/update-model-context", { content: [] }))?.error?.code).toBe(RPC_HOST_REFUSED);
    expect(h.calls).toMatchObject({ messages: [], links: [], contexts: [] });
  });
});

describe("what is dropped without an answer (rule 9)", () => {
  it("drops messages from any window but the frame's", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} }, OTHER);
    h.send({ jsonrpc: "2.0", id: 2, method: "ui/initialize", params: {} }, null);
    h.bridge.handleMessage({ source: undefined, data: { jsonrpc: "2.0", id: 3, method: "ui/initialize", params: {} } });
    await h.flush();
    expect(h.sent).toEqual([]);
    const blind = createAppBridge({ doc: botDoc(), hostContext: {}, adapter: { post: () => { throw new Error("must not post"); } } as unknown as AppBridgeAdapter, source: () => null, hostVersion: "1" });
    blind.handleMessage({ source: null, data: { jsonrpc: "2.0", id: 1, method: "ui/initialize" } });
  });

  it("drops anything that is not a JSON-RPC 2.0 object of at most 1 MB", async () => {
    const h = harness();
    await h.connect();
    const before = h.sent.length;
    const cyclic: Record<string, unknown> = { jsonrpc: "2.0", id: 9, method: "ping" };
    cyclic.self = cyclic;
    for (const data of [
      null, "ping", 42, [], [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      { id: 1, method: "ping" }, { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: { nested: true }, method: "ping" }, { jsonrpc: "2.0", id: 1, method: "" },
      { jsonrpc: "2.0", id: 1, method: "ping", params: ["positional"] }, { jsonrpc: "2.0", id: 1, method: "ping", params: "x" },
      { jsonrpc: "2.0", id: 1, method: "ping", params: { blob: "x".repeat(APP_FRAME_LIMITS.messageBytes) } },
      { jsonrpc: "2.0", id: 1, method: "ping", params: { blob: "é".repeat(APP_FRAME_LIMITS.messageBytes / 2) } },
      { jsonrpc: "2.0", id: 1, method: "ping", big: 10n }, cyclic,
      { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, error: "nope" },
    ]) h.send(data);
    await h.flush();
    expect(h.sent).toHaveLength(before);
    // Just under the line is fine.
    expect((await h.request("ping", { blob: "x".repeat(APP_FRAME_LIMITS.messageBytes - 100) }))?.result).toEqual({});
  });
});

describe("teardown", () => {
  it("asks the View and resolves when it answers", async () => {
    const h = harness();
    await h.connect();
    let done = false;
    const pending = h.bridge.teardown().then(() => { done = true; });
    const ask = h.sent.at(-1) as { id: string; method: string };
    expect(ask).toMatchObject({ jsonrpc: "2.0", method: "ui/resource-teardown", params: {} });
    await h.flush();
    expect(done).toBe(false);
    h.send({ jsonrpc: "2.0", id: ask.id, result: {} });
    await pending;
    expect(done).toBe(true);
  });

  it("resolves after 1 s when the View never answers, and at once before initialized", async () => {
    const h = harness();
    await h.bridge.teardown();
    expect(h.sent).toEqual([]);
    await h.connect();
    let done = false;
    const pending = h.bridge.teardown().then(() => { done = true; });
    await h.advance(999);
    expect(done).toBe(false);
    await h.advance(1);
    await pending;
    expect(done).toBe(true);
  });

  it("goes quiet once disposed", async () => {
    const h = harness();
    await h.connect();
    await h.request("ui/update-model-context", { content: [{ type: "text", text: "a" }] });
    await h.request("ui/update-model-context", { content: [{ type: "text", text: "b" }] });
    const teardown = h.bridge.teardown();
    h.bridge.dispose();
    await teardown;
    const before = h.sent.length;
    expect(await h.request("ping")).toBeUndefined();
    h.bridge.contextChanged({ theme: "light" });
    await h.advance(5_000);
    expect(h.sent).toHaveLength(before);
    expect(h.calls.contexts).toHaveLength(1);
  });
});

describe("hostCapabilitiesFor", () => {
  it("never offers server calls to a bot's page, and grants no permissions", () => {
    const doc = { ...botDoc(), can: { serverTools: true, serverResources: true, message: true, openLinks: true, modelContext: true } };
    const capabilities = hostCapabilitiesFor(doc);
    expect(capabilities).not.toHaveProperty("serverTools");
    expect(capabilities).not.toHaveProperty("serverResources");
    expect(capabilities.sandbox).toEqual({ permissions: {}, csp: { connectDomains: BOT_HTML_NETWORK.connect, resourceDomains: BOT_HTML_NETWORK.resources } });
  });
});
