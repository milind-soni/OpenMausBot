import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { CALL_TOOL, DESCRIBE_TOOL, INSTRUCTIONS_CHARS, SEARCH_TOOL, SIGNATURE_CHARS } from "./mcp-directory.ts";
import { gateServer, mcpStdioServer } from "./mcp-gate-config.ts";
import { SERVER_ROOT } from "./proxy-paths.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { makeTestTls, TEST_TLS_HOST } from "./testing/test-tls.ts";
import { whopLikeCatalog } from "./testing/whop-like-catalog.ts";

const TOKEN = "disposable-remote-fixture-token";
type Frame = { id?: string | number; method?: string; params?: Record<string, unknown> };

async function remoteFixture(mode: "http" | "event-stream" | "sse") {
  const calls: string[] = [];
  const frames: Frame[] = [];
  const events = new EventEmitter();
  const streams = new Set<ServerResponse>();
  let signalClosed!: () => void;
  const closed = new Promise<void>((resolve) => { signalClosed = resolve; });
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
      if (req.method === "DELETE") { signalClosed(); return res.writeHead(204).end(); }
      if (mode === "sse" && req.method === "GET") {
        streams.add(res);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
        res.on("close", () => { streams.delete(res); signalClosed(); });
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      const frame = JSON.parse(body) as Frame;
      frames.push(frame);
      let result: unknown;
      let error: unknown;
      if (frame.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "disposable", version: "1" } };
      } else if (frame.method === "tools/list") {
        result = frame.params?.cursor === "next" ? { tools: [{ name: "write", inputSchema: { type: "object" } }] }
          : { tools: [{ name: "read", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } }], nextCursor: "next" };
      } else if (frame.method === "tools/call") {
        const name = frame.params?.name as string;
        calls.push(name);
        events.emit("call", frame);
        if (frame.params?.arguments && (frame.params.arguments as Record<string, unknown>).hold) {
          if (mode === "sse") res.writeHead(202).end();
          return;
        }
        if ((frame.params?.arguments as Record<string, unknown>)?.error) error = { code: -32000, message: TOKEN };
        else result = { content: [{ type: "text", text: (frame.params?.arguments as Record<string, unknown>)?.large ? "x".repeat(2_000_000) : "read completed" }] };
      } else {
        if (frame.method === "notifications/cancelled") events.emit("cancelled", frame);
        return res.writeHead(202).end();
      }
      const answer = JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...(error ? { error } : { result }) });
      if (mode === "sse") {
        res.writeHead(202).end();
        for (const stream of streams) stream.write(`event: message\ndata: ${answer}\n\n`);
      } else if (mode === "event-stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "disposable-session" });
        res.end(`event: message\ndata: ${answer}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "disposable-session" }).end(answer);
      }
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    spec: { type: mode === "sse" ? "sse" as const : "http" as const, url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } },
    calls, frames, events, closed,
    close: () => new Promise<void>((resolve) => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

describe("scoped remote MCP subprocess", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let fixture: Awaited<ReturnType<typeof remoteFixture>> | undefined;
  let scratch: string | undefined;
  let lines: string[];
  let waiter: ((line: string) => void) | undefined;
  let stderr: string;

  function start(descriptor: NonNullable<ReturnType<typeof gateServer>>) {
    lines = [];
    stderr = "";
    child = spawn(descriptor.command, ["--experimental-strip-types", "--no-warnings", ...descriptor.args], {
      stdio: "pipe", env: { ...process.env, ...descriptor.env },
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (waiter) { const consume = waiter; waiter = undefined; consume(line); }
      else lines.push(line);
    });
  }

  function send(frame: Frame) { child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`); }
  async function answer() {
    const line = lines.shift() ?? await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No remote reply: ${stderr}`)), 5_000);
      waiter = (value) => { clearTimeout(timer); resolve(value); };
    });
    return JSON.parse(line);
  }
  async function initialize() {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
    expect((await answer()).result.serverInfo.name).toBe("disposable");
    send({ method: "notifications/initialized" });
  }

  afterEach(async () => {
    waiter = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    child = undefined;
    await fixture?.close(); fixture = undefined;
    if (scratch) await removeTempDir(scratch);
    scratch = undefined;
  });

  it.each(["http", "event-stream", "sse"] as const)("filters and executes over %s with private headers and orderly shutdown", async (mode) => {
    fixture = await remoteFixture(mode);
    const gated = gateServer({ name: "notes", server: fixture.spec, budget: 0, threadId: "fixture", toolScope: { allow: ["mcp:notes:read"] } });
    expect(gated!.args.join(" ")).not.toContain(TOKEN);
    expect(gated!.args.join(" ")).not.toContain(fixture.spec.url);
    start(gated!);
    await initialize();
    send({ id: 2, method: "tools/list" });
    expect((await answer()).result).toEqual({ tools: [{ name: "read", inputSchema: { type: "object" } }], nextCursor: "next" });
    send({ id: 3, method: "tools/list", params: { cursor: "next" } });
    expect((await answer()).result).toEqual({ tools: [] });
    send({ id: 4, method: "tools/call", params: { name: "write", arguments: {} } });
    expect((await answer()).error.code).toBe(-32602);
    expect(fixture.calls).toEqual([]);
    send({ id: 5, method: "tools/call", params: { name: "read", arguments: {} } });
    expect((await answer()).result.content[0].text).toBe("read completed");
    expect(fixture.calls).toEqual(["read"]);
    const stopped = once(child!, "close"); child!.stdin.end();
    expect((await stopped)[0]).toBe(0);
    await fixture.closed;
    expect(fixture.frames.filter((frame) => frame.method === "notifications/initialized")).toHaveLength(1);
  });

  it.each(["http", "sse"] as const)("cancels an in-flight %s call using its remote request ID", async (mode) => {
    fixture = await remoteFixture(mode);
    start(gateServer({ name: "notes", server: fixture.spec, budget: 0, threadId: "fixture", toolScope: { allow: ["mcp:notes:read"] } })!);
    await initialize();
    const reached = once(fixture.events, "call");
    send({ id: "held-request", method: "tools/call", params: { name: "read", arguments: { hold: true } } });
    const [remote] = await reached;
    const cancelled = once(fixture.events, "cancelled");
    send({ method: "notifications/cancelled", params: { requestId: "held-request" } });
    expect((await cancelled)[0].params.requestId).toBe(remote.id);
    expect(await answer()).toMatchObject({ id: "held-request", error: { code: -32800 } });
  });

  it("does not expose credentials from a remote error", async () => {
    fixture = await remoteFixture("http");
    start(gateServer({ name: "notes", server: fixture.spec, budget: 0, threadId: "fixture", toolScope: { allow: ["mcp:notes:read"] } })!);
    await initialize();
    send({ id: 2, method: "tools/call", params: { name: "read", arguments: { error: true } } });
    const reply = await answer();
    expect(reply.error).toBeDefined();
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
    expect(stderr).not.toContain(TOKEN);
  });

  it("runs the shipped helpers without a TypeScript source tree", async () => {
    fixture = await remoteFixture("http");
    scratch = mkdtempSync(join(tmpdir(), "omb-remote-bundle-"));
    await build({ entryPoints: ["mcp-gate.ts", "mcp-remote-proxy.ts"].map((name) => join(SERVER_ROOT, name)), outdir: scratch, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const gated = gateServer({ name: "notes", server: fixture.spec, budget: 0, threadId: "fixture", toolScope: { allow: ["mcp:notes:read"] } })!;
    gated.args = [join(scratch, "mcp-gate.js")];
    const upstream = JSON.parse(gated.env.OMB_GATE_UPSTREAM);
    upstream.args = [join(scratch, "mcp-remote-proxy.js")];
    gated.env.OMB_GATE_UPSTREAM = JSON.stringify(upstream);
    start(gated);
    await initialize();
    send({ id: 2, method: "tools/call", params: { name: "read", arguments: { large: true } } });
    expect((await answer()).result.content[0].text).toHaveLength(2_000_000);
    expect(fixture.calls).toEqual(["read"]);
  });
});

describe("remote MCP tool directory", () => {
  type Frame = { id?: number | string; method?: string; result?: any; error?: { code: number; message: string } };
  type Descriptor = { command: string; args?: string[]; env?: Record<string, string> };
  let child: ChildProcessWithoutNullStreams | undefined;
  let fake: FakeHttpMcp | undefined;
  let frames: Frame[];
  let arrived: () => void;
  let nextId: number;
  const catalog = whopLikeCatalog(300);
  const spec = (url: string) => ({ type: "http" as const, url, headers: { Authorization: "Bearer directory-fixture-token" } });

  function start(descriptor: Descriptor, inherited: NodeJS.ProcessEnv = process.env) {
    frames = [];
    nextId = 1;
    arrived = () => {};
    child = spawn(descriptor.command, ["--experimental-strip-types", "--no-warnings", ...(descriptor.args ?? [])], {
      stdio: "pipe", env: { ...inherited, ...descriptor.env },
    });
    createInterface({ input: child.stdout }).on("line", (line) => { frames.push(JSON.parse(line)); arrived(); });
  }
  /** The first frame that matches, taken off the queue once it arrives. */
  async function take(match: (frame: Frame) => boolean): Promise<Frame> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const index = frames.findIndex(match);
      if (index !== -1) return frames.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`no matching frame: ${JSON.stringify(frames)}`);
      await new Promise<void>((resolve) => { arrived = resolve; setTimeout(resolve, 100); });
    }
  }
  async function request(method: string, params?: unknown): Promise<Frame> {
    const id = nextId++;
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return take((frame) => frame.id === id);
  }
  async function initialize() {
    expect((await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })).result.serverInfo.name).toBe("fake-http-mcp");
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }
  const call = async (name: string, args?: unknown) => (await request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }));
  const json = (frame: Frame) => JSON.parse(frame.result.content[0].text);

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    child = undefined;
    await fake?.close(); fake = undefined;
  });

  it("answers a big catalog with three tools that search, describe and run it", async () => {
    fake = await startFakeHttpMcp({
      tools: catalog, instructions: `Manage a Whop business.\n${"More detail. ".repeat(400)}`,
      callResult: (params) => ({ content: [{ type: "text", text: "paid" }], structuredContent: { echoed: params } }),
    });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!);
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
    // the server's own instructions pass through, bounded
    expect(initialized.result.instructions.startsWith("Manage a Whop business.\nMore detail.")).toBe(true);
    expect(initialized.result.instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_CHARS);
    const listed = (await request("tools/list")).result.tools;
    expect(listed.map((tool: { name: string }) => tool.name)).toEqual([SEARCH_TOOL, DESCRIBE_TOOL, CALL_TOOL]);
    expect(listed[0].description).toContain('300 tools of the "whop" MCP server (fake-http-mcp)');
    expect(listed[0].description).toContain("About this server: Manage a Whop business. More detail.");

    const found = json(await call(SEARCH_TOOL, { query: "list payments" })).matches;
    expect(found[0].name).toBe("payments_list");
    for (const match of found) expect(match.input.length).toBeLessThanOrEqual(SIGNATURE_CHARS);
    const original = catalog.find((tool) => tool.name === "payments_list")!;
    expect(json(await call(DESCRIBE_TOOL, { name: "payments_list" })).inputSchema).toEqual(original.inputSchema);

    // call_tool forwards the tool's own call and returns its result unchanged
    expect((await call(CALL_TOOL, { name: "payments_list", arguments: { company_id: "biz_1" } })).result).toEqual({
      content: [{ type: "text", text: "paid" }], structuredContent: { echoed: { name: "payments_list", arguments: { company_id: "biz_1" } } },
    });
    expect(fake.calls).toEqual([{ name: "payments_list", arguments: { company_id: "biz_1" } }]);
    // a miss is guidance the model recovers from, not a failed tool call
    const unknown = (await call(CALL_TOOL, { name: "payments_teleport", arguments: {} })).result;
    expect(unknown.isError).toBeUndefined();
    expect(unknown.content[0].text).toContain(SEARCH_TOOL);
    expect(fake.calls).toHaveLength(1);
    // one read of the catalog served the list, the search, the describe and both calls
    expect(fake.toolsLists).toBe(1);
  });

  it("checks call_tool's arguments against the tool's own schema before anything runs", async () => {
    fake = await startFakeHttpMcp({ tools: [
      ...catalog,
      { name: "odd_schema", description: "A tool whose schema this validator cannot read.", inputSchema: { type: "object", properties: { id: { $ref: "#/$defs/Missing" } } } },
    ] });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!);
    await initialize();
    const misfit = (await call(CALL_TOOL, { name: "payments_list", arguments: { first: "ten", surprise: true } })).result;
    expect(misfit.isError).toBeUndefined();
    const advice = JSON.parse(misfit.content[0].text);
    expect(advice.problems).toEqual(expect.arrayContaining([
      "must have required property 'company_id'",
      "must NOT have additional properties (surprise)",
      "first: must be integer",
    ]));
    expect(advice.input).toContain("company_id: string");
    expect(fake.calls).toEqual([]);
    expect((await call(CALL_TOOL, { name: "payments_list", arguments: { company_id: "biz_1", first: 10 } })).result.content[0].text).toBe("remote execution recorded");
    // a schema the validator cannot compile is the server's to enforce
    expect((await call(CALL_TOOL, { name: "odd_schema", arguments: { id: 7 } })).result.content[0].text).toBe("remote execution recorded");
    expect(fake.calls).toEqual([{ name: "payments_list", arguments: { company_id: "biz_1", first: 10 } }, { name: "odd_schema", arguments: { id: 7 } }]);
  });

  it("reads every page of a paginated catalog, once", async () => {
    fake = await startFakeHttpMcp({ tools: catalog, pageSize: 40 });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!);
    await initialize();
    expect((await request("tools/list")).result.tools[0].description).toContain("300 tools");
    const last = catalog.at(-1)!;
    expect(json(await call(DESCRIBE_TOOL, { name: last.name })).inputSchema).toEqual(last.inputSchema);
    expect(fake.toolsLists).toBe(8);
  });

  it("merges a small paginated catalog into one page", async () => {
    const small = whopLikeCatalog(30);
    fake = await startFakeHttpMcp({ tools: small, pageSize: 7 });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!);
    await initialize();
    expect((await request("tools/list")).result).toEqual({ tools: small });
    expect((await request("tools/list", { cursor: "page-7" })).error?.code).toBe(-32602);
  });

  it.each([
    ["a cursor that repeats", { pageSize: 10, cursorLoop: true }, 2],
    ["more than a hundred pages", { pageSize: 1 }, 100],
  ] as const)("refuses a catalog with %s", async (_case, paging, reads) => {
    fake = await startFakeHttpMcp({ tools: whopLikeCatalog(150), ...paging });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!);
    await initialize();
    expect((await request("tools/list")).error).toEqual({ code: -32603, message: "Remote MCP request failed" });
    expect(fake.toolsLists).toBe(reads);
  });

  it("leaves to the server what a checker in front of it cannot judge fairly", async () => {
    const tool = (name: string, inputSchema: Record<string, unknown>) => ({ name, description: `Checks ${name}.`, inputSchema });
    fake = await startFakeHttpMcp({ tools: [
      ...catalog,
      // a schema that refers to itself forever
      tool("self_ref", { $ref: "#" }),
      // a regular expression that would stall the proxy on the wrong input
      tool("codes_check", { type: "object", properties: { code: { type: "string", pattern: "^(a+)+$" } }, required: ["code"] }),
      // validators disagree on formats: a date for a date-time
      tool("reports_since", { type: "object", properties: { since: { type: "string", format: "date-time" } }, required: ["since"] }),
      // properties a branch declares, refused by a strict reading of the level
      tool("charges_make", { type: "object", additionalProperties: false, properties: { kind: { type: "string" } }, anyOf: [{ properties: { amount: { type: "number" } } }] }),
      tool("headers_send", { type: "object", additionalProperties: false, patternProperties: { "^x-": { type: "string" } } }),
      // too big to be worth compiling
      tool("huge_check", { type: "object", description: "x".repeat(70_000), properties: { id: { type: "string" } }, required: ["id"] }),
      // a keyword no JSON Schema version defines
      tool("notes_tagged", { type: "object", properties: { id: { type: "string", example: "note_1", "x-display": "inline" } }, required: ["id"] }),
    ] });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!);
    await initialize();
    const calls = [
      { name: "self_ref", arguments: { anything: true } },
      { name: "codes_check", arguments: { code: `${"a".repeat(40)}!` } },
      { name: "reports_since", arguments: { since: "2026-10-01" } },
      { name: "charges_make", arguments: { kind: "one-off", amount: 5 } },
      { name: "headers_send", arguments: { "x-trace": "1" } },
      { name: "huge_check", arguments: {} },
    ];
    for (const forwarded of calls) {
      expect((await call(CALL_TOOL, forwarded)).result.content[0].text).toBe("remote execution recorded");
    }
    expect(fake.calls).toEqual(calls);
    // a plain mistake is still caught, keywords Ajv does not know included
    expect(JSON.parse((await call(CALL_TOOL, { name: "codes_check", arguments: {} })).result.content[0].text).problems).toContain("must have required property 'code'");
    expect(JSON.parse((await call(CALL_TOOL, { name: "notes_tagged", arguments: {} })).result.content[0].text).problems).toContain("must have required property 'id'");
    expect(fake.calls).toEqual(calls);
  });

  it("passes a small catalog through unchanged", async () => {
    const small = whopLikeCatalog(10);
    fake = await startFakeHttpMcp({ tools: small });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!);
    await initialize();
    expect((await request("tools/list")).result).toEqual({ tools: small });
    expect((await call("payments_list", { company_id: "biz_1" })).result.content[0].text).toBe("remote execution recorded");
  });

  it("lists a big catalog whole when the engine searches tools itself", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    start(mcpStdioServer(spec(fake.url))!);
    await initialize();
    expect((await request("tools/list")).result).toEqual({ tools: catalog });
  });

  it("never finds, describes or runs a tool outside the bot's selection", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop", toolScope: { allow: ["mcp:whop:*"], deny: ["mcp:whop:payments_create"] } } })!);
    await initialize();
    const listed = (await request("tools/list")).result.tools;
    expect(listed[0].description).toContain("299 tools");
    const found = json(await call(SEARCH_TOOL, { query: "create payments", limit: 20 })).matches.map((match: { name: string }) => match.name);
    expect(found).not.toContain("payments_create");
    expect(found).toContain("payments_update");
    expect((await call(DESCRIBE_TOOL, { name: "payments_create" })).result.isError).toBe(true);
    expect((await call(CALL_TOOL, { name: "payments_create", arguments: { company_id: "biz_1" } })).result.isError).toBe(true);
    expect((await call("payments_create", { company_id: "biz_1" })).error?.code).toBe(-32602);
    expect(fake.calls).toEqual([]);
  });

  it("behind the gate, checks and trims call_tool as the tool it runs, and leaves schemas whole", async () => {
    // more than forty selected tools: still a searched catalog, with a narrow selection
    const selected = [...catalog.filter((tool) => tool.name.endsWith("_list")).map((tool) => tool.name), "payments_get", "stats_get"];
    expect(selected.length).toBeGreaterThan(40);
    const padded = whopLikeCatalog(300, 1_000);
    fake = await startFakeHttpMcp({ tools: padded, callResult: () => ({ content: [{ type: "text", text: "r".repeat(5_000) }] }) });
    const gated = gateServer({ name: "whop", server: spec(fake.url), threadId: "directory-fixture", budget: 600,
      toolScope: { allow: selected.map((name) => `mcp:whop:${name}`) }, directory: true });
    expect(gated!.env.OMB_GATE_DIRECTORY).toBe("1");
    start(gated!);
    await initialize();
    const listed = (await request("tools/list")).result.tools;
    expect(listed.map((tool: { name: string }) => tool.name)).toEqual([SEARCH_TOOL, DESCRIBE_TOOL, CALL_TOOL]);
    expect(listed[0].description).toContain(`${selected.length} tools`);
    const found = json(await call(SEARCH_TOOL, { query: "create payments", limit: 20 })).matches.map((match: { name: string }) => match.name);
    expect(found.every((name: string) => selected.includes(name))).toBe(true);
    // the gate refuses before the proxy or the server is reached
    const refused = await call(CALL_TOOL, { name: "payments_create", arguments: { company_id: "biz_1" } });
    expect(refused.error).toMatchObject({ code: -32602, message: expect.stringContaining("Tool selection excludes") });
    // one naming no tool runs nothing: the directory answers it with guidance
    const nameless = (await call(CALL_TOOL, { arguments: {} })).result;
    expect(nameless.isError).toBeUndefined();
    expect(nameless.content[0].text).toContain(SEARCH_TOOL);
    expect(fake.calls).toEqual([]);
    const described = await call(DESCRIBE_TOOL, { name: "payments_list" });
    expect(described.result.content[0].text.length).toBeGreaterThan(600);
    expect(JSON.parse(described.result.content[0].text).inputSchema).toEqual(padded.find((tool) => tool.name === "payments_list")!.inputSchema);
    const ran = (await call(CALL_TOOL, { name: "payments_list", arguments: { company_id: "biz_1" } })).result.content[0].text;
    expect(ran).toContain("[OpenMausBot trimmed this tool result");
    expect(fake.calls).toEqual([{ name: "payments_list", arguments: { company_id: "biz_1" } }]);
  });

  it("reads the catalog again after the server says it changed", async () => {
    fake = await startFakeHttpMcp({ tools: catalog, listChangedOnCall: true });
    start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!);
    await initialize();
    expect(json(await call(SEARCH_TOOL, { query: "zebras" })).matches).toEqual([]);
    fake.setTools([...catalog, { name: "zebras_list", description: "List zebras for a company.", inputSchema: { type: "object" } }]);
    await call(CALL_TOOL, { name: "payments_list", arguments: { company_id: "biz_1" } });
    await take((frame) => frame.method === "notifications/tools/list_changed");
    expect(json(await call(SEARCH_TOOL, { query: "zebras" })).matches.map((match: { name: string }) => match.name)).toEqual(["zebras_list"]);
    expect(fake.toolsLists).toBe(2);
  });

  it("reads its settings from a private record when mounts share one environment", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    const record = `OMB_REMOTE_MCP_CONFIG_${"a".repeat(64)}`;
    const descriptor = mcpStdioServer(spec(fake.url), { directory: { name: "whop" }, configEnvName: record })!;
    expect(descriptor.args!.slice(1)).toEqual(["--config-env", record]);
    expect(Object.keys(descriptor.env!)).toEqual([record]);
    expect(descriptor.args!.join(" ")).not.toContain("directory-fixture-token");
    start(descriptor);
    await initialize();
    expect((await request("tools/list")).result.tools).toHaveLength(3);
  });

  /** This machine's environment without its own proxy settings. */
  const withoutProxies = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?_proxy|no_proxy|node_use_env_proxy)$/i.test(name)));

  // A throwaway certificate for an https:// fake server, trusted by the
  // proxy child through NODE_EXTRA_CA_CERTS; undefined without openssl.
  const tlsDir = mkdtempSync(join(tmpdir(), "omb-remote-proxy-tls-"));
  const tls = makeTestTls(tlsDir);
  afterAll(() => removeTempDir(tlsDir));

  // The proxy switch is set for https:// servers only (mcp-gate-config.ts):
  // through CONNECT, which works on Node 24 and 26 alike.
  it.skipIf(!tls)("reaches an internet https server through the person's proxy", async () => {
    fake = await startFakeHttpMcp({ tools: catalog, tls });
    const port = Number(new URL(fake.url).port);
    // a CONNECT proxy that knows where the test's "internet" host lives
    const tunnels: string[] = [];
    const forwarded: string[] = [];
    const sockets = new Set<Socket>();
    const proxy = createServer((req, res) => { forwarded.push(req.url ?? ""); res.writeHead(502).end(); });
    proxy.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
      tunnels.push(req.url ?? "");
      sockets.add(client);
      const upstream = connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const via = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const internet = `https://${TEST_TLS_HOST}:${port}/mcp`;
      start(mcpStdioServer(spec(internet), { directory: { name: "whop" }, sourceEnv: { HTTPS_PROXY: via, NODE_EXTRA_CA_CERTS: tls!.certPath } })!, withoutProxies());
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      expect(tunnels.length).toBeGreaterThan(0);
      expect(tunnels.every((target) => target === `${TEST_TLS_HOST}:${port}`)).toBe(true);
      expect(forwarded).toEqual([]);
    } finally {
      for (const socket of sockets) socket.destroy();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("reaches a server on this computer directly, past a proxy that could not", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    // nothing listens here: a request sent to this "proxy" is refused
    const unreachable = "http://127.0.0.1:9";
    // an http:// server: no proxy switch at all, so a direct connection
    for (const sourceEnv of [{ HTTP_PROXY: unreachable }, { HTTP_PROXY: unreachable, NO_PROXY: "corp.internal" }]) {
      start(mcpStdioServer(spec(fake.url), { directory: { name: "whop" }, sourceEnv })!, withoutProxies());
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      const stopped = once(child!, "close"); child!.kill(); await stopped;
    }
    const localhost = fake.url.replace("127.0.0.1", "localhost");
    start(mcpStdioServer(spec(localhost), { directory: { name: "whop" }, sourceEnv: { HTTPS_PROXY: unreachable, HTTP_PROXY: unreachable } })!, withoutProxies());
    await initialize();
    expect((await request("tools/list")).result.tools).toHaveLength(3);
  });

  // An https:// server switches the proxy on: loopback stays direct only
  // through the NO_PROXY entries mcpStdioServer adds.
  it.skipIf(!tls)("reaches an https server on this computer directly, past a proxy that could not", async () => {
    fake = await startFakeHttpMcp({ tools: catalog, tls });
    const unreachable = "http://127.0.0.1:9";
    const trust = { NODE_EXTRA_CA_CERTS: tls!.certPath };
    for (const [url, sourceEnv] of [
      [fake.url, { HTTPS_PROXY: unreachable }],
      [fake.url, { HTTPS_PROXY: unreachable, NO_PROXY: "corp.internal" }],
      [fake.url.replace("127.0.0.1", "localhost"), { HTTPS_PROXY: unreachable, HTTP_PROXY: unreachable }],
    ] as const) {
      const descriptor = mcpStdioServer(spec(url), { directory: { name: "whop" }, sourceEnv: { ...sourceEnv, ...trust } })!;
      expect(descriptor.env!.NODE_USE_ENV_PROXY).toBe("1");
      start(descriptor, withoutProxies());
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      const stopped = once(child!, "close"); child!.kill(); await stopped;
    }
  });

  // Node's env-proxy matcher compares an IPv6 host in its bracketed form,
  // so only the "[::1]" NO_PROXY entry keeps https://[::1] off the proxy.
  it.skipIf(!tls)("reaches an https server on IPv6 loopback directly, never through the proxy", async (ctx) => {
    try {
      fake = await startFakeHttpMcp({ tools: catalog, tls, host: "::1" });
    } catch {
      return ctx.skip(); // no IPv6 loopback on this machine
    }
    // a proxy that records what it is asked and answers nothing
    const tunnels: string[] = [];
    const proxy = createServer((req, res) => { tunnels.push(`${req.method} ${req.url}`); res.writeHead(502).end(); });
    proxy.on("connect", (req: IncomingMessage, client: Socket) => { tunnels.push(`CONNECT ${req.url}`); client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const via = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const descriptor = mcpStdioServer(spec(fake.url), { directory: { name: "whop" }, sourceEnv: { HTTPS_PROXY: via, NODE_EXTRA_CA_CERTS: tls!.certPath } })!;
      expect(descriptor.env!.NODE_USE_ENV_PROXY).toBe("1");
      start(descriptor, withoutProxies());
      const answer = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
      expect(tunnels).toEqual([]);
      // Node 24's fetch checks an https://[::1] certificate against "::1."
      // and refuses it, proxy or none; Node 26 connects.
      if (Number(process.versions.node.split(".")[0]) >= 26) expect(answer.result.serverInfo.name).toBe("fake-http-mcp");
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  // The gate and some engines hand the proxy child this process's whole
  // environment: a switch set here must not send an http:// server through
  // the proxy, where Node 24 fails it and Node 26 forwards it.
  it("reaches an http server directly when this process turns the proxy switch on", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    const unreachable = "http://127.0.0.1:9";
    const inherited = { ...withoutProxies(), NODE_USE_ENV_PROXY: "1", HTTP_PROXY: unreachable, HTTPS_PROXY: unreachable };
    for (const sourceEnv of [inherited, { NODE_USE_ENV_PROXY: "1" }]) {
      const descriptor = mcpStdioServer(spec(fake.url), { directory: { name: "whop" }, sourceEnv })!;
      expect(descriptor.env!.NODE_USE_ENV_PROXY).toBe("0");
      start(descriptor, inherited);
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      const stopped = once(child!, "close"); child!.kill(); await stopped;
    }
  });

  it("runs from the shipped bundle, schema checks included", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    const scratch = mkdtempSync(join(tmpdir(), "omb-directory-bundle-"));
    try {
      await build({ entryPoints: [join(SERVER_ROOT, "mcp-remote-proxy.ts")], outdir: scratch, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
      const descriptor = mcpStdioServer(spec(fake.url), { directory: { name: "whop" } })!;
      start({ ...descriptor, args: [join(scratch, "mcp-remote-proxy.js")] });
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      const misfit = (await call(CALL_TOOL, { name: "payments_list", arguments: { first: "ten" } })).result;
      expect(JSON.parse(misfit.content[0].text).problems).toContain("first: must be integer");
      expect(fake.calls).toEqual([]);
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("refuses to start on tool directory settings it cannot read", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    const descriptor = mcpStdioServer(spec(fake.url))!;
    start({ ...descriptor, env: { ...descriptor.env, OMB_REMOTE_MCP_DIRECTORY: JSON.stringify({ name: "whop", toolScope: { allow: null } }) } });
    const [code] = await once(child!, "close");
    expect(code).toBe(1);
    expect(fake.seenHeaders).toEqual([]);
  });
});
