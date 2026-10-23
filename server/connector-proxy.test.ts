import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

import { createPageSchema } from "./testing/oversized-tool-schema.ts";
import { schemaBytes, TOOL_SCHEMA_PROFILE_ENV } from "./tool-schema-profile.ts";

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

  it("carries a bot's auth_config_id for a toolkit to the card request, and refuses a malformed one without a card", async () => {
    const received: any[] = [];
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({ OMB_HARNESS_URL: harness, OMB_CONNECTOR_TOKEN: "bridge-secret", OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1" });
    const manage = async (id: number, args: Record<string, unknown>) => {
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: args } })}\n`);
      return nextJson(lines);
    };

    expect((await manage(1, { toolkits: [{ name: "Xero", action: "add", auth_config_id: "ac_xero1234" }, { name: "slack" }] })).result.isError).toBeUndefined();
    expect((await manage(2, { toolkits: ["buffer"], auth_config_override: " ac_buffer99 " })).result.isError).toBeUndefined();
    expect((await manage(3, { toolkits: ["xero", "buffer"], auth_config_override: { XERO: "ac_xero1234" } })).result.isError).toBeUndefined();
    expect(received.map((body) => body.items)).toEqual([
      [{ slug: "xero", authConfigId: "ac_xero1234" }, { slug: "slack" }],
      [{ slug: "buffer", authConfigId: "ac_buffer99" }],
      [{ slug: "xero", authConfigId: "ac_xero1234" }, { slug: "buffer" }],
    ]);

    for (const [id, args] of [
      [4, { toolkits: [{ name: "xero", auth_config_id: "xero-app" }] }],
      [5, { toolkits: ["xero", "buffer"], auth_config_id: "ac_xero1234" }],
      [6, { toolkits: [{ name: "xero", auth_config_id: 42 }] }],
    ] as const) {
      const refused = await manage(id, args);
      expect(refused.result.isError).toBe(true);
      expect(refused.result.content[0].text).toMatch(/showed no card: auth_config_id must be a Composio auth config id/);
    }
    expect(received).toHaveLength(3);
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

  it("fits a connected app's tools to the engine's provider profile", async () => {
    const tools = [{ name: "COMPOSIO_SEARCH_TOOLS", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "DOCS_CREATE_PAGE", description: "Create a page.", inputSchema: createPageSchema() }];
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { tools } }));
    });
    const lines = start({ OMB_CONNECTOR_UPSTREAM_URL: upstream, [TOOL_SCHEMA_PROFILE_ENV]: "moonshot" });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);
    const [search, page] = (await nextJson(lines)).result.tools;
    expect(search).toEqual(tools[0]);
    expect(schemaBytes(page.inputSchema)).toBeLessThanOrEqual(12_000);
    expect(page.description).toContain("OpenMausBot shortened this tool's parameters to fit Kimi's size limit");
  });

  it("tells the bot to reconnect an app whose sign-in ended, and leaves successful results alone", async () => {
    const answers = [
      {
        content: [{ type: "text", text: JSON.stringify({
          successful: false,
          data: { results: [{ tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: false, error: "USER_NOT_LOGGED_IN: connect the account" } }] },
        }) }],
        isError: true,
      },
      { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { subject: "HTTP 401 explained" } }) }] },
    ];
    const upstream = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const { id } = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result: answers.shift() }));
      });
    });
    const lines = start({ OMB_CONNECTOR_UPSTREAM_URL: upstream });
    const call = (id: number) => child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] } },
    })}\n`);
    call(31);
    const signedOut = await nextJson(lines);
    expect(signedOut.result.content).toHaveLength(2);
    expect(signedOut.result.content[1].text).toMatch(/gmail is signed out/);
    expect(signedOut.result.content[1].text).toContain('Call COMPOSIO_MANAGE_CONNECTIONS with toolkits ["gmail"]');
    call(32);
    const fine = await nextJson(lines);
    expect(fine.result.content).toHaveLength(1);
  });

  it("asks for tools/list once more before giving up, so one failed listing does not empty the session", async () => {
    let listings = 0;
    const upstream = await listen((request, response) => {
      request.resume();
      request.on("end", () => {
        listings += 1;
        if (listings === 1) {
          response.writeHead(503, { "content-type": "application/json" });
          return response.end(JSON.stringify({ error: "connected apps are busy" }));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 41, result: { tools: [{ name: "COMPOSIO_MANAGE_CONNECTIONS" }] } }));
      });
    });
    const lines = start({ OMB_CONNECTOR_UPSTREAM_URL: upstream, OMB_CONNECTOR_ALLOWED_TOOLS: "{}" });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(listings).toBe(2);
    expect(reply.result.tools).toEqual([{ name: "COMPOSIO_MANAGE_CONNECTIONS" }]);
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

  it("filters a JSON tools/list response down to the bot's grants", async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        result: {
          tools: [
            { name: "COMPOSIO_SEARCH_TOOLS" },
            { name: "COMPOSIO_GET_TOOL_SCHEMAS" },
            { name: "COMPOSIO_MULTI_EXECUTE_TOOL" },
            { name: "GMAIL_SEND_EMAIL" },
            { name: "GMAIL_GET_EMAIL" },
            { name: "GMAIL_MANAGE_CONNECTIONS" },
            { name: "SLACK_POST_MESSAGE" },
            { name: "SLACK_MANAGE_CONNECTIONS" },
          ],
        },
      }));
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_ALLOWED_TOOLS: JSON.stringify({ gmail: { tools: ["GMAIL_SEND_EMAIL"] } }),
    });
    child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/list", params: {} }) + "\n");
    const reply = await nextJson(lines);
    expect(reply.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "COMPOSIO_SEARCH_TOOLS",
      "COMPOSIO_GET_TOOL_SCHEMAS",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      "GMAIL_SEND_EMAIL",
      "GMAIL_MANAGE_CONNECTIONS",
    ]);
  });

  it("filters an SSE tools/list response the same as JSON", async () => {
    const frame = {
      jsonrpc: "2.0",
      id: 22,
      result: {
        tools: [
          { name: "COMPOSIO_MULTI_EXECUTE_TOOL" },
          { name: "NOTION_CREATE_PAGE" },
          { name: "NOTION_WAIT_FOR_CONNECTIONS" },
          { name: "GMAIL_SEND_EMAIL" },
        ],
      },
    };
    const upstream = await listen((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: " + JSON.stringify(frame) + "\n\n");
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_ALLOWED_TOOLS: JSON.stringify({ notion: { tools: ["NOTION_CREATE_PAGE"] } }),
    });
    child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 22, method: "tools/list", params: {} }) + "\n");
    const reply = await nextJson(lines);
    expect(reply.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      "NOTION_CREATE_PAGE",
      "NOTION_WAIT_FOR_CONNECTIONS",
    ]);
  });

  it("relays the unfiltered list with no allowlist env or an unreadable one", async () => {
    for (const allowlist of [undefined, "{not json"]) {
      const upstream = await listen((request, response) => {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: 23,
          result: { tools: [{ name: "GMAIL_SEND_EMAIL" }, { name: "SLACK_POST_MESSAGE" }] },
        }));
      });
      const lines = start({
        OMB_CONNECTOR_UPSTREAM_URL: upstream,
        ...(allowlist === undefined ? {} : { OMB_CONNECTOR_ALLOWED_TOOLS: allowlist }),
      });
      child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 23, method: "tools/list", params: {} }) + "\n");
      const reply = await nextJson(lines);
      expect(reply.result.tools).toHaveLength(2);
      child!.kill("SIGKILL");
      child = null;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });
});
