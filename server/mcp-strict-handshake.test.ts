// A URL MCP server that deserializes initialize strictly (a Voluum
// server: "Unrecognized field 'schemaValidation'") against the
// handshakes the engines really send. The payloads below were captured from
// the real binaries (Oct 8 2026) talking to testing/fake-http-mcp-server.ts
// with `strictInitialize`; OMB's own client and its stdio proxy send the
// minimal handshake and pass.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

import { mcpStdioServer, type StdioServer } from "./mcp-gate-config.ts";
import { RemoteMcpClient } from "./mcp-http.ts";
import { startFakeHttpMcp, unrecognizedField, STRICT_INITIALIZE_SCHEMAS, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

/** codex-cli 0.160.1 (also 0.144.4, 0.149.0) mounting a URL server natively */
const CODEX = { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.160.1" } };
/** Claude Code 2.1.292, after its server/discover probe */
const CLAUDE = {
  protocolVersion: "2025-11-25",
  capabilities: { roots: { listChanged: true }, elicitation: { form: {}, url: {} } },
  clientInfo: { name: "claude-code", title: "Claude Code", version: "2.1.292", description: "Anthropic's agentic coding tool", websiteUrl: "https://claude.com/claude-code" },
};
/** grok 1.0.25 (`grok mcp doctor`; a session needs a grok.com sign-in) */
const GROK = { protocolVersion: "2025-11-25", capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }, clientInfo: { name: "grok-shell-voluum", version: "1.0.25" } };
/** rmcp's FormElicitationCapability with schema validation turned on: the
 * field a Voluum server named */
const SCHEMA_VALIDATION = { ...CODEX, capabilities: { elicitation: { form: { schemaValidation: true }, url: {} } } };

const TOOLS = [{ name: "report", inputSchema: { type: "object" } }, { name: "campaigns", inputSchema: { type: "object" } }];

async function post(url: string, params: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params }),
  });
  return { status: response.status, body: await response.json() as { result?: unknown; error?: { message: string } } };
}

type Reply = { id?: unknown; result?: any; error?: { code: number; message: string } };

/** This test process's environment without any proxy setting of its own. */
function withoutProxies(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "NODE_USE_ENV_PROXY"]) delete env[name];
  return env;
}

/** Every AbortSignal.timeout in the proxy fifty times shorter, so its two
 * minutes take 2.4 s here and a three-second call stands for 150 s. */
const FAST_CLOCK = ["--import", `data:text/javascript,${encodeURIComponent("const t = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = (ms) => t(ms / 50);")}`];

describe("strict initialize fixture", () => {
  let fake: FakeHttpMcp | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let forwarder: Server | undefined;
  /** Start the proxy `descriptor` names, the way an engine does. */
  const startProxy = (descriptor: StdioServer, flags: string[] = [], env: NodeJS.ProcessEnv = process.env) => {
    child = spawn(descriptor.command, ["--experimental-strip-types", "--no-warnings", ...flags, ...descriptor.args!], { stdio: "pipe", env: { ...env, ...descriptor.env } });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    return async (id: number, method: string, params?: unknown): Promise<Reply> => {
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      return JSON.parse((await lines.next()).value as string) as Reply;
    };
  };
  afterEach(async () => {
    if (forwarder) {
      forwarder.closeAllConnections();
      await new Promise<void>((resolve) => forwarder!.close(() => resolve()));
      forwarder = undefined;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    child = undefined;
    await fake?.close(); fake = undefined;
  });

  it("names the first unknown field of each engine's handshake", () => {
    const base = STRICT_INITIALIZE_SCHEMAS["2025-06-18"];
    const newer = STRICT_INITIALIZE_SCHEMAS["2025-11-25"];
    expect(unrecognizedField(CODEX, base)).toBe("capabilities.elicitation.form");
    expect(unrecognizedField(CLAUDE, base)).toBe("capabilities.elicitation.form");
    expect(unrecognizedField(GROK, base)).toBe("capabilities.extensions");
    expect(unrecognizedField(CODEX, newer)).toBeUndefined();
    expect(unrecognizedField(CLAUDE, newer)).toBeUndefined();
    expect(unrecognizedField(GROK, newer)).toBe("capabilities.extensions");
    expect(unrecognizedField(SCHEMA_VALIDATION, newer)).toBe("capabilities.elicitation.form.schemaValidation");
  });

  it("refuses an unknown field the way a Jackson-based server does", async () => {
    fake = await startFakeHttpMcp({ strictInitialize: "http-400", strictSchema: "2025-11-25", tools: TOOLS });
    const refused = await post(fake.url, SCHEMA_VALIDATION);
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message).toContain("Unrecognized field 'schemaValidation'");
    const accepted = await post(fake.url, CODEX);
    expect(accepted.status).toBe(200);
    expect(accepted.body.result).toBeDefined();
    expect(fake.initializes).toEqual([SCHEMA_VALIDATION, CODEX]);
  });

  it("accepts OMB's own client, which sends the minimal handshake", async () => {
    fake = await startFakeHttpMcp({ strictInitialize: "http-400", tools: TOOLS });
    const client = new RemoteMcpClient({ type: "http", url: fake.url, headers: {} });
    await client.initialize("OpenMausBot", AbortSignal.timeout(5_000));
    const listed = await client.request("tools/list", {}, AbortSignal.timeout(5_000)) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(["report", "campaigns"]);
    await client.close();
    expect(fake.initializes).toEqual([{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot", version: "1" } }]);
  });

  it.each([
    ["Codex", CODEX],
    ["Claude Code", CLAUDE],
    ["Grok", GROK],
    ["schemaValidation", SCHEMA_VALIDATION],
  ])("serves %s's handshake through OMB's stdio proxy, forwarding none of its fields", async (_name, handshake) => {
    fake = await startFakeHttpMcp({ strictInitialize: "http-400", tools: TOOLS });
    const descriptor = mcpStdioServer({ type: "http", url: fake.url, headers: {} })!;
    child = spawn(descriptor.command, ["--experimental-strip-types", "--no-warnings", ...descriptor.args!], { stdio: "pipe", env: { ...process.env, ...descriptor.env } });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const ask = async (id: number, method: string, params?: unknown) => {
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      return JSON.parse((await lines.next()).value as string) as { result?: any; error?: unknown };
    };
    // the engine's own handshake would be refused upstream; the proxy's is not
    expect((await ask(1, "initialize", handshake)).result.serverInfo.name).toBe("fake-http-mcp");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    expect((await ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["report", "campaigns"]);
    expect(fake.initializes).toEqual([{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot tool proxy", version: "1" } }]);
  });

  // The proxy cannot tell an OpenMausBot sign-in from a key typed into a
  // header: both arrive as headers. So a 401 names both ways out, and first
  // the one that needs nobody: a sign-in that ran out mid-turn is refreshed
  // when the next message starts.
  it.each([
    ["a sign-in token", { Authorization: "Bearer expired-token" }],
    ["an API key header", { "x-api-key": "rotated-api-key-0001" }],
  ])("tells the engine what to do when the server refuses %s, with nothing remote", async (_name, headers) => {
    fake = await startFakeHttpMcp({ tools: TOOLS, requireHeader: { name: "x-api-key", value: "current-api-key-0002" } });
    const ask = startProxy(mcpStdioServer({ type: "http", url: fake.url, headers })!);
    const message = (await ask(1, "initialize", CODEX)).error?.message;
    expect(message).toBe("This MCP server refused its credentials (HTTP 401). If it uses a sign-in, send the message again: "
      + "OpenMausBot refreshes sign-ins when a message starts. If it still fails, open Plugins → MCP servers and sign in to it again, "
      + "or check its header values.");
    expect(message).not.toContain(fake.url);
    // not Codex's own sign-in: codexSignInRefused reads "please sign in again"
    expect(message).not.toMatch(/please (?:log out and )?sign in again/i);
  });

  // A strict server reports a bad argument as a JSON-RPC error (MCP
  // 2025-06-18): the model needs its code and words to fix the call, but
  // never the server's address or a header value echoed in them.
  it("relays a server's own error for a call with its code, address and header values removed", async () => {
    const key = "voluum-access-key-7f3a9c";
    let url = "";
    fake = await startFakeHttpMcp({
      tools: TOOLS,
      requireHeader: { name: "x-api-key", value: key },
      callError: (params) => {
        const args = (params as { arguments?: { campaignId?: string } }).arguments ?? {};
        if (!args.campaignId) return { code: -32602, message: "bad arg" };
        if (args.campaignId === "echo") return { code: -32000, message: `Campaign echo not found for key ${key} at ${url}?token=${key}` };
        return undefined;
      },
    });
    url = fake.url;
    const ask = startProxy(mcpStdioServer({ type: "http", url: fake.url, headers: { "x-api-key": key } }, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" } })!);
    await ask(1, "initialize", CODEX);
    expect((await ask(2, "tools/call", { name: "report", arguments: {} })).error).toEqual({ code: -32602, message: "bad arg" });
    const echoed = (await ask(3, "tools/call", { name: "report", arguments: { campaignId: "echo" } })).error!;
    expect(echoed.code).toBe(-32000);
    expect(echoed.message).toContain("Campaign echo not found");
    expect(echoed.message).not.toContain(key);
    expect(echoed.message).not.toContain(fake.url);
    expect((await ask(4, "tools/call", { name: "report", arguments: { campaignId: "c-1" } })).result.content[0].text).toBe("remote execution recorded");
  });

  // An ACP agent that connected to a URL server by itself waited as long as
  // its own MCP timeout (Gemini CLI, Qwen Code: ten minutes). Through the
  // proxy a long call must not be cut at the proxy's old two minutes; only
  // the tool directory keeps them. The clock runs fifty times fast here.
  it("lets a long call finish through an ACP mount; only the tool directory keeps its two minutes", async () => {
    fake = await startFakeHttpMcp({ tools: TOOLS, callDelayMs: 3_000 });
    const acp = startProxy(mcpStdioServer({ type: "http", url: fake.url, headers: {} }, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" } })!, FAST_CLOCK);
    await acp(1, "initialize", CODEX);
    expect((await acp(2, "tools/call", { name: "report", arguments: {} })).result.content[0].text).toBe("remote execution recorded");
    const stopped = once(child!, "close"); child!.kill(); await stopped;
    const searched = startProxy(mcpStdioServer({ type: "http", url: fake.url, headers: {} }, { directory: { name: "voluum" } })!, FAST_CLOCK);
    await searched(1, "initialize", CODEX);
    expect((await searched(2, "tools/call", { name: "report", arguments: {} })).error).toEqual({ code: -32800, message: "MCP request cancelled" });
  }, 20_000);

  // An internal http:// server reachable only through the person's
  // HTTP_PROXY: an engine's own client went through it, so the proxy must too
  // (in absolute form; Node's env-proxy switch stays off for http://).
  it("reaches a plain http server through HTTP_PROXY, never directly", async () => {
    fake = await startFakeHttpMcp({ tools: TOOLS });
    const upstream = new URL(fake.url);
    const seen: string[] = [];
    forwarder = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const target = new URL(req.url ?? "");
      if (target.hostname !== "mcp.corp.internal.invalid") { res.writeHead(502).end(); return; }
      const forwarded = httpRequest({ host: upstream.hostname, port: upstream.port, method: req.method, path: target.pathname, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      forwarded.on("error", () => res.destroy());
      req.pipe(forwarded);
    });
    await new Promise<void>((resolve) => forwarder!.listen(0, "127.0.0.1", resolve));
    const via = `http://127.0.0.1:${(forwarder.address() as AddressInfo).port}`;
    const internal = "http://mcp.corp.internal.invalid/mcp";
    const descriptor = mcpStdioServer({ type: "http", url: internal, headers: {} }, { sourceEnv: { HTTP_PROXY: via, http_proxy: via, NO_PROXY: "corp.example" } })!;
    expect(descriptor.env!.NODE_USE_ENV_PROXY).toBe("0");
    const ask = startProxy(descriptor, [], withoutProxies());
    expect((await ask(1, "initialize", CODEX)).result.serverInfo.name).toBe("fake-http-mcp");
    expect((await ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["report", "campaigns"]);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((line) => line.endsWith(` ${internal}`))).toBe(true);
  });
});
