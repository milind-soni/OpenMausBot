// The upstream handshake is OMB's own, never the engine's: an engine's client adds capability fields a strict server
// refuses. stdout carries only protocol frames.
import { createInterface } from "node:readline";
import { redactSecretsInText } from "../shared/redact.ts";
import { allowsTool, parseToolScope, type ToolScope } from "../shared/tool-scope.ts";

import type { ValidateFunction } from "ajv";
import {
  CALL_TOOL,
  DESCRIBE_TOOL,
  INSTRUCTIONS_CHARS,
  SEARCH_TOOL,
  SELECTION_EXCLUDES,
  ToolDirectory,
  bounded,
  searchesCatalog,
  type CatalogTool,
  type DirectoryContext,
} from "./mcp-directory.ts";
import {
  MAX_REMOTE_MCP_BYTES,
  McpHttpError,
  McpRpcError,
  REMOTE_MCP_CONFIG_ENV,
  RemoteMcpClient,
  plainHttpProxyFetch,
  remoteMcpSpec,
} from "./mcp-http.ts";
import { APP_ONLY_REFUSAL, AppObserver, REMOTE_MCP_APPS_ENV, UI_EXTENSION, modelVisible, parseAppMount } from "./mcp-app-observer.ts";
import { lenientToolValidator, schemaProblems } from "./mcp-schema-validator.ts";
import { fitToolListResult } from "./mcp-tool-schema.ts";
import { toolSchemaProfileFromEnv } from "./tool-schema-profile.ts";
import { capToolListResult, toolLimitFromEnv } from "./tool-count-limit.ts";
import { APP_EXTENSION_KEY } from "../shared/app.ts";

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function requestKey(id: unknown): string | undefined {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? `${typeof id}:${id}` : undefined;
}
function send(frame: unknown): void { process.stdout.write(`${JSON.stringify(frame)}\n`); }
function error(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id: requestKey(id) ? id : null, error: { code, message } });
}
function fail(message: string): never {
  process.stderr.write(`mcp-remote-proxy: ${message}\n`);
  process.exit(1);
}

const CREDENTIALS_REFUSED = "This MCP server refused its credentials (HTTP 401). If it uses a sign-in, send the message again: "
  + "OpenMausBot refreshes sign-ins when a message starts. If it still fails, open Plugins → MCP servers and sign in to it again, "
  + "or check its header values.";

/** A refusal of our own: its words carry nothing remote, so they are relayed. */
class Refusal extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const SETTINGS = ["OMB_REMOTE_MCP_SERVER", "OMB_REMOTE_MCP_DIRECTORY", REMOTE_MCP_APPS_ENV];
/** Codex hands every MCP child one shared environment, so a mount names its own record; settings leave this env once read. */
function privateSettings(): Record<string, string | undefined> {
  if (process.argv.length === 2) {
    const settings = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
    for (const name of SETTINGS) delete process.env[name];
    return settings;
  }
  const key = process.argv[3];
  if (process.argv.length !== 4 || process.argv[2] !== "--config-env" || !key || !REMOTE_MCP_CONFIG_ENV.test(key)) return {};
  const raw = process.env[key];
  delete process.env[key];
  try {
    const value: unknown = JSON.parse(raw ?? "");
    if (isRecord(value) && Object.entries(value).every(([name, setting]) => SETTINGS.includes(name) && typeof setting === "string")) {
      return value as Record<string, string>;
    }
  } catch {}
  return {};
}

const settings = privateSettings();
let spec;
try { spec = remoteMcpSpec(JSON.parse(settings.OMB_REMOTE_MCP_SERVER ?? "")); } catch {}
if (!spec) fail("invalid remote MCP configuration");

/** A selection that cannot be read must never widen to all tools. */
function directorySettings(raw: string | undefined): { server: string; scope: ToolScope | undefined } | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && typeof value.name === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value.name)
      && Object.keys(value).every((key) => key === "name" || key === "toolScope")) {
      const parsed = parseToolScope(value.toolScope);
      if (parsed.ok) return { server: value.name, scope: parsed.scope };
    }
  } catch {}
  return fail("invalid tool directory configuration");
}
const directory = directorySettings(settings.OMB_REMOTE_MCP_DIRECTORY);
const observer = (() => {
  try {
    const mount = parseAppMount(settings[REMOTE_MCP_APPS_ENV]);
    return mount ? new AppObserver(mount, { log: (line) => process.stderr.write(`mcp-remote-proxy: ${line}\n`) }) : undefined;
  } catch { return fail("invalid MCP apps configuration"); }
})();
const HANDSHAKE = observer?.mount.extension ? { extensions: { [APP_EXTENSION_KEY]: UI_EXTENSION } } : {};
const appOnly = new Set<string>();
const SCHEMA_PROFILE = toolSchemaProfileFromEnv(process.env);
const TOOL_LIMIT = toolLimitFromEnv(process.env);
const logFit = (line: string) => { process.stderr.write(`mcp-remote-proxy: ${line}\n`); };

const REMOTE_ERROR_CHARS = 1_000;
/** Configured values (address parts, header values) a remote error must never echo. */
const configured: string[] = (() => {
  const values = new Set<string>([spec.url]);
  try {
    const url = new URL(spec.url);
    values.add(url.href);
    values.add(`${url.origin}${url.pathname}`);
    if (url.pathname.length > 1) values.add(url.pathname);
    for (const segment of url.pathname.split("/")) if (segment.length >= 16) values.add(segment);
    for (const value of url.searchParams.values()) if (value.length >= 4) values.add(value);
  } catch {}
  for (const value of Object.values(spec.headers)) {
    if (value.trim().length >= 4) values.add(value.trim());
    for (const word of value.split(/\s+/)) if (word.length >= 8) values.add(word);
  }
  return [...values].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
})();
function remoteErrorText(detail: string): string {
  let text = detail.slice(0, REMOTE_ERROR_CHARS * 8);
  for (const value of configured) text = text.split(value).join("«redacted»");
  text = redactSecretsInText(text).trim();
  if (text.length > REMOTE_ERROR_CHARS) text = `${text.slice(0, REMOTE_ERROR_CHARS - 1)}…`;
  return text || "Remote MCP request failed";
}
/** What a refused HTTP request means, in words a person can act on. The status code itself carries no secret. */
function remoteStatusText(status: number | undefined): string {
  if (status === 403) {
    return "This MCP server refused the request (HTTP 403). Its sign-in may be missing a permission (scope) it needs, "
      + "or the service may not be turned on for that account or project.";
  }
  if (status === 404) return "This MCP server's address was not found (HTTP 404). Check its URL in Plugins → MCP servers.";
  if (status === 429) return "This MCP server is limiting requests right now (HTTP 429). Try again in a moment.";
  if (status !== undefined && status >= 500) return `This MCP server had a problem on its side (HTTP ${status}). Try again later.`;
  return status === undefined ? "Remote MCP request failed" : `Remote MCP request failed (HTTP ${status})`;
}
const allowed = (name: string) => !directory?.scope || allowsTool(directory.scope, { kind: "mcp", server: directory.server, name });

interface Catalog { tools: ToolDirectory; searched: boolean }
const CATALOG_PAGES = 100;
const CATALOG_MS = 120_000;
let catalog: Catalog | undefined;
let loading: Promise<Catalog> | undefined;
let generation = 0;
/** Once searched, always searched: the engine was handed call_tool, and a tool it found must stay reachable. */
let searching = false;
const context: DirectoryContext = { server: directory?.server ?? "" };

const closed = new AbortController();
const viaProxy = plainHttpProxyFetch(process.env);
const client = new RemoteMcpClient(spec, {
  maxBytes: MAX_REMOTE_MCP_BYTES,
  ...(viaProxy ? { fetch: viaProxy } : {}),
  onNotification: (message) => {
    if (directory && message.method === "notifications/tools/list_changed") {
      generation += 1;
      catalog = undefined;
      loading = undefined;
    }
    send(message);
  },
});
const pending = new Map<string, AbortController>();
const tasks = new Set<Promise<void>>();
let initialized = false;
let closing = false;

/** A tool only an MCP app's view may call is never listed to the engine, and a call to it is refused. */
async function upstream(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
  if (method === "initialize") {
    const result = await client.initialize("OpenMausBot tool proxy", signal, HANDSHAKE);
    if (client.extensions === "refused") process.stderr.write("mcp-remote-proxy: the server refused the MCP Apps extension; connected without it\n");
    observer?.initialized(result);
    return result;
  }
  if (method === "tools/call" && isRecord(params) && appOnly.has(params.name as string)) throw new Refusal(-32602, APP_ONLY_REFUSAL);
  const result = await client.request(method, params, signal);
  if (method === "tools/list" && isRecord(result) && Array.isArray(result.tools)) {
    observer?.listed(result);
    for (const tool of result.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") continue;
      if (modelVisible(tool)) appOnly.delete(tool.name);
      else appOnly.add(tool.name);
    }
    return { ...result, tools: result.tools.filter(modelVisible) };
  }
  if (method === "tools/call") observer?.returned(params, result);
  return result;
}

/** Under its own deadline, so a cancelled first request does not cancel the read for the next one. */
async function readCatalog(): Promise<CatalogTool[]> {
  const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(CATALOG_MS)]);
  const tools: CatalogTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < CATALOG_PAGES; page += 1) {
    const result = await upstream("tools/list", cursor === undefined ? {} : { cursor }, signal);
    if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error("invalid tool catalog");
    for (const tool of result.tools) {
      if (isRecord(tool) && typeof tool.name === "string" && tool.name.trim()) tools.push(tool as CatalogTool);
    }
    const next = result.nextCursor;
    if (next === undefined || next === null || next === "") return tools;
    if (typeof next !== "string" || cursors.has(next)) throw new Error("invalid catalog cursor");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("tool catalog has too many pages");
}

const validators = new WeakMap<CatalogTool, ValidateFunction | null>();
function argumentProblems(tool: CatalogTool, args: Json): string[] | undefined {
  let validate = validators.get(tool);
  if (validate === undefined) {
    validate = lenientToolValidator(tool.inputSchema);
    validators.set(tool, validate);
  }
  if (!validate) return undefined;
  try { return validate(args) ? undefined : schemaProblems(validate.errors); }
  catch { return undefined; }
}

function raced<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function currentCatalog(signal: AbortSignal): Promise<Catalog> {
  if (catalog) return Promise.resolve(catalog);
  if (!loading) {
    const started = generation;
    const read = readCatalog().then((upstream) => {
      const tools = new ToolDirectory(upstream.filter((tool) => allowed(tool.name)), {
        withheld: upstream.filter((tool) => !allowed(tool.name)).map((tool) => tool.name),
        check: argumentProblems,
      });
      searching ||= searchesCatalog(tools.tools);
      const built = { tools, searched: searching };
      if (generation === started) catalog = built;
      return built;
    });
    loading = read;
    void read.catch(() => {}).finally(() => { if (loading === read) loading = undefined; });
  }
  return raced(loading, signal);
}

async function callTool(params: unknown, signal: AbortSignal): Promise<unknown> {
  if (!isRecord(params) || typeof params.name !== "string" || (params.arguments !== undefined && !isRecord(params.arguments))) {
    throw new Refusal(-32602, "Invalid tool call");
  }
  if (params.name === SEARCH_TOOL) return (await currentCatalog(signal)).tools.search(params.arguments);
  if (params.name === DESCRIBE_TOOL) return (await currentCatalog(signal)).tools.describe(params.arguments);
  if (params.name === CALL_TOOL) {
    const call = (await currentCatalog(signal)).tools.call(params.arguments);
    if ("answer" in call) return call.answer;
    if (!allowed(call.name)) return { content: [{ type: "text", text: SELECTION_EXCLUDES }], isError: true };
    return upstream("tools/call", { ...(isRecord(params._meta) ? { _meta: params._meta } : {}), name: call.name, arguments: call.arguments }, signal);
  }
  if (!allowed(params.name)) throw new Refusal(-32602, SELECTION_EXCLUDES);
  return upstream("tools/call", params, signal);
}

async function directed(message: Json, signal: AbortSignal): Promise<unknown> {
  if (message.method === "initialize") {
    const result = await upstream("initialize", undefined, signal);
    if (!isRecord(result)) return result;
    const info = isRecord(result.serverInfo) ? result.serverInfo : {};
    const title = typeof info.title === "string" ? info.title : typeof info.name === "string" ? info.name : undefined;
    if (title) context.title = title;
    if (typeof result.instructions !== "string") return result;
    context.instructions = result.instructions;
    return { ...result, instructions: bounded(result.instructions, INSTRUCTIONS_CHARS) };
  }
  if (message.method === "tools/list") {
    if (isRecord(message.params) && message.params.cursor !== undefined) throw new Refusal(-32602, "Invalid cursor");
    const { tools, searched } = await currentCatalog(signal);
    return { tools: searched ? tools.listed(context) : tools.tools };
  }
  if (message.method === "tools/call") return callTool(message.params, signal);
  return upstream(message.method as string, message.params, signal);
}

async function handle(message: Json): Promise<void> {
  const id = requestKey(message.id);
  if (typeof message.method !== "string" || message.jsonrpc !== "2.0") {
    error(message.id, -32600, "Invalid JSON-RPC request");
    return;
  }
  if (message.method === "notifications/cancelled") {
    const key = isRecord(message.params) ? requestKey(message.params.requestId) : undefined;
    if (key) pending.get(key)?.abort();
    return;
  }
  if (!id) {
    if (message.method === "notifications/initialized" && initialized) return;
    try { await client.notify(message.method, message.params, AbortSignal.timeout(30_000)); }
    catch {}
    return;
  }
  if (pending.has(id)) { error(message.id, -32600, "Duplicate request ID"); return; }
  const controller = new AbortController();
  pending.set(id, controller);
  // Engines keep their own tool-call deadline (Gemini CLI and Qwen Code wait ten minutes) and cancel through this proxy.
  const deadline = message.method !== "tools/call" ? 30_000 : directory ? 120_000 : undefined;
  const signal = deadline === undefined ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(deadline)]);
  try {
    const result = directory ? await directed(message, signal) : await upstream(message.method, message.params, signal);
    if (message.method === "initialize") initialized = true;
    send({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? capToolListResult(fitToolListResult(result, SCHEMA_PROFILE, logFit), TOOL_LIMIT, logFit) : result });
  } catch (failure) {
    // Transport failures may carry URLs or header values: never relayed.
    if (failure instanceof Refusal) error(message.id, failure.code, failure.message);
    else if (failure instanceof McpRpcError) error(message.id, failure.code ?? -32603, remoteErrorText(failure.detail));
    else if (failure instanceof McpHttpError && failure.status === 401) error(message.id, -32603, CREDENTIALS_REFUSED);
    else if (failure instanceof McpHttpError && failure.kind === "status" && !signal.aborted) error(message.id, -32603, remoteStatusText(failure.status));
    else if (failure instanceof McpHttpError && failure.kind === "network" && failure.message === "request failed" && !signal.aborted) error(message.id, -32603, "Could not reach this MCP server. Check its URL and that it is online.");
    else error(message.id, signal.aborted ? -32800 : -32603, signal.aborted ? "MCP request cancelled" : "Remote MCP request failed");
  } finally { pending.delete(id); }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (closing || !line.trim()) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { error(null, -32700, "Invalid JSON-RPC frame"); return; }
  if (!isRecord(value)) { error(null, -32600, "Invalid JSON-RPC frame"); return; }
  const task = handle(value);
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
});
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  input.close();
  for (const controller of pending.values()) controller.abort();
  closed.abort();
  await Promise.allSettled(tasks);
  await client.close();
  process.exit(0);
}
input.on("close", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
