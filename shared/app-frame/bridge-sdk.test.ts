// The official MCP Apps SDK View (`App` from @modelcontextprotocol/ext-apps) against our bridge router, over a
// fake window pair that behaves like an iframe and its parent: postMessage delivers a structured clone
// asynchronously, with `source` set to the sending window.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-with-deps";

import type { AppDocument } from "../app.ts";
import { createAppBridge, type AppBridge } from "./bridge.ts";

type Listener = (event: { source: unknown; data: unknown }) => void;

const DOC: AppDocument = {
  v: 1, messageId: "m1", rev: 0, srcdoc: "<!DOCTYPE html>", csp: "default-src 'none'",
  network: { connect: [], resources: ["https://esm.sh"] },
  tool: { name: "debug-tool", title: "Debug Tool", inputSchema: { type: "object", properties: {} } },
  toolInput: { includeMeta: true },
  toolResult: { content: [{ type: "text", text: "done" }], structuredContent: { ok: true }, _meta: { trace: "t1" } },
  can: { serverTools: true, serverResources: true, message: true, openLinks: true, modelContext: true },
};

describe("the SDK's App against the bridge", () => {
  const frameListeners = new Set<Listener>();
  // The iframe's window: the bridge posts into it.
  const frameWindow = {
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      setTimeout(() => { for (const listener of frameListeners) listener({ source: parentWindow, data: copy }); }, 0);
    },
    addEventListener(type: string, listener: Listener) { if (type === "message") frameListeners.add(listener); },
    removeEventListener(type: string, listener: Listener) { if (type === "message") frameListeners.delete(listener); },
  };
  // The host's window: the View posts into it, and the bridge hears it.
  let bridge: AppBridge;
  const parentWindow = {
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      setTimeout(() => bridge.handleMessage({ source: frameWindow, data: copy }), 0);
    },
  };
  const seen = {
    rpc: [] as Array<{ method: string; params: Record<string, unknown> }>,
    messages: [] as string[], links: [] as string[], contexts: [] as unknown[], heights: [] as number[],
  };
  const app = new App({ name: "compat-view", version: "1.0.0" }, {}, { autoResize: false });
  const toolInputs: unknown[] = [];
  const toolResults: unknown[] = [];
  let tornDown = 0;
  const previousWindow = (globalThis as { window?: unknown }).window;

  beforeAll(async () => {
    // The SDK narrates every frame on console.debug.
    vi.spyOn(console, "debug").mockImplementation(() => {});
    (globalThis as { window?: unknown }).window = frameWindow;
    bridge = createAppBridge({
      doc: DOC,
      hostContext: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: 600, maxHeight: 500 }, platform: "desktop" },
      source: () => frameWindow,
      hostVersion: "0.1.108",
      adapter: {
        post: (message) => frameWindow.postMessage(message),
        callRpc: async (method, params) => {
          seen.rpc.push({ method, params });
          if (method === "tools/call") return { content: [{ type: "text", text: `ran ${String(params.name)}` }], structuredContent: { ran: params.name } };
          if (method === "tools/list") return { tools: [{ name: "debug-refresh", inputSchema: { type: "object" } }] };
          if (method === "resources/read") return { contents: [{ uri: String(params.uri), mimeType: "text/plain", text: "hello" }] };
          return { resources: [] };
        },
        sendMessage: async (text) => { seen.messages.push(text); },
        openLink: (url) => { seen.links.push(url); },
        setContext: (update) => { seen.contexts.push(update); },
        resize: (height) => { seen.heights.push(height); },
        engaged: () => true,
        teardownRequested: () => {},
        now: () => Date.now(),
      },
    });
    app.ontoolinput = (params) => { toolInputs.push(params); };
    app.ontoolresult = (params) => { toolResults.push(params); };
    app.onteardown = async () => { tornDown += 1; return {}; };
    await app.connect(new PostMessageTransport(parentWindow as unknown as Window, parentWindow as unknown as Window));
  });

  afterAll(async () => {
    await app.close().catch(() => {});
    (globalThis as { window?: unknown }).window = previousWindow;
    vi.restoreAllMocks();
  });

  it("connects: the handshake completes and the View reads our capabilities and context", async () => {
    // `initialized` is a notification the View sends after connect() resolves.
    await expect.poll(() => bridge.initialized).toBe(true);
    expect(app.getHostVersion()).toEqual({ name: "mausbot", version: "0.1.108" });
    expect(app.getHostCapabilities()).toMatchObject({ serverTools: {}, serverResources: {}, message: { text: {} }, openLinks: {}, sandbox: { permissions: {} } });
    expect(app.getHostContext()).toMatchObject({ theme: "dark", displayMode: "inline", toolInfo: { tool: { name: "debug-tool" } } });
  });

  it("receives the tool input and then the tool result, once each", async () => {
    await expect.poll(() => toolResults.length).toBe(1);
    expect(toolInputs).toEqual([{ arguments: { includeMeta: true } }]);
    expect(toolResults).toEqual([DOC.toolResult]);
  });

  it("reaches the adapters through callServerTool, readServerResource, sendMessage, openLink and updateModelContext", async () => {
    const result = await app.callServerTool({ name: "debug-refresh", arguments: {} });
    expect(result).toMatchObject({ content: [{ type: "text", text: "ran debug-refresh" }], structuredContent: { ran: "debug-refresh" } });
    const resource = await app.readServerResource({ uri: "ui://debug/data" });
    expect(resource.contents[0]).toMatchObject({ uri: "ui://debug/data", text: "hello" });
    expect(seen.rpc.map((call) => call.method)).toEqual(["tools/call", "resources/read"]);
    expect(seen.rpc[0]!.params).toMatchObject({ name: "debug-refresh", arguments: {} });

    expect(await app.sendMessage({ role: "user", content: [{ type: "text", text: "Send Text" }] })).toEqual({});
    expect(seen.messages).toEqual(["Send Text"]);
    expect(await app.openLink({ url: "https://modelcontextprotocol.io" })).toEqual({});
    expect(seen.links).toEqual(["https://modelcontextprotocol.io/"]);
    await app.updateModelContext({ content: [{ type: "text", text: "Looking at row 3" }], structuredContent: { row: 3 } });
    await expect.poll(() => seen.contexts.length).toBe(1);
    expect(seen.contexts[0]).toEqual({ content: [{ type: "text", text: "Looking at row 3" }], structuredContent: { row: 3 } });
  });

  it("is told inline when it asks for another display mode, and its size reaches the frame", async () => {
    expect(await app.requestDisplayMode({ mode: "fullscreen" })).toMatchObject({ mode: "inline" });
    await app.sendSizeChanged({ width: 800, height: 600 });
    await expect.poll(() => seen.heights.length).toBe(1);
    expect(seen.heights).toEqual([500]);
  });

  it("gets an error, not a crash, for an image message", async () => {
    await expect(app.sendMessage({ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })).rejects.toThrow(/text messages/);
    expect(seen.messages).toEqual(["Send Text"]);
  });

  it("hears host context changes and answers teardown", async () => {
    let changed: unknown;
    app.onhostcontextchanged = (params) => { changed = params; };
    bridge.contextChanged({ theme: "light" });
    await expect.poll(() => changed).toEqual({ theme: "light" });
    expect(app.getHostContext()).toMatchObject({ theme: "light" });
    await bridge.teardown();
    expect(tornDown).toBe(1);
  });
});
