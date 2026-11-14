// Per-turn MCP transport for the Chat Completions runtime: approval is the caller's, and only
// registered, schema-validated calls arrive here.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { stripControlPlaneEnv } from "../config.ts";
import type { SendTurnInput } from "../contracts.ts";
import { cloudRole } from "../bot-box/detect.ts";
import { redactSecretsInText } from "../redact.ts";
import { MESSAGE_FILE_MAX_BYTES } from "../message-file.ts";
import { augmentedPath } from "../env-path.ts";
import { cloudHomeConfigured } from "../cloud-home.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { AGENTS_TOOL_ALIASES } from "../../shared/agents-tool-names.ts";
import { bridgedCallTarget, unbridgedServer } from "./agents-bridge.ts";
import { chatImage, type ChatImagePart } from "./chat-images.ts";
import { CALL_TOOL, DESCRIBE_TOOL, SEARCH_TOOL, ToolDirectory, directoryCallTarget, isDirectoryTool, type CatalogTool, type DirectoryResult } from "../mcp-directory.ts";
import { AppObserver, modelVisible, withUiExtension } from "../mcp-app-observer.ts";
import { appMountFor, mcpStdioServer } from "../mcp-gate-config.ts";
import { REMOTE_MCP_STARTUP_MS, remoteMcpSpec } from "../mcp-http.ts";
import { compileToolSchema, schemaProblems, serverToolValidator, type ServerToolCheck } from "../mcp-schema-validator.ts";
import { fitToolList, withoutDanglingReferences } from "../mcp-tool-schema.ts";
import { listsComputerTool } from "../computer-tool-list.ts";
import { READ_OPEN_PAGE_ONLY, readsAroundBrowser } from "../browser-tool-shape.ts";
import { capToolList, learnToolCountLimit, shareToolBudget, toolCountLimitFromError } from "../tool-count-limit.ts";
import type { ToolSchemaProfile } from "../tool-schema-profile.ts";
import { allowsTool, canUseMcpServer, parseToolScope, type ToolScope } from "../../shared/tool-scope.ts";
import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";
import { CHAT_TOOL_LIMIT, type ToolBudget } from "../../shared/tool-budget.ts";

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
/** Configured servers at the same address with the same sign-in as `server`, mounted once under its name. */
export interface MergedChatMcpServers { server: string; same: string[] }
/** A built-in server that listed only its first `listed` of `of` tools, so the turn fits the model's tool limit. */
export interface TrimmedChatMcpServer { server: string; listed: number; of: number }
export interface ChatToolSession {
  definitions: ChatToolDefinition[];
  skipped: SkippedChatMcpServer[];
  trimmed: TrimmedChatMcpServer[];
  merged: MergedChatMcpServers[];
  budget: ToolBudget;
  /** Lists the turn's tools again within `limit`, after a provider refused that many; started servers keep running. */
  refit(limit: number): Promise<void>;
  validate(name: string, args: unknown): void;
  /** Directory reads and OpenMausBot's own agents server need no card; call_tool shows the tool it runs. */
  view(name: string, args: Record<string, unknown>): ChatToolCallView;
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatToolResult>;
  close(): Promise<void>;
}

type Server = { command: string; args: string[]; env: Record<string, string> };
/** `required`: a server the turn must not run without (see `mustHave` in mountChatTools). */
type RegisteredTool = { client: ChatMcpClient; server: string; launch: string; builtInBrowser: boolean; agents: boolean; hostComputer: boolean; required: boolean; name: string; schema: ValidateFunction; searched: boolean };
function chatToolName(server: string, tool: string): string {
  return `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "mcp_tool";
}
const STARTUP_MS = 8_000;
/** A small Cloud home that is busy can take this long to load Node and a server's own imports. */
const CLOUD_STARTUP_MS = 30_000;
const STARTUP_TIMED_OUT = "MCP startup timed out";
const REQUEST_TIMED_OUT = "MCP request timed out; execution outcome may be uncertain";
/** How much of a server's stderr is kept, and how much of its last line is ever shown. */
const STDERR_TAIL_CHARS = 4_000, STDERR_LINE_CHARS = 300;
/** Built-ins a turn can go on without, saying so. A turn can't run without the agents server, nor without a Local VM it
 * was given (mountChatTools `mustHave`). */
const OPTIONAL_BUILT_INS: ReadonlySet<string> = new Set(["computer", "browser", "composio", OWN_APPS_SERVER, "data", "email", "device"]);

/** How long a server that runs a command gets to start here. */
export function mcpStartupMs(env: Record<string, string | undefined> = process.env): number {
  return cloudRole(env) ? CLOUD_STARTUP_MS : STARTUP_MS;
}
const DEFAULT_CALL_MS = 10 * 60_000;
const FRAME_BYTES = 2 * 1024 * 1024;
const OUTPUT_BYTES = 50 * 1024;
/** ask_user, which the runtime lists after the MCP tools. */
const RUNTIME_TOOLS = 1;
/** Past the limit a server is searched, not listed, so this only bounds what one server may offer. */
const SERVER_TOOLS_MAX = 2_000;
const DIRECTORY_SERVER = "mcp";
const DIRECTORY_TOOL_COUNT = 3;
const MAX_PAGES = 100;
const SCHEMA_BYTES = 64 * 1024;
const CATALOG_BYTES = 1024 * 1024;
const MAX_FRAMES = 10_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function aborted(): Error { return new Error("MCP operation cancelled"); }
class McpRequestRefused extends Error {}

/** A chat-runtime bot's tools never get the operator's control-plane secrets; the entry's own env is applied last. */
export function chatMcpEnvironment(serverEnv: Record<string, string>, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath() };
  stripControlPlaneEnv(env);
  return { ...env, ...serverEnv };
}

export class ChatMcpClient {
  private readonly frameBytes: number;
  private child: ReturnType<typeof spawnCli>;
  private buffer = "";
  private nextId = 1;
  private frames = 0;
  private closed = false;
  private closing?: Promise<void>;
  private failure?: string;
  private stderrTail = "";
  private readonly configured: string[];
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  /** `configured`: a server the person set up, whose own environment passes the bot box as theirs. */
  constructor(server: Server, computerUse = false, configured = false) {
    this.frameBytes = computerUse ? 32 * 1024 * 1024 : FRAME_BYTES;
    this.configured = Object.values(server.env).filter((value) => value.length >= 6);
    try {
      // The desktop shell inherits Finder's bare PATH, where `npx`-style servers cannot find `node`.
      this.child = spawnCli(server.command, server.args, {
        stdio: ["pipe", "pipe", "pipe"], env: chatMcpEnvironment(server.env),
        ...(configured ? { box: { allowEnv: Object.keys(server.env), configured: true } } : {}),
      }, "bot");
    } catch { throw new Error("MCP server could not start; check its command and installation"); }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer | string) => { this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS); });
    this.child.on("error", () => this.fail(new Error("MCP server could not start; check its command and installation")));
    // "close" follows the last of its output, so what it said on the way out is read first; a helper still holding stderr doesn't hold this up.
    this.child.on("exit", () => {
      const stop = () => this.fail(new Error(`MCP server exited before the session closed.${this.lastWords()}`));
      this.child.once("close", stop);
      setTimeout(stop, 200).unref();
    });
    this.child.stdin.on("error", () => this.fail(new Error("MCP server input closed")));
  }

  /** The last line the server wrote to stderr, for saying why it stopped. Stderr can hold credentials, so its configured
   * values and anything shaped like a secret are masked first, and a line cut off by the tail is never shown. */
  private lastWords(): string {
    const whole = this.stderrTail.length >= STDERR_TAIL_CHARS ? this.stderrTail.slice(this.stderrTail.indexOf("\n") + 1 || this.stderrTail.length) : this.stderrTail;
    const masked = this.configured.reduce((text, value) => text.split(value).join("[redacted]"), whole);
    const line = redactSecretsInText(masked).split("\n").map((entry) => entry.trim()).filter(Boolean).at(-1);
    return line ? ` It last said: ${line.slice(0, STDERR_LINE_CHARS)}` : "";
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error.message;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    void this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Read before the pending rejections below: only a call still in flight at entry is genuinely uncertain.
    const inFlight = this.pending.size > 0;
    for (const entry of this.pending.values()) entry.reject(new Error("MCP session closed"));
    this.pending.clear();
    this.buffer = "";
    // Windows reaps the tree via taskkill /T, which can exceed shorter budgets on a loaded machine;
    // elsewhere the budget is the TERM grace before KILL, not a verdict race, so it stays short.
    this.closing = killCliTree(this.child, process.platform === "win32" ? 15_000 : 5_000).then((stopped) => {
      if (stopped) return;
      if (!inFlight) {
        console.warn("chat-mcp: shutdown could not be confirmed within its budget; no call was in flight, so the turn outcome is unaffected");
        return;
      }
      throw new Error("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
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
      if ("error" in message) entry.reject(new McpRequestRefused("MCP request failed; inspect the configured integration"));
      else if (!("result" in message)) entry.reject(new Error("MCP response has no result"));
      else entry.resolve(message.result);
    }
    if (Buffer.byteLength(this.buffer) > this.frameBytes) this.fail(new Error("MCP response exceeds the frame limit"));
  }

  async call(method: string, params: unknown, signal: AbortSignal, timeout: number, keepOnRefusal = false, timedOut = REQUEST_TIMED_OUT): Promise<unknown> {
    if (signal.aborted) { await this.close(); throw aborted(); }
    if (this.closed) throw new Error(this.failure ?? "MCP session closed");
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
          catch {}
          finish(aborted());
        };
        const timer = setTimeout(() => finish(new Error(timedOut)), timeout);
        timer.unref();
        signal.addEventListener("abort", cancel, { once: true });
        this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
        try { this.write({ jsonrpc: "2.0", id, method, params }); }
        catch { finish(new Error("MCP request could not be sent")); }
      });
    } catch (error) {
      if (!(keepOnRefusal && error instanceof McpRequestRefused)) await this.close();
      throw error;
    }
  }

  async tools(signal: AbortSignal, include: (tool: unknown) => boolean = () => true, startupMs = STARTUP_MS, observer?: AppObserver): Promise<unknown[]> {
    const deadline = Date.now() + startupMs;
    const remaining = () => {
      if (Date.now() >= deadline) throw new Error(STARTUP_TIMED_OUT);
      return deadline - Date.now();
    };
    const handshake = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openmausbot-chat", version: "1" } };
    let initialized: unknown;
    if (observer?.mount.extension) {
      try { initialized = await this.call("initialize", withUiExtension(handshake), signal, remaining(), true, STARTUP_TIMED_OUT); }
      catch (error) {
        if (!(error instanceof McpRequestRefused)) throw error;
        initialized = await this.call("initialize", handshake, signal, remaining(), false, STARTUP_TIMED_OUT);
      }
    } else {
      initialized = await this.call("initialize", handshake, signal, remaining(), false, STARTUP_TIMED_OUT);
    }
    if (!object(initialized)) throw new Error("MCP initialization returned an invalid result");
    observer?.initialized(initialized);
    if (signal.aborted) throw aborted();
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.call("tools/list", cursor ? { cursor } : {}, signal, remaining(), false, STARTUP_TIMED_OUT);
      if (!object(result) || !Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid result");
      observer?.listed(result);
      tools.push(...result.tools.filter((tool) => modelVisible(tool) && include(tool)));
      if (tools.length > SERVER_TOOLS_MAX) throw new Error(`MCP server offers more than ${SERVER_TOOLS_MAX} tools`);
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("MCP tools/list returned an invalid pagination cursor");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("MCP tools/list exceeded the pagination limit");
  }
}

export function trimmedToolsNotice(trimmed: readonly TrimmedChatMcpServer[], limit: number | null = CHAT_TOOL_LIMIT): string | undefined {
  if (!trimmed.length) return undefined;
  const servers = trimmed.map(({ server, listed, of }) => `"${server}" listed ${listed} of ${of} tools`).join(", ");
  return `${servers} to fit the model's ${limit}-tool limit; the rest are left out of this turn.`;
}

function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length === 1 ? quoted[0]! : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

export function mergedServersNotice({ server, same }: MergedChatMcpServers): string {
  return `MCP ${same.length === 1 ? "server" : "servers"} ${quotedList(same)} ${same.length === 1 ? "connects" : "connect"} to the same address with the same sign-in as "${server}", so their tools are listed once, under "${server}".`;
}

export function searchedServersNotice(budget: ToolBudget): string | undefined {
  const names = budget.servers.filter((server) => !server.direct).map((server) => server.name);
  if (!names.length) return undefined;
  return `To fit the model's ${budget.limit}-tool limit, the tools of ${quotedList(names)} are reached through the tool search this turn.`;
}

/** What the tool limit did to a turn's servers, one line each. */
export function toolLimitNotices(session: Pick<ChatToolSession, "trimmed" | "budget">): string[] {
  return [trimmedToolsNotice(session.trimmed, session.budget.limit), searchedServersNotice(session.budget)].filter((line): line is string => line !== undefined);
}

/** After a provider refused a request for the limit its `error` names, learns that limit under `key` and lists the turn's
 * tools again within it, the runtime's own `runtime` definitions kept after them. The lines say what the limit did;
 * undefined when the refusal was for something else. */
export async function refitChatTools(session: ChatToolSession, error: unknown, key: string, runtime: readonly ChatToolDefinition[]): Promise<string[] | undefined> {
  const limit = toolCountLimitFromError(error);
  if (limit === undefined || limit >= session.definitions.length) return undefined;
  learnToolCountLimit(key, limit);
  console.warn(`chat-mcp: the model takes at most ${limit} tools; listing the turn's tools again within that`);
  const kept = session.definitions.filter((definition) => runtime.includes(definition));
  await session.refit(limit);
  session.definitions.push(...kept);
  return toolLimitNotices(session);
}

/** What the person hears about a turn's MCP servers before the model runs, one line each. */
export function chatToolNotices(session: Pick<ChatToolSession, "skipped" | "trimmed" | "budget"> & Partial<Pick<ChatToolSession, "merged">>): string[] {
  return [
    ...(session.merged ?? []).map(mergedServersNotice),
    ...session.skipped.map(({ server, reason }) => `MCP server "${server}" was skipped for this turn: ${reason}`),
    ...toolLimitNotices(session),
  ];
}

function preview(bytes: Buffer): string {
  let end = OUTPUT_BYTES;
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString();
}

function boundedText(value: string, bytes = Buffer.from(value)): string {
  if (bytes.length <= OUTPUT_BYTES) return value;
  return `${preview(bytes)}\n[MCP result truncated at 50KB; request less output.]`;
}

/** Folder, inside the bot's working folder, that keeps tool results too big to show the model whole. */
export const SAVED_RESULTS_FOLDER = "mcp-results";
/** Only the newest saved results are kept, so repeated big results cannot fill the disk. */
export const SAVED_RESULTS_KEPT = 20;
const SAVED_RESULT_NAME = /^result-.+-(\d+)-[0-9a-f]{6}\.txt$/;

/** The file just written (`keep`) is never removed, even if the clock went back. */
async function pruneSavedResults(dir: string, keep: string): Promise<void> {
  const saved = (await readdir(dir)).flatMap((name) => {
    const match = name === keep ? null : SAVED_RESULT_NAME.exec(name);
    return match ? [{ name, at: Number(match[1]) }] : [];
  }).sort((a, b) => b.at - a.at);
  await Promise.all(saved.slice(SAVED_RESULTS_KEPT - 1).map(({ name }) => unlink(join(dir, name))));
}

/** A result over the limit is kept whole (secrets masked by `scrub`) in `folder`/mcp-results and the model reads its start and the file's path.
 * Without a folder, when the file cannot be written, or when it is over the attach limit, it is cut as before. */
async function savedOrBounded(value: string, tool: string, folder: string | undefined, scrub: (text: string) => string): Promise<string> {
  const bytes = Buffer.from(value);
  if (bytes.length <= OUTPUT_BYTES || !folder) return boundedText(value, bytes);
  try {
    const dir = join(folder, SAVED_RESULTS_FOLDER);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Security: never follow a link the folder's contents put here to write outside the working folder.
    if (!(await lstat(dir)).isDirectory()) throw new Error("not a folder");
    const name = `result-${tool}-${Date.now()}-${randomBytes(3).toString("hex")}.txt`, file = join(dir, name);
    // Key-shaped values are masked before the result reaches disk, as for every other kept tool result.
    const kept = scrub(value);
    // A file over the attach limit could not be attached, so it is cut as before.
    if (Buffer.byteLength(kept) > MESSAGE_FILE_MAX_BYTES) return boundedText(value, bytes);
    await writeFile(file, kept, { flag: "wx", mode: 0o600 });
    await pruneSavedResults(dir, name).catch(() => {});
    const kb = Math.ceil(bytes.length / 1024), masked = kept === value ? "" : " (secret-looking values in it are masked)";
    return `${preview(bytes)}\n[MCP result is ${kb}KB; only the first 50KB is shown above. The full result is saved in ${file}${masked}]`;
  } catch {
    return boundedText(value, bytes);
  }
}

/** Smaller models fill optional fields with "" instead of omitting them; for these a blank means omitted. */
const BUILT_IN_BROWSER_BLANK_MEANS_OMITTED: Record<string, readonly string[]> = {
  agent_browser_read: ["url"],
  agent_browser_screenshot: ["ref", "selector"],
};

const ROUTE_LOOPBACK = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/iu;

/** A screenshot names one target; a model that fills `ref` and `selector` (or a point) means the first, and the rest
 * would otherwise fail the call as "Pass only one of ref, selector, or x and y." */
export function normalizeBuiltInBrowserArgs(tool: string, args: unknown): void {
  if (!object(args)) return;
  for (const field of BUILT_IN_BROWSER_BLANK_MEANS_OMITTED[tool] ?? []) {
    const value = args[field];
    if (typeof value === "string" && !value.trim()) delete args[field];
  }
  if (tool !== "agent_browser_screenshot") return;
  if (args.ref !== undefined && args.selector !== undefined) delete args.selector;
  if (args.ref !== undefined || args.selector !== undefined) { delete args.x; delete args.y; }
}

/** On a self-hosted server the browser runs on the server; 127.0.0.1 there is the server itself, not the person's computer.
 * Say so on the failed navigation instead of leaving only ERR_SOCKS_CONNECTION_FAILED, and point at the LAN address to use.
 * Not on the desktop app, where the browser runs on the person's own computer, nor on a Cloud home, which has no such setting. */
export function loopbackNavigationHint(tool: string, args: unknown, text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.OMB_DESKTOP_PARENT === "1" || cloudHomeConfigured(env)) return "";
  if (!/^agent_browser_(?:open|navigate)$/u.test(tool) || !object(args) || typeof args.url !== "string") return "";
  if (!ROUTE_LOOPBACK.test(args.url.trim()) || !/(?:ERR_[A-Z_]+|failed)/u.test(text)) return "";
  return " That address is the loopback of the machine running this browser, not your own computer: open the site by the LAN address it answers on (for example http://192.168.1.20:8188), which must be reachable from the server, and allow it under Settings → Browser → Open sites on this server.";
}

/** agent-browser's read hides `url`: a call whose only misfit is a string url gets the way to read an address instead of the bare schema misfit. */
function readsAddressOnly(tool: RegisteredTool, args: unknown): boolean {
  if (!tool.builtInBrowser || !readsAroundBrowser({ name: tool.name, arguments: args }) || !object(args) || typeof args.url !== "string") return false;
  const { url: _url, ...rest } = args;
  return tool.schema(rest);
}

/** READ_OPEN_PAGE_ONLY with the tool names this chat registered for the browser server. */
function readOpenPageOnly(server: string): string {
  return READ_OPEN_PAGE_ONLY.replace(/agent_browser_(?:open|read)/gu, (tool) => chatToolName(server, tool));
}

function omitBlankDefaults(builtInBrowser: boolean, tool: string, args: unknown) {
  if (!builtInBrowser) return;
  normalizeBuiltInBrowserArgs(tool, args);
}

type CheckedTool = { tool: Record<string, unknown> & { name: string; inputSchema: Record<string, unknown> }; schema: ValidateFunction; check: ServerToolCheck };
type ToolOrigin = Omit<RegisteredTool, "name" | "schema">;
const ARGUMENTS_MISFIT = "Tool arguments do not match the advertised input schema; use its required fields and types";

function checkedTools(tools: readonly unknown[], server: string): CheckedTool[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (!object(tool) || typeof tool.name !== "string" || !tool.name.trim() || names.has(tool.name)) throw new Error("MCP server advertised an invalid or duplicate tool name");
    names.add(tool.name);
    if (!object(tool.inputSchema) || tool.inputSchema.type !== "object") throw new Error("MCP tools require an object input schema");
    if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > SCHEMA_BYTES) throw new Error("MCP tool schema exceeds the 64KB limit");
    const { validate, check } = serverToolValidator(tool.inputSchema);
    if (check !== "full") console.warn(`chat-mcp: "${server}" tool "${tool.name}": its input schema could not be compiled whole, so ${check === "lenient" ? "calls are checked against its lenient copy and the server checks the rest" : "the server alone checks its arguments"}`);
    return { tool: tool as CheckedTool["tool"], schema: validate, check };
  });
}

/** Two configured URL servers are the same when they share the address and every header, the sign-in among them. */
function sameServerKey(server: unknown): string | undefined {
  const remote = remoteMcpSpec(server);
  if (!remote) return undefined;
  const headers = Object.entries(remote.headers).map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
  return JSON.stringify([new URL(remote.url).href, headers]);
}

function uniqueName(base: string, taken: (name: string) => boolean): string {
  let name = base;
  for (let index = 2; taken(name); index += 1) { const suffix = `_${index}`; name = base.slice(0, 64 - suffix.length) + suffix; }
  return name;
}

/** The configured servers a turn lists whole within `room` tools. When not all fit, the tool search's own tools take their
 * place in the room first, and the smallest servers are listed whole, so the fewest are reached through it. */
export function directServers(servers: ReadonlyArray<{ name: string; tools: number }>, room: number): Set<string> {
  if (servers.reduce((sum, server) => sum + server.tools, 0) <= room) return new Set(servers.map((server) => server.name));
  let left = room - DIRECTORY_TOOL_COUNT;
  const direct = new Set<string>();
  for (const server of [...servers].sort((a, b) => a.tools - b.tools)) {
    if (server.tools > left) continue;
    direct.add(server.name);
    left -= server.tools;
  }
  return direct;
}

/** Under `schemaProfile` the model reads each tool's schema fitted to its provider; calls are still checked against the full one.
 * A tool result over 50KB is saved whole in `resultFolder`, the bot's working folder, after `scrub` masks secrets (see savedOrBounded).
 * `toolLimit` is the most tools the provider takes in one request, ask_user included; null when it takes any number. */
export async function mountChatTools(integrations: SendTurnInput["integrations"], signal: AbortSignal, computerUse = false, toolScope?: ToolScope, callTimeoutMs: number = DEFAULT_CALL_MS,
  schemaProfile?: ToolSchemaProfile, resultFolder?: string, scrub: (text: string) => string = redactSecretsInText, toolLimit: number | null = CHAT_TOOL_LIMIT): Promise<ChatToolSession> {
  const parsed = parseToolScope(toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const scope = parsed.scope;
  const servers: Array<[string, Server]> = [];
  const observers = new Map<string, AppObserver>();
  const searchable = new Set<string>();
  const eligible = (server: string) => scope === undefined || canUseMcpServer(scope, server);
  if (computerUse && integrations?.localComputer && eligible("computer")) servers.push(["computer", integrations.localComputer]);
  if (computerUse && integrations?.browser && eligible("browser")) servers.push(["browser", integrations.browser]);
  // Security: a selection matches the name in the call, so with one the agents server is never bridged.
  const agentsServer = integrations?.agents && scope !== undefined ? unbridgedServer(integrations.agents) : integrations?.agents;
  if (agentsServer && eligible("agents")) servers.push(["agents", agentsServer]);
  if (integrations?.composio && eligible("composio")) servers.push(["composio", integrations.composio]);
  if (integrations?.composioOwn && eligible(OWN_APPS_SERVER)) servers.push([OWN_APPS_SERVER, integrations.composioOwn]);
  if (integrations?.data && eligible("data")) servers.push(["data", integrations.data]);
  if (integrations?.email && eligible("email")) servers.push(["email", integrations.email]);
  if (integrations?.device && eligible("device")) servers.push(["device", integrations.device]);
  // A failed mount of an optional built-in is skipped like a configured server's, which the model is told about, so one
  // dead helper can't fail every later turn. (CLI engines already drop them and go on.)
  // Safety: a turn never runs without the agents server, or without a Local VM it was given (any computer but this
  // desktop's own): without the VM's tools the model would do the work some other way, outside the VM. Such a server that
  // can't start, lists no tools, or fails during the turn ends the turn, as every server did before.
  const mustHave = (descriptor: Server) => descriptor === agentsServer || (descriptor === integrations?.localComputer && integrations?.localComputer?.scope !== "local-computer");
  const startupMs = mcpStartupMs();
  const builtIns = servers.length;
  const besideBrowser = servers.some(([, descriptor]) => descriptor === integrations?.browser);
  const merged: MergedChatMcpServers[] = [];
  const firstOf = new Map<string, MergedChatMcpServers>();
  for (const [name, server] of Object.entries(integrations?.custom ?? {})) {
    if (!eligible(name)) continue;
    // A selection names each server's tools, so with one every server keeps its own name.
    const key = scope === undefined ? sameServerKey(server) : undefined;
    const first = key === undefined ? undefined : firstOf.get(key);
    if (first) { first.same.push(name); continue; }
    if (key !== undefined) firstOf.set(key, { server: name, same: [] });
    const remote = remoteMcpSpec(server) !== undefined;
    const apps = appMountFor(name, { integrations });
    if (apps && !remote) observers.set(name, new AppObserver(apps));
    const stdio = mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(remote ? { directory: { name, ...(scope ? { toolScope: scope } : {}) } } : {}), ...(apps && remote ? { apps } : {}) });
    if (!stdio) throw new Error("MCP server configuration is invalid");
    if (remote) searchable.add(name);
    servers.push([name, { command: stdio.command, args: stdio.args ?? [], env: stdio.env ?? {} }]);
  }
  for (const group of firstOf.values()) if (group.same.length) merged.push(group);
  if (servers.length > 32) throw new Error("MCP server count exceeds the 32-server limit");
  const clients: ChatMcpClient[] = [];
  const skipped: SkippedChatMcpServer[] = [];
  const trimmed: TrimmedChatMcpServer[] = [];
  const started = new Map<string, ChatMcpClient>();
  // By mount index too: a configured server may share a built-in's name, and a failed mount closes only its own client.
  const startedAt: Array<ChatMcpClient | undefined> = [];
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
  const catalog = new Map<string, RegisteredTool>();
  const directoryNames = new Map<string, string>();
  let directory: ToolDirectory | undefined;
  const budget: ToolBudget = { limit: toolLimit, listed: 0, servers: [] };
  const register = (origin: ToolOrigin, tools: readonly CheckedTool[]) => {
    const staged: Array<{ tool: RegisteredTool; definition: ChatToolDefinition }> = [];
    for (const { tool, schema, check } of tools) {
      const [listed] = schemaProfile ? fitToolList([tool], schemaProfile, (line) => console.warn(`chat-mcp: ${origin.server}: ${line}`)) : [tool];
      if (!object(listed) || !object(listed.inputSchema)) continue;
      const parameters = { ...(check === "full" ? listed.inputSchema : withoutDanglingReferences(listed.inputSchema)) };
      const constraints: Record<string, unknown> = {};
      if (computerUse) {
        for (const key of ["anyOf", "oneOf", "allOf", "not"]) {
          if (key in parameters) { constraints[key] = parameters[key]; delete parameters[key]; }
        }
      }
      const description = (typeof listed.description === "string" ? listed.description : "Configured MCP tool") +
        (Object.keys(constraints).length ? " Additional argument constraints (validated before execution): " + JSON.stringify(constraints) : "");
      const name = uniqueName(chatToolName(origin.server, tool.name), (candidate) => registered.has(candidate) || staged.some((entry) => entry.definition.function.name === candidate));
      staged.push({ tool: { ...origin, name: tool.name, schema }, definition: { type: "function", function: { name, description, parameters } } });
    }
    if (Buffer.byteLength(JSON.stringify([...definitions, ...staged.map((entry) => entry.definition)])) > CATALOG_BYTES) throw new Error("MCP tool catalog exceeds the 1MB limit");
    for (const { tool, definition } of staged) {
      registered.set(definition.function.name, tool);
      definitions.push(definition);
    }
    // Unlisted, so a call by an alias in an earlier tool call reaches the agents server, which runs it as its action
    // tool; the server holds it to that tool's full schema.
    if (origin.agents) {
      for (const [alias, { tools: targets }] of Object.entries(AGENTS_TOOL_ALIASES)) {
        const listed = staged.find((entry) => targets.includes(entry.tool.name));
        const name = chatToolName(origin.server, alias);
        if (listed && !registered.has(name)) registered.set(name, { ...listed.tool, name: alias, schema: compileToolSchema({ type: "object" }) });
      }
    }
  };
  const skip = async (server: string, error: unknown, client = started.get(server)) => {
    const reason = error instanceof Error ? error.message : "MCP server failed to start";
    skipped.push({ server, reason });
    console.warn(`chat-mcp: skipping MCP server "${server}" for this turn: ${reason}`);
    await client?.close();
  };
  const offeredTools: Array<{ origin: ToolOrigin; tools: CheckedTool[] }> = [];
  let configured: Array<{ origin: ToolOrigin; tools: CheckedTool[] }> = [];
  /** Built-ins are listed first, trimmed to their share when they alone overflow; configured servers then fill the room
   * left, and those that do not fit are reached through the tool search. */
  const layout = async (limit: number | null) => {
    definitions.length = 0;
    registered.clear();
    catalog.clear();
    directoryNames.clear();
    directory = undefined;
    trimmed.length = 0;
    Object.assign(budget, { limit, listed: 0, servers: [] });
    const room = limit === null ? Infinity : Math.max(0, limit - RUNTIME_TOOLS);
    const wanted = [...offeredTools, ...configured].reduce((sum, server) => sum + server.tools.length, 0);
    const searchRoom = configured.some((server) => server.tools.length) && wanted > room ? DIRECTORY_TOOL_COUNT : 0;
    // The agents server keeps its whole list first; configured servers fit in what the built-ins leave.
    const shares = limit === null ? undefined : shareToolBudget(offeredTools.map(({ origin, tools }, index) => ({ name: String(index), tools: tools.length, agents: origin.agents }))
      .sort((a, b) => Number(b.agents) - Number(a.agents)), room - searchRoom);
    for (const [index, { origin, tools: listed }] of offeredTools.entries()) {
      const tools = capToolList(listed, shares?.get(String(index)));
      if (tools.length < listed.length) {
        trimmed.push({ server: origin.server, listed: tools.length, of: listed.length });
        console.warn(`chat-mcp: "${origin.server}" listed ${tools.length} of ${listed.length} tools to fit the model's ${limit}-tool limit`);
      }
      register(origin, tools);
    }
    const direct = directServers(configured.map(({ origin, tools }) => ({ name: origin.server, tools: tools.length })), room - definitions.length);
    const searched: typeof configured = [];
    for (const server of configured) {
      if (signal.aborted || closed) throw aborted();
      if (!direct.has(server.origin.server)) searched.push(server);
      else {
        try { register(server.origin, server.tools); }
        catch (error) { configured = configured.filter((entry) => entry !== server); await skip(server.origin.server, error, server.origin.client); continue; }
      }
      budget.servers.push({ name: server.origin.server, tools: server.tools.length, direct: direct.has(server.origin.server) });
    }
    if (searched.length) {
      const entries: CatalogTool[] = [];
      for (const { origin, tools } of searched) {
        for (const { tool, schema } of tools) {
          const name = uniqueName(chatToolName(origin.server, tool.name), (candidate) => catalog.has(candidate));
          catalog.set(name, { ...origin, name: tool.name, schema });
          entries.push({ ...tool, name });
        }
      }
      directory = new ToolDirectory(entries, { check: (tool, args) => {
        const validate = catalog.get(tool.name)!.schema;
        return validate(args) ? undefined : schemaProblems(validate.errors);
      } });
      for (const tool of directory.listed({ server: DIRECTORY_SERVER, servers: searched.map(({ origin }) => origin.server) })) {
        const name = uniqueName(chatToolName(DIRECTORY_SERVER, tool.name as string), (candidate) => registered.has(candidate) || directoryNames.has(candidate));
        directoryNames.set(name, tool.name as string);
        definitions.push({ type: "function", function: { name, description: tool.description as string, parameters: tool.inputSchema as Record<string, unknown> } });
      }
    }
    budget.listed = definitions.length;
  };
  try {
    if (signal.aborted) throw aborted();
    // Concurrent starts, consumed in config order so names and collision suffixes stay stable.
    const mounts = await Promise.allSettled(servers.map(async ([name, descriptor], index) => {
      if (signal.aborted || closed) throw aborted();
      const client = new ChatMcpClient(descriptor, computerUse, index >= builtIns);
      clients.push(client);
      started.set(name, client);
      startedAt[index] = client;
      const computer = descriptor === integrations?.localComputer;
      const keeps = (tool: unknown) => !computer || !object(tool) || typeof tool.name !== "string" || listsComputerTool(tool.name, besideBrowser);
      const include = (tool: unknown) => keeps(tool) && (scope === undefined || (object(tool) && typeof tool.name === "string"
        && ((searchable.has(name) && isDirectoryTool(tool.name)) || allowsTool(scope, { kind: "mcp", server: name, name: tool.name }))));
      const tools = await client.tools(signal, include, searchable.has(name) ? REMOTE_MCP_STARTUP_MS : startupMs, observers.get(name));
      if (!tools.length && scope === undefined && descriptor === integrations?.localComputer) throw new Error("The Local VM listed no tools");
      // Harness mounts are known by descriptor, never by a name a configured server could claim. A grant
      // hashes the descriptor (no credential kept); machine bridges mint a bearer per turn, so theirs last a turn.
      const launch = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
      const origin: ToolOrigin = { client, server: name, launch, builtInBrowser: descriptor === integrations?.browser, agents: descriptor === agentsServer,
        hostComputer: descriptor === integrations?.localComputer && integrations?.localComputer?.scope === "local-computer", required: index < builtIns && mustHave(descriptor), searched: searchable.has(name) };
      return { origin, tools };
    }));
    for (const [index, mount] of mounts.entries()) {
      if (signal.aborted || closed) throw aborted();
      const name = servers[index]![0];
      if (mount.status === "rejected") {
        if (index >= builtIns || (OPTIONAL_BUILT_INS.has(name) && !mustHave(servers[index]![1]))) { await skip(name, mount.reason, startedAt[index]); continue; }
        throw new Error(`MCP server "${name}" didn't start: ${mount.reason instanceof Error ? mount.reason.message : "no reason given"}`);
      }
      if (index < builtIns) {
        offeredTools.push({ origin: mount.value.origin, tools: checkedTools(mount.value.tools, mount.value.origin.server) });
        continue;
      }
      try { configured.push({ origin: mount.value.origin, tools: checkedTools(mount.value.tools, mount.value.origin.server) }); }
      catch (error) { await skip(mount.value.origin.server, error, mount.value.origin.client); }
    }
    await layout(toolLimit);
    if (signal.aborted || closed) throw aborted();
  } catch (error) { await close(); throw error; }
  const target = (tool: { name: string; searched: boolean }, args: unknown) => tool.searched ? directoryCallTarget(tool.name, args) : tool.name;
  const excludes = (server: string, runs: string | undefined, runArgs: unknown) => scope !== undefined && runs !== undefined
    && !allowsTool(scope, { kind: "mcp", server, name: runs }, runArgs);
  const selectionExcludes = (tool: RegisteredTool, args: unknown) => {
    const inner = object(args) ? args.arguments ?? {} : {};
    // A directory mistake ran nothing and must not end the turn as a failed call.
    const directoryTool = tool.searched && isDirectoryTool(tool.name);
    // Security: should a bridged agents server answer here, use_tool is also judged by the tool it names.
    if (!directoryTool && (excludes(tool.server, tool.name, args ?? {}) || (tool.agents && excludes(tool.server, bridgedCallTarget(tool.name, args), inner)))) return true;
    return tool.searched && excludes(tool.server, target(tool, args), inner);
  };
  const searchedCall = (args: unknown) => {
    const call = directory && object(args) ? directory.call(args) : undefined;
    return call && !("answer" in call) ? { tool: catalog.get(call.name)!, args: call.arguments } : undefined;
  };
  const validate = (name: string, args: unknown) => {
    if (closed || signal.aborted) throw new ChatToolSessionError("MCP session closed");
    const listedAs = directoryNames.get(name);
    if (listedAs) {
      const call = listedAs === CALL_TOOL ? searchedCall(args) : undefined;
      if (call && selectionExcludes(call.tool, call.args)) throw new Error("Tool selection excludes this tool");
      if (!object(args)) throw new Error(ARGUMENTS_MISFIT);
      return;
    }
    const tool = registered.get(name);
    if (!tool) throw new Error("The requested tool was not advertised for this turn");
    if (selectionExcludes(tool, args)) throw new Error("Tool selection excludes this tool");
    omitBlankDefaults(tool.builtInBrowser, tool.name, args);
    if (!object(args) || (!(tool.searched && isDirectoryTool(tool.name)) && !tool.schema(args))) {
      throw new Error(readsAddressOnly(tool, args) ? readOpenPageOnly(tool.server) : ARGUMENTS_MISFIT);
    }
  };
  const viewOf = (tool: RegisteredTool, args: Record<string, unknown>, title: string): ChatToolCallView => {
    const runs = target(tool, args);
    if (runs === undefined || tool.agents) return { title, input: args, ask: false };
    const grant = !tool.hostComputer ? JSON.stringify([tool.server, tool.launch, runs]) : undefined;
    if (!tool.searched || tool.name !== CALL_TOOL) return { title, input: args, ask: true, ...(grant ? { grant } : {}) };
    return { title: chatToolName(tool.server, runs), input: object(args.arguments) ? args.arguments : {}, ask: true, ...(grant ? { grant } : {}) };
  };
  const view = (name: string, args: Record<string, unknown>): ChatToolCallView => {
    if (directoryNames.has(name)) {
      const call = directoryNames.get(name) === CALL_TOOL ? searchedCall(args) : undefined;
      return call ? viewOf(call.tool, call.args, chatToolName(call.tool.server, call.tool.name)) : { title: name, input: args, ask: false };
    }
    const tool = registered.get(name);
    return tool ? viewOf(tool, args, name) : { title: name, input: args, ask: true };
  };
  const run = async (tool: RegisteredTool, args: Record<string, unknown>, callSignal: AbortSignal): Promise<ChatToolResult> => {
    try {
      const result = await tool.client.call("tools/call", { name: tool.name, arguments: args }, AbortSignal.any([signal, callSignal]), callTimeoutMs, true);
      if (signal.aborted || callSignal.aborted) throw aborted();
      if (!object(result) || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new Error("MCP tool returned an invalid result; execution outcome may be uncertain");
      observers.get(tool.server)?.returned({ name: tool.name, arguments: args }, result);
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
      const body = parts.join("\n") || (images.length ? "Screenshot captured." : "(empty result)");
      const hint = tool.builtInBrowser ? loopbackNavigationHint(tool.name, args, body) : "";
      return { text: await savedOrBounded(body, chatToolName(tool.server, tool.name), resultFolder, scrub) + hint, ok: result.isError !== true && unsupported === 0,
        ...(images.length ? { images } : {}) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "MCP transport failed; execution outcome may be uncertain";
      if (signal.aborted || callSignal.aborted || tool.required) {
        await close();
        throw new ChatToolSessionError(reason);
      }
      // The server answered and said no, so it stays. Any other failure ends that server for this turn, so a call whose
      // outcome is uncertain can't run twice on it, and every other server carries on.
      if (error instanceof McpRequestRefused) return { ok: false, text: `${reason} That was the MCP server "${tool.server}".` };
      console.warn(`chat-mcp: MCP server "${tool.server}" stopped for this turn: ${reason}`);
      await tool.client.close().catch(() => {});
      return { ok: false, text: `${reason} That was the MCP server "${tool.server}". It is stopped for the rest of this turn; your other tools still work.` };
    }
  };
  const answer = (result: DirectoryResult): ChatToolResult => ({ text: boundedText(result.content.map((part) => part.text).join("\n")), ok: result.isError !== true });
  return {
    definitions, skipped, trimmed, merged, budget, validate, view, close,
    async refit(limit) {
      if (closed || signal.aborted) throw new ChatToolSessionError("MCP session closed");
      await layout(limit);
    },
    async execute(name, args, callSignal) {
      validate(name, args);
      if (callSignal.aborted) { await close(); throw aborted(); }
      const listedAs = directoryNames.get(name);
      if (!listedAs) return run(registered.get(name)!, args, callSignal);
      if (listedAs === SEARCH_TOOL) return answer(await directory!.search(args));
      if (listedAs === DESCRIBE_TOOL) return answer(directory!.describe(args));
      const call = directory!.call(args);
      return "answer" in call ? answer(call.answer) : run(catalog.get(call.name)!, call.arguments, callSignal);
    },
  };
}
