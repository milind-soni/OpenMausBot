import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { APP_EXTENSION_KEY, APP_MIME } from "../shared/app.ts";
import {
  APP_ONLY_REFUSAL, APP_REPORT_MAX_BYTES, AppObserver, appReportBody, modelVisible, parseAppMount, toolUiResource, toolVisibility,
  withUiExtension, withoutAppOnlyTools, type AppMount, type McpAppReport,
} from "./mcp-app-observer.ts";
import { gateServer, mcpStdioServer, type StdioServer } from "./mcp-gate-config.ts";
import { RemoteMcpClient } from "./mcp-http.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startFakeHttpMcp, type FakeHttpMcp, type FakeHttpMcpTool } from "./testing/fake-http-mcp-server.ts";

const FAKE_APP = fileURLToPath(new URL("./testing/fake-stdio-app-server.ts", import.meta.url));
const TOKEN = "omb-comms-token-fixture";
const BOARD_URI = "ui://fake-app/board.html";

const HTTP_TOOLS: FakeHttpMcpTool[] = [
  { name: "create_view", title: "Create view", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://draw/view.html" } } },
  { name: "list_notes", inputSchema: { type: "object" } },
  { name: "save_checkpoint", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://draw/view.html", visibility: ["app"] } } },
];
const HTTP_RESOURCES = [{ uri: "ui://draw/view.html", mimeType: APP_MIME, text: "<p>view</p>", _meta: { ui: { csp: { resourceDomains: ["https://esm.sh"] } } } }];

describe("what an app is", () => {
  it("reads a tool's UI from _meta.ui.resourceUri or the deprecated flat key, and only a ui:// one", () => {
    expect(toolUiResource({ _meta: { ui: { resourceUri: "ui://a/b.html" } } })).toBe("ui://a/b.html");
    expect(toolUiResource({ _meta: { "ui/resourceUri": "ui://a/old.html" } })).toBe("ui://a/old.html");
    expect(toolUiResource({ _meta: { ui: { resourceUri: "https://a.example/b.html" } } })).toBeUndefined();
    expect(toolUiResource({ name: "plain" })).toBeUndefined();
  });

  it("defaults visibility to model and app, and drops only tools whose visibility lacks model", () => {
    expect(toolVisibility({})).toEqual(["model", "app"]);
    expect(toolVisibility({ _meta: { ui: { visibility: ["app"] } } })).toEqual(["app"]);
    expect(modelVisible({ _meta: { ui: { visibility: ["app"] } } })).toBe(false);
    expect(modelVisible({ _meta: { ui: { visibility: ["model"] } } })).toBe(true);
    const listed = { tools: HTTP_TOOLS, nextCursor: "2" };
    expect(withoutAppOnlyTools(listed)).toEqual({ tools: HTTP_TOOLS.slice(0, 2), nextCursor: "2" });
    expect(withoutAppOnlyTools({ tools: HTTP_TOOLS.slice(0, 2) })).toEqual({ tools: HTTP_TOOLS.slice(0, 2) });
  });

  it("adds the UI extension to an initialize and keeps everything else", () => {
    const claude = { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true }, extensions: { other: {} } }, clientInfo: { name: "claude-code" } };
    expect(withUiExtension(claude)).toEqual({ ...claude, capabilities: { roots: { listChanged: true }, extensions: { other: {}, [APP_EXTENSION_KEY]: { mimeTypes: [APP_MIME] } } } });
  });

  it("reads a mount's settings, and refuses unreadable ones instead of not observing", () => {
    const mount = { server: "draw", harnessUrl: "http://127.0.0.1:8799", token: "t", extension: true };
    expect(parseAppMount(JSON.stringify(mount))).toEqual(mount);
    expect(parseAppMount(undefined)).toBeUndefined();
    for (const bad of ["{", JSON.stringify({ ...mount, server: "Bad Name" }), JSON.stringify({ ...mount, harnessUrl: "file:///x" }), JSON.stringify({ ...mount, token: "" })]) {
      expect(() => parseAppMount(bad)).toThrow(/invalid MCP apps configuration/);
    }
  });
});

describe("the report's size", () => {
  const report = (result: McpAppReport["result"], args: Record<string, unknown> = {}): McpAppReport => ({
    tool: "mcp_app", server: "draw", definition: { name: "create_view", _meta: { ui: { resourceUri: "ui://draw/view.html" } } }, call: { arguments: args }, result,
  });

  it("sends a report that fits as it is", () => {
    const small = report({ content: [{ type: "text", text: "ok" }], structuredContent: { a: 1 } });
    expect(JSON.parse(appReportBody(small)!)).toEqual(small);
  });

  it("drops structuredContent first and says so, then content that is not text, then clips the text", () => {
    const big = "s".repeat(APP_REPORT_MAX_BYTES);
    const dropped = JSON.parse(appReportBody(report({ content: [{ type: "text", text: "kept" }], structuredContent: { big } }))!);
    expect(dropped).toMatchObject({ oversized: true, result: { content: [{ type: "text", text: "kept" }] } });
    expect(dropped.result).not.toHaveProperty("structuredContent");
    const image = JSON.parse(appReportBody(report({ content: [{ type: "image", data: big, mimeType: "image/png" }, { type: "text", text: "caption" }] }))!);
    expect(image.result.content).toEqual([{ type: "text", text: "caption" }]);
    const clipped = appReportBody(report({ content: [{ type: "text", text: big }, { type: "text", text: big }] }))!;
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(APP_REPORT_MAX_BYTES);
    expect(JSON.parse(clipped).result.content).toHaveLength(2);
    // arguments alone too large: nothing is sent
    expect(appReportBody(report({ content: [] }, { big }))).toBeNull();
  });
});

async function fakeHarness() {
  const reports: Array<{ headers: IncomingHttpHeaders; body: McpAppReport }> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      reports.push({ headers: req.headers, body: JSON.parse(body) as McpAppReport });
      res.writeHead(req.url === "/api/internal/options-card" ? 201 : 404, { "content-type": "application/json" }).end("{\"messageId\":\"m1\"}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, reports, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

type Reply = { id?: unknown; result?: any; error?: { code: number; message: string } };

describe("the observer in a process", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let harness: Awaited<ReturnType<typeof fakeHarness>> | undefined;
  let fake: FakeHttpMcp | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    child = undefined;
    await harness?.close(); harness = undefined;
    await fake?.close(); fake = undefined;
    if (scratch) await removeTempDir(scratch);
    scratch = undefined;
  });

  const start = (descriptor: StdioServer | { command: string; args: string[]; env: Record<string, string> }) => {
    child = spawn(descriptor.command, ["--experimental-strip-types", "--no-warnings", ...(descriptor.args ?? [])], { stdio: "pipe", env: { ...process.env, ...descriptor.env } });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const ask = async (id: number, method: string, params?: unknown): Promise<Reply> => {
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      return JSON.parse((await lines.next()).value as string) as Reply;
    };
    const notify = (method: string) => child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    return { ask, notify };
  };
  const mountFor = (server: string, extension = true): AppMount => ({ server, harnessUrl: harness!.url, token: TOKEN, extension });
  const appServer = (env: Record<string, string> = {}) => ({ command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_APP], env });
  const logged = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: any });
  const until = async (check: () => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it("gate: advertises the extension in the CLI's own handshake, hides app-only tools, and reports a UI call before trimming it", async () => {
    harness = await fakeHarness();
    scratch = mkdtempSync(join(tmpdir(), "omb-app-observer-"));
    const log = join(scratch, "frames.jsonl");
    const gated = gateServer({ name: "board", server: appServer({ FAKE_APP_LOG: log }), threadId: "t-observer", budget: 2_000, apps: mountFor("board") })!;
    expect(gated.env.OMB_GATE_APPS).toBeDefined();
    const { ask, notify } = start(gated);

    const cli = { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "claude-code", version: "2.1.288" } };
    expect((await ask(1, "initialize", cli)).result.serverInfo).toEqual({ name: "fake-app", title: "Fake App", version: "1" });
    notify("notifications/initialized");
    const sent = logged(log).find((frame) => frame.method === "initialize")!;
    expect(sent.params).toEqual(withUiExtension(cli));

    const listed = (await ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name);
    expect(listed).toEqual(["show_board", "paint_board", "peek_board", "plain_echo"]);
    expect((await ask(3, "tools/call", { name: "save_board", arguments: {} })).error).toEqual({ code: -32602, message: APP_ONLY_REFUSAL });

    const call = await ask(4, "tools/call", { name: "show_board", arguments: { text: 20_000 }, _meta: { "claudecode/toolUseId": "toolu_123" } });
    // the engine gets the trimmed text...
    expect(call.result.content[0].text.length).toBeLessThan(20_000);
    await until(() => harness!.reports.length === 1);
    const [report] = harness.reports;
    expect(report!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // ...and the harness the whole result, as the server sent it
    expect(report!.body).toEqual({
      tool: "mcp_app", server: "board", serverInfo: { name: "fake-app", title: "Fake App", version: "1" },
      definition: expect.objectContaining({ name: "show_board", title: "Show board", annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: BOARD_URI }, "ui/resourceUri": BOARD_URI } }),
      call: { arguments: { text: 20_000 }, toolUseId: "toolu_123" },
      result: { content: [{ type: "text", text: "t".repeat(20_000) }], structuredContent: { cards: 3 }, _meta: { "fake-app/at": "2026-10-14T00:00:00Z" } },
    });
    expect(logged(log).filter((frame) => frame.method === "tools/call").map((frame) => frame.params.name)).toEqual(["show_board"]);

    // a tool without a UI is relayed and not reported
    expect((await ask(5, "tools/call", { name: "plain_echo", arguments: { text: "hi" } })).result.content[0].text).toBe("hi");
    // a result too large for the internal route loses its structuredContent
    await ask(6, "tools/call", { name: "show_board", arguments: { large: 1_000_000 } });
    await until(() => harness!.reports.length === 2);
    expect(harness.reports[1]!.body).toMatchObject({ oversized: true, result: { content: [{ type: "text", text: "Board with 3 cards" }] } });
    expect(harness.reports[1]!.body.result).not.toHaveProperty("structuredContent");
  }, 30_000);

  it("gate: a server that refuses the extension gets the CLI's own handshake, and the CLI that answer", async () => {
    harness = await fakeHarness();
    scratch = mkdtempSync(join(tmpdir(), "omb-app-observer-"));
    const log = join(scratch, "frames.jsonl");
    const { ask } = start(gateServer({ name: "board", server: appServer({ FAKE_APP_LOG: log, FAKE_APP_STRICT: "1" }), threadId: "t-strict", budget: 0, apps: mountFor("board") })!);
    const cli = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "0.153.4" } };
    expect((await ask(7, "initialize", cli)).result.serverInfo.name).toBe("fake-app");
    expect(logged(log).filter((frame) => frame.method === "initialize").map((frame) => frame.params)).toEqual([withUiExtension(cli), cli]);
    expect((await ask(8, "tools/list")).result.tools).toHaveLength(4);
  }, 30_000);

  it("gate without apps: still hides app-only tools, observes nothing, rewrites nothing", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-app-observer-"));
    const log = join(scratch, "frames.jsonl");
    const gated = gateServer({ name: "board", server: appServer({ FAKE_APP_LOG: log }), threadId: "t-plain", budget: 1_000 })!;
    expect(gated.env).not.toHaveProperty("OMB_GATE_APPS");
    const { ask } = start(gated);
    const cli = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "1" } };
    await ask(1, "initialize", cli);
    expect(logged(log)[0]!.params).toEqual(cli);
    expect((await ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["show_board", "paint_board", "peek_board", "plain_echo"]);
    expect((await ask(3, "tools/call", { name: "wipe_board", arguments: {} })).error?.message).toBe(APP_ONLY_REFUSAL);
  }, 30_000);

  it("proxy: advertises the extension upstream, hides app-only tools, and reports a UI call", async () => {
    harness = await fakeHarness();
    fake = await startFakeHttpMcp({ tools: HTTP_TOOLS, resources: HTTP_RESOURCES, serverTitle: "Draw",
      callResult: () => ({ content: [{ type: "text", text: "drawn" }], structuredContent: { elements: 2 }, _meta: { viewUUID: "v-1" } }) });
    const proxy = mcpStdioServer({ type: "http", url: fake.url, headers: {} }, { apps: mountFor("draw") })!;
    expect(JSON.parse(proxy.env!.OMB_REMOTE_MCP_APPS!)).toEqual(mountFor("draw"));
    const { ask } = start(proxy);
    await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gemini", version: "1" } });
    expect(fake.initializes).toEqual([{ protocolVersion: "2025-06-18", capabilities: { extensions: { [APP_EXTENSION_KEY]: { mimeTypes: [APP_MIME] } } }, clientInfo: { name: "OpenMausBot tool proxy", version: "1" } }]);
    expect((await ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["create_view", "list_notes"]);
    expect((await ask(3, "tools/call", { name: "save_checkpoint", arguments: {} })).error).toEqual({ code: -32602, message: APP_ONLY_REFUSAL });
    expect((await ask(4, "tools/call", { name: "create_view", arguments: { elements: "[]" } })).result.structuredContent).toEqual({ elements: 2 });
    await until(() => harness!.reports.length === 1);
    expect(harness.reports[0]!.body).toMatchObject({
      tool: "mcp_app", server: "draw", serverInfo: { name: "fake-http-mcp", title: "Draw" },
      definition: { name: "create_view", _meta: { ui: { resourceUri: "ui://draw/view.html" } } },
      call: { arguments: { elements: "[]" } },
      result: { content: [{ type: "text", text: "drawn" }], structuredContent: { elements: 2 }, _meta: { viewUUID: "v-1" } },
    });
    expect(fake.calls).toEqual([{ name: "create_view", arguments: { elements: "[]" } }]);
  }, 30_000);

  it("proxy: a strict server refuses the extension and still connects, through the fallback", async () => {
    harness = await fakeHarness();
    fake = await startFakeHttpMcp({ strictInitialize: "http-400", tools: HTTP_TOOLS });
    const { ask } = start(mcpStdioServer({ type: "http", url: fake.url, headers: {} }, { apps: mountFor("strict") })!);
    expect((await ask(1, "initialize", {})).result.serverInfo.name).toBe("fake-http-mcp");
    expect((await ask(2, "tools/list")).result.tools).toHaveLength(2);
    const plain = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot tool proxy", version: "1" } };
    expect(fake.initializes).toEqual([{ ...plain, capabilities: { extensions: { [APP_EXTENSION_KEY]: { mimeTypes: [APP_MIME] } } } }, plain]);
  }, 30_000);

  it("proxy without apps: the same handshake as before, and app-only tools still hidden (directory mode too)", async () => {
    fake = await startFakeHttpMcp({ tools: HTTP_TOOLS });
    const plain = start(mcpStdioServer({ type: "http", url: fake.url, headers: {} })!);
    await plain.ask(1, "initialize", {});
    expect(fake.initializes).toEqual([{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot tool proxy", version: "1" } }]);
    expect((await plain.ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["create_view", "list_notes"]);
    const closed = once(child!, "close"); child!.kill(); await closed;
    const searched = start(mcpStdioServer({ type: "http", url: fake.url, headers: {} }, { directory: { name: "draw" } })!);
    await searched.ask(1, "initialize", {});
    expect((await searched.ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["create_view", "list_notes"]);
    expect((await searched.ask(3, "tools/call", { name: "save_checkpoint", arguments: {} })).error?.message).toBe(APP_ONLY_REFUSAL);
  }, 30_000);

  it("gate over proxy: only the proxy, the innermost, reports a call", async () => {
    harness = await fakeHarness();
    fake = await startFakeHttpMcp({ tools: HTTP_TOOLS, resources: HTTP_RESOURCES });
    const gated = gateServer({ name: "draw", server: { type: "http", url: fake.url, headers: {} }, threadId: "t-both", budget: 0,
      toolScope: { allow: ["mcp:draw:*"] }, apps: mountFor("draw") })!;
    expect(gated.env).not.toHaveProperty("OMB_GATE_APPS");
    const upstream = JSON.parse(gated.env.OMB_GATE_UPSTREAM!);
    expect(upstream.args[0]).toContain("mcp-remote-proxy");
    expect(JSON.parse(upstream.env.OMB_REMOTE_MCP_APPS)).toEqual(mountFor("draw"));
    const { ask } = start(gated);
    await ask(1, "initialize", {});
    expect((await ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["create_view", "list_notes"]);
    await ask(3, "tools/call", { name: "create_view", arguments: {} });
    await until(() => harness!.reports.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(harness.reports).toHaveLength(1);
  }, 30_000);
});

describe("the observer object", () => {
  it("reports nothing for a tool it never saw listed, or one without a UI, and never throws into the relay", async () => {
    const posted: string[] = [];
    const observer = new AppObserver({ server: "draw", harnessUrl: "http://127.0.0.1:9", token: "t", extension: true }, { post: async (body) => { posted.push(body); }, log: () => {} });
    observer.returned({ name: "create_view", arguments: {} }, { content: [] });
    observer.listed({ tools: HTTP_TOOLS });
    observer.returned({ name: "list_notes", arguments: {} }, { content: [] });
    observer.returned({ name: "create_view" }, { content: "not a list" });
    observer.returned(null, null);
    expect(posted).toEqual([]);
    expect(observer.appOnly("save_checkpoint")).toBe(true);
    expect(observer.appOnly("create_view")).toBe(false);
    observer.returned({ name: "create_view", arguments: { a: 1 } }, { content: [{ type: "text", text: "x" }], isError: true });
    await Promise.all(observer.inFlight);
    expect(JSON.parse(posted[0]!)).toMatchObject({ call: { arguments: { a: 1 } }, result: { isError: true } });
  });

  it("goes to the harness over HTTP, and a refusal only reaches stderr", async () => {
    const harness = await fakeHarness();
    try {
      const lines: string[] = [];
      const observer = new AppObserver({ server: "draw", harnessUrl: `${harness.url}/elsewhere/`, token: TOKEN, extension: true }, { log: (line) => lines.push(line) });
      observer.listed({ tools: HTTP_TOOLS });
      observer.returned({ name: "create_view", arguments: {} }, { content: [] });
      await Promise.all(observer.inFlight);
      expect(harness.reports).toHaveLength(1);
      expect(lines).toEqual([]);
      // a dead harness: logged, nothing thrown
      const dead = new AppObserver({ server: "draw", harnessUrl: "http://127.0.0.1:9", token: TOKEN, extension: true }, { log: (line) => lines.push(line) });
      dead.listed({ tools: HTTP_TOOLS });
      dead.returned({ name: "create_view", arguments: {} }, { content: [] });
      await Promise.all(dead.inFlight);
      expect(lines.join("\n")).toMatch(/app report failed/);
    } finally {
      await harness.close();
    }
  });
});

describe("OMB's own client and the UI extension", () => {
  it("advertises it, and against a strict server falls back to the plain handshake once and says refused", async () => {
    for (const strictInitialize of ["http-400", "jsonrpc-error"] as const) {
      const fake = await startFakeHttpMcp({ strictInitialize, tools: HTTP_TOOLS });
      try {
        const client = new RemoteMcpClient({ type: "http", url: fake.url, headers: {} });
        await client.initialize("OpenMausBot", AbortSignal.timeout(5_000), { extensions: { [APP_EXTENSION_KEY]: { mimeTypes: [APP_MIME] } } });
        expect(client.extensions).toBe("refused");
        expect((await client.request("tools/list", {}, AbortSignal.timeout(5_000)) as { tools: unknown[] }).tools).toHaveLength(3);
        expect(fake.initializes).toHaveLength(2);
        expect(fake.initializes[1]).toEqual({ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot", version: "1" } });
        await client.close();
      } finally {
        await fake.close();
      }
    }
    const lenient = await startFakeHttpMcp({ tools: HTTP_TOOLS });
    try {
      const client = new RemoteMcpClient({ type: "http", url: lenient.url, headers: {} });
      await client.initialize("OpenMausBot", AbortSignal.timeout(5_000), { extensions: { [APP_EXTENSION_KEY]: { mimeTypes: [APP_MIME] } } });
      expect(client.extensions).toBe("ok");
      expect(lenient.initializes).toHaveLength(1);
      await client.close();
    } finally {
      await lenient.close();
    }
  });
});

// Keep the scratch helpers honest: a write the gate's fake logs is readable.
it("the fake app server logs every frame it is sent", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-app-observer-"));
  try {
    const log = join(scratch, "frames.jsonl");
    writeFileSync(log, "");
    const fake = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", FAKE_APP], { stdio: "pipe", env: { ...process.env, FAKE_APP_LOG: log } });
    const lines = createInterface({ input: fake.stdout })[Symbol.asyncIterator]();
    fake.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: BOARD_URI } })}\n`);
    const read = JSON.parse((await lines.next()).value as string);
    expect(read.result.contents[0]).toMatchObject({ uri: BOARD_URI, mimeType: APP_MIME, _meta: { ui: { prefersBorder: true } } });
    expect(readFileSync(log, "utf8")).toContain("resources/read");
    const closed = once(fake, "close"); fake.kill(); await closed;
  } finally {
    await removeTempDir(scratch);
  }
});
