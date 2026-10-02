import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { gateServer } from "./mcp-gate-config.ts";
import { SERVER_ROOT } from "./proxy-paths.ts";
import { removeTempDir } from "./testing/cleanup.ts";

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
