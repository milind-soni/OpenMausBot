import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-proxy.ts");
let child: ChildProcessWithoutNullStreams | null = null;
let server: Server | null = null;

async function listen(handler: RequestListener) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function start(env: Record<string, string>) {
  child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return readline.createInterface({ input: child.stdout });
}

function nextJson(lines: readline.Interface) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    lines.once("line", (line) => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
  });
}

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("connector MCP bridge", () => {
  it("turns agent connection requests into authenticated chat-card requests", async () => {
    let received: any = null;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = { authorization: request.headers.authorization, body: JSON.parse(body) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_CONNECTOR_TOKEN: "bridge-secret",
      // A simultaneously mounted agents proxy may define this different
      // value in Codex's flattened child environment.
      OMB_COMMS_TOKEN: "agents-secret",
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: ["GMAIL"] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(7);
    expect(reply.result.content[0].text).toMatch(/secure connection card/i);
    expect(received.authorization).toBe("Bearer bridge-secret");
    expect(received.body).toMatchObject({ botId: "bot-1", threadId: "thread-1", items: [{ slug: "gmail" }] });
    expect(received.body.resumeKey).toMatch(/^[\w-]{8,100}$/);
  });

  it("carries an account alias when the agent asks for a second account", async () => {
    let received: any = null;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = { authorization: request.headers.authorization, body: JSON.parse(body) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_CONNECTOR_TOKEN: "bridge-secret",
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "COMPOSIO_MANAGE_CONNECTIONS",
        arguments: {
          toolkits: [
            { toolkit: "googledrive", alias: "work-devhouse" },
            { name: "LINEAR", account: "personal" },
            { toolkit: "googledrive", alias: "personal" },
            { toolkit: "GOOGLEDRIVE", alias: " Work-Devhouse " },
          ],
        },
      },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(8);
    expect(reply.result.content[0].text).toMatch(/secure connection card for googledrive \(work-devhouse\), linear \(personal\)/i);
    expect(received.authorization).toBe("Bearer bridge-secret");
    expect(received.body).toMatchObject({
      botId: "bot-1",
      threadId: "thread-1",
      items: [
        { slug: "googledrive", alias: "work-devhouse" },
        { slug: "linear", alias: "personal" },
        { slug: "googledrive", alias: "personal" },
      ],
    });
  });

  it("answers initialize locally so a missing or failing upstream cannot fail the MCP handshake", async () => {
    const lines = start({});
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-connectors", version: "1" },
      },
    });
    expect(reply.result).not.toHaveProperty("isError");
    expect(reply.result).not.toHaveProperty("content");
  });

  it("answers initialize after a bounded wait when the upstream stalls", async () => {
    let sawInitialize!: () => void;
    const received = new Promise<void>((resolve) => { sawInitialize = resolve; });
    const upstream = await listen((request) => {
      request.resume();
      request.on("end", sawInitialize);
      // Deliberately never respond. The proxy must abort this request and
      // return its local capability result instead of hanging OpenCode.
    });
    const lines = start({ OMB_CONNECTOR_UPSTREAM_URL: upstream });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })}\n`);

    await received;
    const reply = await nextJson(lines);
    expect(reply).toMatchObject({
      id: 11,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
      },
    });
  });

  it("still opens the upstream MCP session on initialize without echoing secrets", async () => {
    let upstreamAuthorization = "";
    let upstreamBody: any = null;
    const methods: string[] = [];
    const sessionHeaders: string[] = [];
    let sawInitialized!: () => void;
    const initialized = new Promise<void>((resolve) => { sawInitialized = resolve; });
    const upstream = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        upstreamAuthorization = String(request.headers.authorization ?? "");
        upstreamBody = JSON.parse(body);
        methods.push(String(upstreamBody.method ?? ""));
        sessionHeaders.push(String(request.headers["mcp-session-id"] ?? ""));
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "transport-1" });
        response.end(upstreamBody.id === undefined
          ? ""
          : JSON.stringify({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } }));
        if (upstreamBody.method === "notifications/initialized") sawInitialized();
      });
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer upstream-secret" }),
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    const reply = await nextJson(lines);
    expect(reply.result.protocolVersion).toBe("2024-11-05");
    expect(reply.result.serverInfo).toEqual({ name: "openmausbot-connectors", version: "1" });
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(upstreamBody).toMatchObject({ method: "initialize" });
    expect(JSON.stringify(reply)).not.toContain("upstream-secret");

    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    await initialized;
    expect(methods).toEqual(["initialize", "notifications/initialized"]);
    expect(sessionHeaders).toEqual(["", "transport-1"]);
  });

  it("relays tools/list without exposing upstream headers on stdout", async () => {
    let upstreamAuthorization = "";
    const upstream = await listen((request, response) => {
      upstreamAuthorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "transport-1" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }] },
      }));
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer upstream-secret" }),
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }] },
    });
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(JSON.stringify(reply)).not.toContain("upstream-secret");
  });

  it("returns a JSON-RPC error, not a tools result, when a non-call relay fails", async () => {
    const lines = start({});
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "connected apps are unavailable" },
    });
  });
});
