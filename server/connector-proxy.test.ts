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

function nextJson(lines: readline.Interface, timeoutMs = 1_000) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for JSON-RPC response")), timeoutMs);
    lines.once("line", (line) => {
      clearTimeout(timer);
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
      OMB_COMMS_TOKEN: "bridge-secret",
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
    expect(received.body).toMatchObject({ botId: "bot-1", threadId: "thread-1", slugs: ["gmail"] });
    expect(received.body.resumeKey).toMatch(/^[\w-]{8,100}$/);
  });

  it("relays ordinary MCP JSON-RPC without exposing upstream headers on stdout", async () => {
    let upstreamAuthorization = "";
    const upstream = await listen((request, response) => {
      upstreamAuthorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "transport-1" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } }));
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer upstream-secret" }),
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } });
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(JSON.stringify(reply)).not.toContain("upstream-secret");
  });

  it("rejects malformed stdin JSON-RPC values without dereferencing them", async () => {
    const lines = start({});
    for (const value of [null, 42, []]) {
      child!.stdin.write(`${JSON.stringify(value)}\n`);
      const reply = await nextJson(lines);
      expect(reply).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }
  });

  it("does not relay malformed or null upstream SSE frames as valid responses", async () => {
    const upstream = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const id = JSON.parse(body).id;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = id === 10 ? "null" : id === 11 ? JSON.stringify({ foo: "bar" }) : JSON.stringify("not-json-rpc");
        response.end(`data: ${frame}\n\n`);
      });
    });
    const lines = start({ OMB_CONNECTOR_UPSTREAM_URL: upstream });
    for (const id of [10, 11, 12]) {
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: {} })}\n`);
      const reply = await nextJson(lines);
      expect(reply.id).toBe(id);
      expect(reply.result?.isError).toBe(true);
    }
    expect(child!.exitCode).toBeNull();
  });

  it("blocks connector writes for a read-only Capture bot before upstream", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(500);
      response.end();
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_POLICY: "read-only",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "GMAIL_SEND_EMAIL", arguments: { to: "x@example.com" } },
    })}\n`);

    const reply = await nextJson(lines);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/blocked non-read tool/i);
    expect(upstreamCalls).toBe(0);
  });

  it("filters non-read tools from a read-only Capture bot's tool list", async () => {
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: {
          tools: [
            { name: "GMAIL_LIST_EMAILS" },
            { name: "GOOGLECALENDAR_GET_EVENTS" },
            { name: "COMPOSIO_MULTI_EXECUTE_TOOL" },
            { name: "GMAIL_SEND_EMAIL" },
            { name: "GOOGLEDRIVE_DELETE_FILE" },
            { name: "MYSTERY_ACTION" },
          ],
        },
      }));
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_POLICY: "read-only",
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);

    const reply = await nextJson(lines);
    expect(reply.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "GMAIL_LIST_EMAILS",
      "GOOGLECALENDAR_GET_EVENTS",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
    ]);
  });

  it("allows the guarded Composio executor only when every nested tool is read-only", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 5, result: { content: [] } }));
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_POLICY: "read-only",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: {
          tools: [
            { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} },
            { tool_slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: {} },
          ],
          sync_response_to_workbench: false,
        },
      },
    })}\n`);

    const reply = await nextJson(lines);
    expect(reply.id).toBe(5);
    expect(reply.result.content).toEqual([]);
    expect(upstreamCalls).toBe(1);
  });

  it("blocks a guarded Composio batch when any nested tool writes", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(500);
      response.end();
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_POLICY: "read-only",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: {
          tools: [
            { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} },
            { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "x@example.com" } },
          ],
          sync_response_to_workbench: false,
        },
      },
    })}\n`);

    const reply = await nextJson(lines);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/blocked non-read tool/i);
    expect(upstreamCalls).toBe(0);
  });

  it("preflights an exact Gmail draft before relaying it", async () => {
    let policyBody: any = null;
    let resultBody: { proposalId: string; workId: string } | null = null;
    let upstreamCalls = 0;
    const harness = await listen((request, response) => {
      if (request.url === "/upstream") {
        upstreamCalls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: "draft-1" }] } }));
        return;
      }
      if (request.url === "/api/internal/action-policy/result") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          resultBody = JSON.parse(body);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        policyBody = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ decision: "allow", proposalId: "proposal-1", workId: "work-1" }));
      });
    });
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_CONNECTOR_UPSTREAM_URL: `${harness}/upstream`,
      OMB_COMMS_TOKEN: "bridge-secret",
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: { tools: [{ tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", account: "ca_personal", arguments: { body: "Hi" } }] },
      },
    })}\n`);

    const reply = await nextJson(lines);
    expect(reply.result.content[0].text).toBe("draft-1");
    expect(upstreamCalls).toBe(1);
    expect(policyBody).toMatchObject({
      botId: "bot-1",
      threadId: "thread-1",
      name: "COMPOSIO_MULTI_EXECUTE_TOOL",
      identity: "Personal",
      provider: "gmail",
    });
    expect(resultBody).toMatchObject({ proposalId: "proposal-1", workId: "work-1" });
  });
});
