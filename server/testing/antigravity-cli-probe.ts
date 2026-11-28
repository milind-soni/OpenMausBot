// Measures which of a session's MCP tools Google's native Antigravity CLI shows its model: probe MCP servers over HTTP
// whose tools have chosen definition sizes, one `antigravity acp` process in an empty profile, a made-up Gemini API key,
// and a loopback stand-in for the model whose first request names every tool the model is shown. 1.5.18 writes a
// definition file (<gemini-dir>/antigravity-acp/mcp/<server>/<tool>.json) for every tool, the ones it leaves out of the
// model's request included, so the files alone do not say what was kept.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { definitionBytes, type ListedTool } from "../tool-list-budget.ts";

export type ProbeTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** A tool whose definition (as the CLI writes it, see definitionBytes) comes to exactly `bytes`, by padding its
 * description; with `parameters` small string parameters, which the CLI cannot fold away. */
export function toolOfBytes(name: string, bytes: number, parameters = 1): ProbeTool {
  const properties = Object.fromEntries(Array.from({ length: parameters }, (_, index) => [`p${index}`, { type: "string" }]));
  const base: ProbeTool = { name, description: "", inputSchema: { type: "object", properties, required: ["p0"].filter(() => parameters > 0) } };
  const pad = bytes - definitionBytes(base);
  if (pad < 0) throw new Error(`a tool named ${name} cannot be as small as ${bytes} bytes`);
  const description = "Probe tool padded to a chosen size. ".repeat(Math.ceil(pad / 36) + 1).slice(0, pad);
  return { ...base, description };
}

export interface ProbeServers {
  /** The `session/new` entry for each named server. */
  entries(): Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
  /** The tools/list requests each server answered. */
  listed: Map<string, number>;
  /** Requests that reached the stand-in model endpoint. */
  modelRequests: Array<{ path: string; body: string }>;
  /** The stand-in model endpoint, for GOOGLE_GEMINI_BASE_URL. */
  baseUrl: string;
  close(): Promise<void>;
}

/** One loopback HTTP server answering MCP (JSON responses, no sessions) for every server in `servers`, by path. */
export async function serveProbeMcp(servers: Record<string, readonly ProbeTool[]>): Promise<ProbeServers> {
  const listed = new Map<string, number>();
  const modelRequests: Array<{ path: string; body: string }> = [];
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0]!;
    if (!path.startsWith("/mcp/")) {
      // The model endpoint (GOOGLE_GEMINI_BASE_URL): every request is kept, and answered with an error.
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        modelRequests.push({ path, body });
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 400, message: "probe model", status: "INVALID_ARGUMENT" } }));
      });
      return;
    }
    const name = decodeURIComponent(path.slice("/mcp/".length));
    const tools = servers[name];
    if (request.method !== "POST" || !tools) {
      response.writeHead(request.method === "GET" ? 405 : 404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let message: { id?: unknown; method?: string; params?: { protocolVersion?: string } };
      try { message = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
      if (message.id === undefined || message.id === null) { response.writeHead(202).end(); return; }
      let result: unknown;
      if (message.method === "initialize") {
        result = { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name, version: "1.0.0" } };
      } else if (message.method === "tools/list") {
        listed.set(name, (listed.get(name) ?? 0) + 1);
        result = { tools };
      } else if (message.method === "ping") result = {};
      else if (message.method === "tools/call") result = { content: [{ type: "text", text: "probe" }] };
      else {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    entries: () => Object.keys(servers).map((name) => ({ type: "http" as const, name, url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}`, headers: [] })),
    listed,
    modelRequests,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

export interface ProbeResult {
  /** The CLI's version, from its `initialize` answer. */
  version: string;
  /** What `session/new` answered: "ok", or its error message. */
  session: string;
  /** For each server, the tools it offered: `kept` when the model was shown it (with `prompt`; else when its definition
   * file was written), `written` when the CLI wrote its definition file, with that file's size. 1.5.18 writes a file for
   * every tool, the ones it leaves out of the model's request included. */
  servers: Record<string, Array<{ name: string; bytes: number; kept: boolean; written: boolean; fileBytes?: number; fileName?: string }>>;
  /** Every file name under mcp/, as the CLI wrote it (relative), for path-length checks. */
  files: string[];
  /** Lines of the CLI's stderr and log files that mention MCP, tools or a budget. */
  logLines: string[];
  /** The longest absolute path the CLI wrote under the profile. */
  longestPath: number;
  /** With `prompt`: every function name the CLI declared to the (stand-in) model on the first turn. */
  modelTools?: string[];
  /** With `prompt`: that request's body as the CLI sent it. */
  modelRequest?: string;
}

function declaredNames(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { request?: { tools?: unknown }; tools?: unknown };
    const tools = (parsed.request?.tools ?? parsed.tools) as Array<{ functionDeclarations?: Array<{ name?: string }> }> | undefined;
    return (tools ?? []).flatMap((tool) => (tool.functionDeclarations ?? []).map((declaration) => String(declaration.name)));
  } catch {
    return [...body.matchAll(/"name":"([^"]+)"/gu)].map((match) => match[1]!);
  }
}

function walkFiles(directory: string, prefix = ""): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walkFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]);
}

/** Starts `executable` as `acp` in `profile` (a new, empty folder) with `env` (which must hold a throwaway HOME), opens one
 * session with `servers`, waits `settleMs` for its MCP preload, and reads back which tools it kept. */
export async function probeAntigravityCli(options: {
  executable: string;
  profile: string;
  env: NodeJS.ProcessEnv;
  servers: Record<string, readonly ProbeTool[]>;
  /** Stdio servers mounted as they are (a relay in front of a real server), with the tools each is expected to list. */
  stdio?: Array<{ name: string; command: string; args: string[]; env: Record<string, string>; tools: readonly ProbeTool[] }>;
  settleMs?: number;
  /** Also run one turn against the stand-in model and read which tools it was shown. */
  prompt?: boolean;
}): Promise<ProbeResult> {
  mkdirSync(options.profile, { recursive: true });
  // Apart from the profile: Windows starts no process in a working folder past 260 characters.
  const cwd = mkdtempSync(join(tmpdir(), "agp-cwd-"));
  const mcp = await serveProbeMcp(options.servers);
  const child = spawn(options.executable, ["acp", "--gemini-dir", options.profile, "--app-data-dir", "antigravity-acp"], {
    // A made-up API key and a loopback model endpoint: the CLI opens sessions (and connects their MCP servers) only when
    // it has some sign-in, and this one reaches nobody.
    cwd, env: { ...options.env, GEMINI_API_KEY: "probe-not-a-key", GOOGLE_API_KEY: "", GOOGLE_GEMINI_BASE_URL: mcp.baseUrl }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const stderr: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
  const pending = new Map<number, (message: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.id === "number" && pending.has(message.id) && !message.method) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    } else if (message.method && message.id !== undefined) {
      // A request from the agent (permission, file read): refused, the probe runs no turn.
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "probe" } })}\n`);
    }
  });
  let next = 0;
  let failed: string | undefined;
  const request = (method: string, params: unknown, ms = 60_000) => new Promise<any>((done) => {
    if (failed !== undefined) return done({ error: { message: `the CLI did not start: ${failed}` } });
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); done({ error: { message: `no answer to ${method} in ${ms} ms` } }); }, ms);
    pending.set(id, (message) => { clearTimeout(timer); done(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.on("error", (error) => {
    failed = error.message;
    for (const [id, answer] of pending) { pending.delete(id); answer({ error: { message: `the CLI did not start: ${error.message}` } }); }
  });
  child.stdin.on("error", () => {});
  try {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const version = String(init.result?.agentInfo?.version ?? init.error?.message ?? "unknown");
    await request("authenticate", { methodId: "gemini-api-key" });
    const stdio = (options.stdio ?? []).map(({ name, command, args, env }) => ({ name, command, args, env: Object.entries(env).map(([key, value]) => ({ name: key, value })) }));
    const created = await request("session/new", { cwd, mcpServers: [...mcp.entries(), ...stdio] });
    const session = created.error ? String(created.error.message ?? "error") : "ok";
    await new Promise((done) => setTimeout(done, options.settleMs ?? 3_000));
    let modelTools: string[] | undefined;
    let modelRequest: string | undefined;
    if (options.prompt) {
      const sessionId = created.result?.sessionId;
      const before = mcp.modelRequests.length;
      void request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Say hi." }] }, 30_000);
      for (let waited = 0; waited < 30_000 && !mcp.modelRequests.slice(before).some((entry) => entry.body.includes("functionDeclarations")); waited += 250) {
        await new Promise((done) => setTimeout(done, 250));
      }
      const sent = mcp.modelRequests.slice(before).find((entry) => entry.body.includes("functionDeclarations"));
      modelTools = sent ? declaredNames(sent.body) : [];
      modelRequest = sent?.body;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })}\n`);
    }
    const root = join(options.profile, "antigravity-acp", "mcp");
    const files = walkFiles(root);
    const servers: ProbeResult["servers"] = {};
    const expected = { ...options.servers, ...Object.fromEntries((options.stdio ?? []).map(({ name, tools }) => [name, tools])) };
    for (const [name, tools] of Object.entries(expected)) {
      const folder = (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []).find((entry) => entry.isDirectory() && (entry.name === name || entry.name.endsWith(`_${name}`) || entry.name.startsWith(name)))?.name;
      const written = folder ? readdirSync(join(root, folder)) : [];
      servers[name] = tools.map((tool) => {
        const fileName = written.find((file) => file === `${tool.name}.json` || file.endsWith(`_${tool.name}.json`));
        const shown = modelTools === undefined ? undefined : modelTools.some((declared) => declared === `mcp_${name}_${tool.name}` || declared === `mcp_${name.replace(/[^A-Za-z0-9_]/gu, "_")}_${tool.name}`);
        return {
          name: tool.name, bytes: definitionBytes(tool as ListedTool), kept: shown ?? fileName !== undefined, written: fileName !== undefined,
          ...(fileName ? { fileName: `${folder}/${fileName}`, fileBytes: statSync(join(root, folder!, fileName)).size } : {}),
        };
      });
    }
    const logs = walkFiles(join(options.profile, "antigravity-acp")).filter((file) => /\.(log|txt)$/u.test(file))
      .flatMap((file) => readFileSync(join(options.profile, "antigravity-acp", file), "utf8").split("\n"));
    const logLines = [...stderr, ...logs].filter((line) => /mcp|tool|budget|truncat|preload|deadline/iu.test(line)).slice(-200);
    const longestPath = Math.max(0, ...walkFiles(options.profile).map((file) => join(options.profile, file).length));
    return { version, session, servers, files, logLines, longestPath, ...(modelTools ? { modelTools } : {}), ...(modelRequest ? { modelRequest } : {}) };
  } finally {
    child.stdin.end();
    child.kill();
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
    await mcp.close();
  }
}

/** The tools of `result` the CLI did not keep. */
export function droppedTools(result: ProbeResult): string[] {
  return Object.entries(result.servers).flatMap(([server, tools]) => tools.filter((tool) => !tool.kept).map((tool) => `${server}/${tool.name}`));
}
