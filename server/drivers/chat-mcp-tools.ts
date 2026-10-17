  import { createHash } from "node:crypto";
import type { ValidateFunction } from "ajv";
import { stripControlPlaneEnv } from "../config.ts";
import type { SendTurnInput } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { bridgedCallTarget, unbridgedServer } from "./agents-bridge.ts";
import { chatImage, type ChatImagePart } from "./chat-images.ts";
import { CALL_TOOL, DESCRIBE_TOOL, LISTED_TOOLS_MAX, SEARCH_TOOL, ToolDirectory, directoryCallTarget, isDirectoryTool, type CatalogTool } from "../mcp-directory.ts";
import { mcpStdioServer } from "../mcp-gate-config.ts";
import { REMOTE_MCP_STARTUP_MS, remoteMcpSpec } from "../mcp-http.ts";
import { compileToolSchema } from "../mcp-schema-validator.ts";
import { CATALOG_FINGERPRINT_META, fingerprintCatalog } from "../mcp-catalog-fingerprint.ts";
import { allowsTool, canUseMcpServer, parseToolScope, type ToolScope } from "../../shared/tool-scope.ts";

export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ChatToolResult { text: string; ok: boolean; images?: ChatImagePart[] }
/** How a call is shown and granted. A grant names the exact tool on the server as launched; the
 * person's own computer never gets a session-wide one. */
export interface ChatToolCallView { title: string; input: Record<string, unknown>; ask: boolean; grant?: string }
/** A dispatched operation may already have taken effect: never retry it through a new round. */
export class ChatToolSessionError extends Error {}
export interface SkippedChatMcpServer { server: string; reason: string }
export interface ChatToolSession {
  definitions: ChatToolDefinition[];
  skipped: SkippedChatMcpServer[];
  /** Host-only identity of the authorized original catalogs, including hidden definitions. */
  readonly catalogFingerprint?: string;
  validate(name: string, args: unknown): void;
  view(name: string, args: Record<string, unknown>): ChatToolCallView;
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatToolResult>;
  close(): Promise<void>;
}

type Server = { command: string; args: string[]; env: Record<string, string> };
type RegisteredTool = { client: ChatMcpClient; server: string; launch: string; builtInBrowser: boolean; agents: boolean; hostComputer: boolean; name: string; schema: ValidateFunction; searched: boolean };
function chatToolName(server: string, tool: string): string {
  return `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "mcp_tool";
}
const STARTUP_MS = 8_000;
 const DEFAULT_CALL_MS = 10 * 60_000;
const FRAME_BYTES = 2 * 1024 * 1024;
const OUTPUT_BYTES = 50 * 1024;
const TOOL_COUNT = 128;
export const CHAT_DISCOVERED_TOOL_COUNT = 4096;
/** Large local catalogs stay in the host, just like searched remote MCP.
 * A small selected catalog still supports direct calls without discovery. */
export const CHAT_LISTED_CATALOG_BYTES = 8_000;
export const CHAT_TOOL_DISCOVERY_PROMPT =
  "\nTool catalogs may be deferred. When a tool named in these instructions is absent from the offered tools, use that server's search_tools to find it, describe_tool for its full instructions and schema, and call_tool to run it by its original name. All available capabilities remain reachable through these tools; discovery grants no extra permissions.";
const MAX_PAGES = 100;
const SCHEMA_BYTES = 64 * 1024;
const CATALOG_BYTES = 1024 * 1024;
const MAX_FRAMES = 10_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function aborted(): Error { return new Error("MCP operation cancelled"); }

 export function chatMcpEnvironment(serverEnv: Record<string, string>, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath() };
  stripControlPlaneEnv(env);
  return { ...env, ...serverEnv };
}

class ChatMcpClient {
  catalogFingerprint?: string;
  private readonly frameBytes: number;
  private child: ReturnType<typeof spawnCli>;
  private buffer = "";
  private nextId = 1;
  private frames = 0;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(server: Server, computerUse = false) {
    this.frameBytes = computerUse ? 32 * 1024 * 1024 : FRAME_BYTES;
    try {
      this.child = spawnCli(server.command, server.args, {
        stdio: ["pipe", "pipe", "pipe"], env: chatMcpEnvironment(server.env),
      }, "bot");
    } catch { throw new Error("MCP server could not start; check its command and installation"); }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Stderr may contain credentials; drain without recording or returning it.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.fail(new Error("MCP server could not start; check its command and installation")));
    this.child.on("exit", () => this.fail(new Error("MCP server exited before the session closed")));
    this.child.stdin.on("error", () => this.fail(new Error("MCP server input closed")));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    void this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new Error("MCP session closed"));
    this.pending.clear();
    this.buffer = "";
    this.closing = killCliTree(this.child, 5_000).then((stopped) => {
      if (!stopped) throw new Error("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
    });
    return this.closing;
  }

  private write(frame: unknown): void {
    if (this.closed || !this.child.stdin.writable || this.child.stdin.destroyed) throw new Error("MCP session closed");
    const encoded = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(encoded) > this.frameBytes) throw new Error("MCP request exceeds the frame limit");
    this.child.stdin.write(encoded);
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (++this.frames > MAX_FRAMES) return this.fail(new Error("MCP session exceeded the response frame count limit"));
      if (Buffer.byteLength(line) > this.frameBytes) return this.fail(new Error("MCP response exceeds the frame limit"));
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); }
      catch { return this.fail(new Error("MCP server returned invalid JSON")); }
      if (!object(message) || message.jsonrpc !== "2.0") return this.fail(new Error("MCP server returned an invalid RPC envelope"));
      if (typeof message.method === "string") {
        if (typeof message.id === "number" || typeof message.id === "string") {
          try { this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client method not supported" } }); }
          catch { return this.fail(new Error("MCP server input closed")); }
        }
        continue;
      }
      if (typeof message.id !== "number") return this.fail(new Error("MCP server returned an invalid response ID"));
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      if ("error" in message) entry.reject(new Error("MCP request failed; inspect the configured integration"));
      else if (!("result" in message)) entry.reject(new Error("MCP response has no result"));
      else entry.resolve(message.result);
    }
    if (Buffer.byteLength(this.buffer) > this.frameBytes) this.fail(new Error("MCP response exceeds the frame limit"));
  }

  async call(method: string, params: unknown, signal: AbortSignal, timeout: number): Promise<unknown> {
    if (signal.aborted) { await this.close(); throw aborted(); }
    if (this.closed) throw new Error("MCP session closed");
    const id = this.nextId++;
    try {
      return await new Promise((resolve, reject) => {
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          this.pending.delete(id);
          if (error) reject(error); else resolve(value);
        };
        const cancel = () => {
          try { this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled" } }); }
          catch { /* cleanup owns transport failure */ }
          finish(aborted());
        };
        const timer = setTimeout(() => finish(new Error("MCP request timed out; execution outcome may be uncertain")), timeout);
        timer.unref();
        signal.addEventListener("abort", cancel, { once: true });
        this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
        try { this.write({ jsonrpc: "2.0", id, method, params }); }
        catch { finish(new Error("MCP request could not be sent")); }
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async tools(signal: AbortSignal, include: (tool: unknown) => boolean = () => true, startupMs = STARTUP_MS): Promise<unknown[]> {
    const deadline = Date.now() + startupMs;
    const remaining = () => {
      if (Date.now() >= deadline) throw new Error("MCP startup timed out");
      return deadline - Date.now();
    };
    const initialized = await this.call("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openmausbot-chat", version: "1" },
    }, signal, remaining());
    if (!object(initialized)) throw new Error("MCP initialization returned an invalid result");
    if (signal.aborted) throw aborted();
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.call("tools/list", cursor ? { cursor } : {}, signal, remaining());
      if (!object(result) || !Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid result");
      const metadata = object(result._meta) ? result._meta[CATALOG_FINGERPRINT_META] : undefined;
      if (typeof metadata === "string" && /^[a-f0-9]{64}$/.test(metadata)) this.catalogFingerprint = metadata;
      tools.push(...result.tools.filter(include));
      if (tools.length > CHAT_DISCOVERED_TOOL_COUNT) throw new Error("MCP tool count exceeds the discovery limit");
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("MCP tools/list returned an invalid pagination cursor");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("MCP tools/list exceeded the pagination limit");
  }
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= OUTPUT_BYTES) return value;
  let end = OUTPUT_BYTES;
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString()}\n[MCP result truncated at 50KB; request less output.]`;
}

 const BUILT_IN_BROWSER_BLANK_MEANS_OMITTED: Record<string, readonly string[]> = {
  agent_browser_read: ["url"],
};

function omitBlankDefaults(builtInBrowser: boolean, tool: string, args: unknown) {
  if (!builtInBrowser || !object(args)) return;
  for (const field of BUILT_IN_BROWSER_BLANK_MEANS_OMITTED[tool] ?? []) {
    const value = args[field];
    if (typeof value === "string" && !value.trim()) delete args[field];
  }
}

export async function mountChatTools(integrations: SendTurnInput["integrations"], signal: AbortSignal, computerUse = false, toolScope?: ToolScope, callTimeoutMs: number = DEFAULT_CALL_MS): Promise<ChatToolSession> {
  const parsed = parseToolScope(toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const scope = parsed.scope;
  const servers: Array<[string, Server]> = [];
  const searchable = new Set<string>();
  const eligible = (server: string) => scope === undefined || canUseMcpServer(scope, server);
  if (computerUse && integrations?.localComputer && eligible("computer")) servers.push(["computer", integrations.localComputer]);
  if (computerUse && integrations?.browser && eligible("browser")) servers.push(["browser", integrations.browser]);
  // Security: a selection matches the name in the call, so with one the agents server is never bridged.
  const agentsServer = integrations?.agents && scope !== undefined ? unbridgedServer(integrations.agents) : integrations?.agents;
  if (agentsServer && eligible("agents")) servers.push(["agents", agentsServer]);
  if (integrations?.composio && eligible("composio")) servers.push(["composio", integrations.composio]);
  if (integrations?.data && eligible("data")) servers.push(["data", integrations.data]);
  if (integrations?.highlevel && eligible("highlevel")) servers.push(["highlevel", integrations.highlevel]);
  for (const [name, server] of Object.entries(integrations?.custom ?? {})) {
    if (!eligible(name)) continue;
    const remote = remoteMcpSpec(server) !== undefined;
    const stdio = mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(remote ? { directory: { name, ...(scope ? { toolScope: scope } : {}) } } : {}) });
    if (!stdio) throw new Error("MCP server configuration is invalid");
    if (remote) searchable.add(name);
    servers.push([name, { command: stdio.command, args: stdio.args ?? [], env: stdio.env ?? {} }]);
  }
  if (servers.length > 32) throw new Error("MCP server count exceeds the 32-server limit");
  const clients: ChatMcpClient[] = [];
  const skippable = new Set(Object.keys(integrations?.custom ?? {}));
  const skipped: SkippedChatMcpServer[] = [];
  const started = new Map<string, ChatMcpClient>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener("abort", cancel);
    closing = Promise.allSettled(clients.map((client) => client.close())).then((results) => {
      if (results.some((result) => result.status === "rejected")) throw new ChatToolSessionError("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
    });
    return closing;
  };
  const cancel = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const definitions: ChatToolDefinition[] = [];
  const registered = new Map<string, RegisteredTool>();
  const directories = new Map<string, { directory: ToolDirectory; operation: string; server: string; byOriginal: Map<string, string> }>();
  let catalogBytes = 0;
  let catalogHash = createHash("sha256");
  try {
    if (signal.aborted) throw aborted();
    const mounts = await Promise.allSettled(servers.map(async ([name, descriptor]) => {
      if (signal.aborted || closed) throw aborted();
      const client = new ChatMcpClient(descriptor, computerUse);
      clients.push(client);
      started.set(name, client);
      const include = (tool: unknown) => scope === undefined || (object(tool) && typeof tool.name === "string"
        && ((searchable.has(name) && isDirectoryTool(tool.name)) || allowsTool(scope, { kind: "mcp", server: name, name: tool.name })));
      const tools = await client.tools(signal, include, searchable.has(name) ? REMOTE_MCP_STARTUP_MS : STARTUP_MS);
      const launch = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
      return { name, client, launch, builtInBrowser: descriptor === integrations?.browser, agents: descriptor === agentsServer,
        hostComputer: descriptor === integrations?.localComputer && integrations?.localComputer?.scope === "local-computer", tools };
    }));
    for (const [index, mount] of mounts.entries()) {
      const configured = servers[index]![0];
      if (signal.aborted || closed) throw aborted();
      const skip = async (error: unknown) => {
        const reason = error instanceof Error ? error.message : "MCP server failed to start";
        skipped.push({ server: configured, reason });
        console.warn(`chat-mcp: skipping MCP server "${configured}" for this turn: ${reason}`);
        await started.get(configured)?.close();
      };
      if (mount.status === "rejected") {
        if (!skippable.has(configured)) throw mount.reason;
        await skip(mount.reason);
        continue;
      }
      const { name: server, client, launch, builtInBrowser, agents, hostComputer, tools } = mount.value;
      const registeredBefore = new Set(registered.keys());
      const directoriesBefore = new Set(directories.keys());
      const definitionsBefore = definitions.length;
      const bytesBefore = catalogBytes;
      const hashBefore = catalogHash.copy();
      try {
      const originalNames = new Set<string>();
      const direct: ChatToolDefinition[] = [];
      const catalog: CatalogTool[] = [];
      const byOriginal = new Map<string, string>();
      for (const tool of tools) {
        if (!object(tool) || typeof tool.name !== "string" || !tool.name.trim() || originalNames.has(tool.name)) throw new Error("MCP server advertised an invalid or duplicate tool name");
        originalNames.add(tool.name);
        catalogBytes += Buffer.byteLength(JSON.stringify(tool));
        if (catalogBytes > CATALOG_BYTES) throw new Error("MCP tool catalog exceeds the 1MB limit");
        if (!object(tool.inputSchema) || tool.inputSchema.type !== "object") throw new Error("MCP tools require an object input schema");
        if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > SCHEMA_BYTES) throw new Error("MCP tool schema exceeds the 64KB limit");
        const schema = compileToolSchema(tool.inputSchema);
        const parameters = { ...tool.inputSchema };
        const constraints: Record<string, unknown> = {};
        if (computerUse) {
          for (const key of ["anyOf", "oneOf", "allOf", "not"]) {
            if (key in parameters) { constraints[key] = parameters[key]; delete parameters[key]; }
          }
        }
        const description = (typeof tool.description === "string" ? tool.description : "Configured MCP tool") +
          (Object.keys(constraints).length ? " Additional argument constraints (validated before execution): " + JSON.stringify(constraints) : "");
        const base = chatToolName(server, tool.name);
        let name = base;
        for (let index = 2; registered.has(name) || directories.has(name); index += 1) { const suffix = `_${index}`; name = base.slice(0, 64 - suffix.length) + suffix; }
        registered.set(name, { client, server, launch, builtInBrowser, agents, hostComputer, name: tool.name, schema, searched: searchable.has(server) });
        byOriginal.set(tool.name, name);
        catalog.push(tool as CatalogTool);
        direct.push({ type: "function", function: { name, description, parameters } });
      }
      catalogHash.update(JSON.stringify([server, fingerprintCatalog(server, catalog),
        searchable.has(server) ? client.catalogFingerprint : undefined]));
      const alreadySearched = searchable.has(server) && catalog.every((tool) => isDirectoryTool(tool.name));
      const deferred = !alreadySearched && (direct.length > LISTED_TOOLS_MAX || Buffer.byteLength(JSON.stringify(direct)) > CHAT_LISTED_CATALOG_BYTES);
      if (deferred) {
        const directory = new ToolDirectory(catalog, { check: (tool, args) => {
          const entry = registered.get(byOriginal.get(tool.name)!)!;
          omitBlankDefaults(entry.builtInBrowser, entry.name, args);
          return entry.schema(args) ? undefined : (entry.schema.errors ?? []).map((error) => error.message ?? "Invalid arguments");
        } });
        for (const tool of directory.listed({ server })) {
          const original = tool.name as string;
          const base = chatToolName(server, original);
          let name = base;
          for (let index = 2; registered.has(name) || directories.has(name); index += 1) {
            const suffix = `_${index}`; name = base.slice(0, 64 - suffix.length) + suffix;
          }
          directories.set(name, { directory, operation: original, server, byOriginal });
          definitions.push({ type: "function", function: { name, description: tool.description as string, parameters: tool.inputSchema as Record<string, unknown> } });
        }
      } else {
        definitions.push(...direct);
      }
      if (definitions.length > TOOL_COUNT) throw new Error("MCP tool count exceeds the 128-tool limit");
      } catch (error) {
        for (const key of registered.keys()) if (!registeredBefore.has(key)) registered.delete(key);
        for (const key of directories.keys()) if (!directoriesBefore.has(key)) directories.delete(key);
        definitions.length = definitionsBefore;
        catalogBytes = bytesBefore;
        catalogHash = hashBefore;
        if (!skippable.has(server)) throw error;
        await skip(error);
      }
    }
    if (signal.aborted || closed) throw aborted();
  } catch (error) { await close(); throw error; }
  const target = (tool: { name: string; searched: boolean }, args: unknown) => tool.searched ? directoryCallTarget(tool.name, args) : tool.name;
  const advertised = new Set(definitions.map((tool) => tool.function.name));
  const validate = (name: string, args: unknown) => {
    if (closed || signal.aborted) throw new ChatToolSessionError("MCP session closed");
    const deferred = directories.get(name);
    if (deferred) {
      if (!object(args)) throw new Error("Tool arguments must be an object");
      if (deferred.operation === CALL_TOOL && scope !== undefined && typeof args.name === "string"
        && !allowsTool(scope, { kind: "mcp", server: deferred.server, name: args.name })) throw new Error("Tool selection excludes this tool");
      return;
    }
    const tool = registered.get(name);
    if (!tool || !advertised.has(name)) throw new Error("The requested tool was not advertised for this turn");
    const excluded = (runs: string | undefined) => scope !== undefined && runs !== undefined
      && !allowsTool(scope, { kind: "mcp", server: tool.server, name: runs });
    const directory = tool.searched && isDirectoryTool(tool.name);
    // Security: should a bridged agents server answer here, use_tool is also judged by the tool it names.
    if (!directory && (excluded(tool.name) || (tool.agents && excluded(bridgedCallTarget(tool.name, args))))) throw new Error("Tool selection excludes this tool");
    omitBlankDefaults(tool.builtInBrowser, tool.name, args);
    if (!object(args) || (!directory && !tool.schema(args))) throw new Error("Tool arguments do not match the advertised input schema; use its required fields and types");
    if (tool.searched && excluded(target(tool, args))) throw new Error("Tool selection excludes this tool");
  };
  const view = (name: string, args: Record<string, unknown>): ChatToolCallView => {
    const deferred = directories.get(name);
    if (deferred) {
      const call = deferred.operation === CALL_TOOL ? deferred.directory.call(args) : undefined;
      if (!call || "answer" in call) return { title: name, input: args, ask: false };
      const original = deferred.byOriginal.get(call.name)!;
      const tool = registered.get(original)!;
      const grant = !tool.hostComputer ? JSON.stringify([tool.server, tool.launch, call.name]) : undefined;
      return { title: original, input: call.arguments, ask: !tool.agents, ...(grant && !tool.agents ? { grant } : {}) };
    }
    const tool = registered.get(name);
    const runs = tool ? target(tool, args) : name;
    if (runs === undefined || tool?.agents) return { title: name, input: args, ask: false };
    const grant = tool && !tool.hostComputer ? JSON.stringify([tool.server, tool.launch, runs]) : undefined;
    if (!tool?.searched || tool.name !== CALL_TOOL) return { title: name, input: args, ask: true, ...(grant ? { grant } : {}) };
    return { title: chatToolName(tool.server, runs), input: object(args.arguments) ? args.arguments : {}, ask: true, ...(grant ? { grant } : {}) };
  };
  return {
    definitions, skipped, catalogFingerprint: catalogHash.digest("hex"), validate, view, close,
    async execute(name, args, callSignal) {
      validate(name, args);
      if (callSignal.aborted) { await close(); throw aborted(); }
      const deferred = directories.get(name);
      let originalName = name;
      let originalArgs = args;
      if (deferred) {
        const answer = deferred.operation === SEARCH_TOOL ? await deferred.directory.search(args)
          : deferred.operation === DESCRIBE_TOOL ? deferred.directory.describe(args) : undefined;
        if (answer) return { text: answer.content.map((part) => part.text).join("\n"), ok: answer.isError !== true };
        const call = deferred.directory.call(args);
        if ("answer" in call) return { text: call.answer.content.map((part) => part.text).join("\n"), ok: call.answer.isError !== true };
        originalName = deferred.byOriginal.get(call.name)!;
        originalArgs = call.arguments;
      }
      const tool = registered.get(originalName)!;
      try {
        const result = await tool.client.call("tools/call", { name: tool.name, arguments: originalArgs }, AbortSignal.any([signal, callSignal]), callTimeoutMs);
        if (signal.aborted || callSignal.aborted) throw aborted();
        if (!object(result) || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new Error("MCP tool returned an invalid result; execution outcome may be uncertain");
        const parts: string[] = [];
        const images: ChatImagePart[] = [];
        let unsupported = 0;
        for (const item of result.content) {
          if (!object(item) || typeof item.type !== "string" || (item.type === "text" && typeof item.text !== "string")) throw new Error("MCP tool returned invalid content; execution outcome may be uncertain");
          if (item.type === "text") parts.push(item.text as string);
          else if (computerUse && item.type === "image") images.push(chatImage(item));
          else unsupported += 1;
        }
        if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
        if (unsupported) parts.unshift(`[${unsupported} unsupported MCP content item(s) omitted. The operation may have taken effect, but its full result cannot be represented; inspect its state before retrying.]`);
        return { text: boundedText(parts.join("\n") || (images.length ? "Screenshot captured." : "(empty result)")), ok: result.isError !== true && unsupported === 0,
          ...(images.length ? { images } : {}) };
      } catch (error) {
        await close();
        throw new ChatToolSessionError(error instanceof Error ? error.message : "MCP transport failed; execution outcome may be uncertain");
      }
    },
  };
}
