// stdout is the MCP transport. Never log there.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { allowsTool, parseToolScope, type ToolScope } from "../shared/tool-scope.ts";

import { bridgedCallTarget } from "./drivers/agents-bridge.ts";
import { resolveCliSpawn } from "./env-path.ts";
import { APP_ONLY_REFUSAL, AppObserver, GATE_APPS_ENV, modelVisible, parseAppMount, withUiExtension } from "./mcp-app-observer.ts";
import { directoryCallTarget, isDirectoryTool } from "./mcp-directory.ts";
import { QUERY_TOOL, QUERY_TOOL_NAME, ResultStore, answerQuery, describeShape, exampleQuery } from "./mcp-shape.ts";
import { fitToolList } from "./mcp-tool-schema.ts";
import { DEFAULT_RESULT_BUDGET, type HeldResult, trimResultText, trimStructured } from "./mcp-trim.ts";
import { killCliTree } from "./procs.ts";
import { toolSchemaProfileFromEnv } from "./tool-schema-profile.ts";

type Json = Record<string, unknown>;

/** Codex imports env from one shared app-server environment: each mount names its own record, and only that name reaches argv. */
function gateEnvironment(): NodeJS.ProcessEnv {
  if (process.argv.length === 2) return process.env;
  try {
    const key = process.argv[3];
    if (process.argv.length !== 4 || process.argv[2] !== "--config-env" || !key || !/^OMB_GATE_CONFIG_[a-f0-9]{64}$/.test(key)) throw new Error();
    const value = JSON.parse(process.env[key] ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !["OMB_GATE_NAME", "OMB_GATE_UPSTREAM"].every(name => typeof value[name] === "string")
      || (typeof value.OMB_GATE_TOOL_SCOPE !== "string" && typeof value[GATE_APPS_ENV] !== "string")
      || !Object.entries(value).every(([name, setting]) => GATE_ENV_KEYS.includes(name) && typeof setting === "string")) throw new Error();
    return value;
  } catch {
    process.stderr.write("mcp-gate: invalid private configuration\n"); process.exit(1);
  }
}
/** The gate's own settings never reach the upstream server's environment. */
const GATE_ENV_KEYS = ["OMB_GATE_NAME", "OMB_GATE_SPILL_DIR", "OMB_GATE_BUDGET", "OMB_GATE_UPSTREAM", "OMB_GATE_SPILL_HINT", "OMB_GATE_TOOL_SCOPE", "OMB_GATE_DIRECTORY", GATE_APPS_ENV];
const gateEnv = gateEnvironment();
const NAME = gateEnv.OMB_GATE_NAME || "mcp";
const SPILL_DIR = gateEnv.OMB_GATE_SPILL_DIR || "";
const rawBudget = Number(gateEnv.OMB_GATE_BUDGET);
const BUDGET = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : DEFAULT_RESULT_BUDGET;
const SPILL_MAX_AGE_MS = 24 * 60 * 60_000;
const SPILL_HINT = gateEnv.OMB_GATE_SPILL_HINT === "1";
const DIRECTORY = gateEnv.OMB_GATE_DIRECTORY === "1";
const SCHEMA_PROFILE = toolSchemaProfileFromEnv(process.env);

function fail(message: string): never {
  process.stderr.write(`mcp-gate(${NAME}): ${message}\n`);
  process.exit(1);
}

function toolScope(): ToolScope | undefined {
  const raw = gateEnv.OMB_GATE_TOOL_SCOPE;
  if (raw === undefined) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("invalid tool selection JSON"); }
  const parsed = parseToolScope(value);
  if (!parsed.ok || parsed.scope === undefined) fail("invalid tool selection; check the bot's Access settings");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(NAME)) fail("invalid MCP server identity for tool selection");
  return parsed.scope;
}

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requestKey(id: unknown): string | undefined {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
    ? `${typeof id}:${id}` : undefined;
}

function rejectRequest(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestKey(id) ? id : null, error: { code, message } })}\n`);
}

interface Upstream {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function upstreamSpec(): Upstream {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gateEnv.OMB_GATE_UPSTREAM ?? "");
  } catch {
    fail("OMB_GATE_UPSTREAM is not valid JSON");
  }
  const spec = parsed as Upstream | null;
  if (!spec || typeof spec !== "object" || typeof spec.command !== "string" || !spec.command) {
    fail("OMB_GATE_UPSTREAM needs a command");
  }
  return spec;
}

function sweepSpill(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SPILL_MAX_AGE_MS;
  for (const entry of entries) {
    try {
      const path = join(dir, entry);
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
    }
  }
}

let spilled = 0;
/** Whole results the model can query instead of re-reading: one gate, one MCP connection, one session. */
const store = new ResultStore();

/** Keep the parsed payload for query_result; only a JSON result can be queried, text is cut as before. */
function hold(tool: string, text: string): HeldResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const handle = store.put(tool, value, text.length);
  return { handle, shape: describeShape(value), example: exampleQuery(value) };
}

function spill(tool: string, text: string): string | undefined {
  if (!SPILL_DIR) return undefined;
  const safeTool = tool.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60) || "tool";
  const path = join(SPILL_DIR, `${Date.now()}-${process.pid}-${spilled++}-${safeTool}.json`);
  try {
    mkdirSync(SPILL_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  } catch (error) {
    process.stderr.write(`mcp-gate(${NAME}): could not save the full result: ${String(error)}\n`);
    return undefined;
  }
}

/** Object key order aside (a server may build the two copies differently); array order counts. */
function sameJson(text: string, value: unknown): boolean {
  try {
    return sameValue(JSON.parse(text), value, 0);
  } catch {
    return false;
  }
}

function sameValue(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (depth > 200 || !a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i], depth + 1));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key], depth + 1));
}

function trimCallResult(result: Json, tool: string): boolean {
  if (BUDGET === 0) return false;
  const content = result.content;
  if (!Array.isArray(content)) return false;

  const textBlocks = content.filter(
    (block): block is Json & { text: string } =>
      Boolean(block) && typeof block === "object" && (block as Json).type === "text" && typeof (block as Json).text === "string",
  );
  const total = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
  if (!textBlocks.length || total <= BUDGET) return false;

  const share = Math.floor(BUDGET / textBlocks.length);
  const path = spill(tool, textBlocks.map((block) => block.text).join("\n"));
  const held = textBlocks.length === 1 ? hold(tool, textBlocks[0]!.text) : undefined;
  const structuredIsText = textBlocks.length === 1 && Boolean(result.structuredContent) && typeof result.structuredContent === "object"
    && sameJson(textBlocks[0]!.text, result.structuredContent);
  let trimmed = false;
  let keptValue: unknown;
  for (const block of textBlocks) {
    const outcome = trimResultText({ text: block.text, budget: share, spillPath: path, spillHint: SPILL_HINT, toolName: tool, held });
    if (!outcome.trimmed) continue;
    block.text = outcome.text;
    keptValue = outcome.value;
    trimmed = true;
  }

  // Trim structuredContent too, or the provider gets a second full copy; structurally only, so it stays valid against the output schema.
  if (trimmed && result.structuredContent && typeof result.structuredContent === "object") {
    if (structuredIsText && keptValue && typeof keptValue === "object") {
      result.structuredContent = keptValue as Json;
    } else {
      const structured = trimStructured(result.structuredContent, BUDGET);
      if (structured) result.structuredContent = structured.value as Json;
    }
  }
  return trimmed;
}

// Validate before starting a process: corrupt policy must never become pass-through.
const scope = toolScope();
const observer = (() => {
  try {
    const mount = parseAppMount(gateEnv[GATE_APPS_ENV]);
    return mount ? new AppObserver(mount, { log: (line) => process.stderr.write(`mcp-gate(${NAME}): ${line}\n`) }) : undefined;
  } catch { return fail("invalid MCP apps configuration"); }
})();
const appOnly = new Set<string>();
const spec = upstreamSpec();
if (SPILL_DIR) sweepSpill(SPILL_DIR);

const childEnv: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
for (const key of Object.keys(childEnv)) if (key.startsWith("OMB_GATE_")) delete childEnv[key];

// CreateProcess cannot exec an npm .cmd shim or a node-shebang script, and a shell would re-interpret JSON argv.
const resolved = resolveCliSpawn(spec.command, spec.args ?? []);
const child = spawn(resolved.command, resolved.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
  shell: false,
  // a console app spawned from the desktop shell flashes a window otherwise
  ...(process.platform === "win32" ? { windowsHide: true } : {}),
});

// The real server must not outlive a killed gate, and on Windows only taskkill /T reaps a tree.
let reaping = false;
const reapChild = () => {
  if (reaping) return;
  reaping = true;
  void killCliTree(child);
};
process.on("SIGTERM", () => {
  reapChild();
  process.exit(0);
});
process.on("SIGINT", () => {
  reapChild();
  process.exit(0);
});
process.on("exit", reapChild);

child.on("error", (error) => {
  process.stderr.write(`mcp-gate(${NAME}): could not start ${resolved.command}: ${String(error)}\n`);
  process.exit(1);
});
child.stderr.pipe(process.stderr);

type Pending =
  | { kind: "call"; tool: string; trim: boolean; params?: Json }
  | { kind: "list" | "other" }
  | { kind: "initialize"; original?: string };

function callTarget(name: string, args: unknown): string | undefined {
  return DIRECTORY ? directoryCallTarget(name, args) : name;
}
/** JSON-RPC string and numeric IDs are separate, even when their text is equal. */
const pending = new Map<string, Pending>();

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: Json | undefined;
  if (line.trim()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) message = parsed;
    } catch {
      if (scope) return rejectRequest(null, -32700, "Invalid JSON-RPC frame");
    }
    if (scope && (!message || message.jsonrpc !== "2.0")) return rejectRequest(message?.id, -32600, "Invalid JSON-RPC frame");
  }
  const id = requestKey(message?.id);
  const params = isRecord(message?.params) ? message.params : undefined;
  // The gate's own read-only tool: it reads a held result and never reaches upstream, so no selection or app rule applies.
  if (BUDGET > 0 && message?.method === "tools/call" && params?.name === QUERY_TOOL_NAME) {
    if (!id) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answerQuery(store, params.arguments, BUDGET) })}\n`);
    return;
  }
  if (scope && message?.method === "tools/call") {
    if (!id || typeof params?.name !== "string"
      || (params.arguments !== undefined && !isRecord(params.arguments))) {
      return rejectRequest(message.id, -32602, "Invalid tool call");
    }
    // Security: should a bridged agents server answer here, use_tool is also judged by the tool it names.
    const targets = [callTarget(params.name, params.arguments), ...(NAME === "agents" ? [bridgedCallTarget(params.name, params.arguments)] : [])];
    if (targets.some((target) => target !== undefined && !allowsTool(scope, { kind: "mcp", server: NAME, name: target }))) {
      return rejectRequest(message.id, -32602, "Tool selection excludes this tool. Check the bot's Access settings.");
    }
  }
  if (message?.method === "tools/call" && typeof params?.name === "string") {
    const target = callTarget(params.name, params.arguments);
    if (target !== undefined && appOnly.has(target)) return rejectRequest(message.id, -32602, APP_ONLY_REFUSAL);
  }
  if (scope && message?.method === "tools/list" && !id) {
    return rejectRequest(message.id, -32600, "Tool listing needs a request ID");
  }
  if (id && typeof message?.method === "string") {
    if (scope && pending.has(id)) fail("duplicate request ID on a restricted connection");
    if (message.method === "tools/call") {
      const name = typeof params?.name === "string" ? params.name : "tool";
      const target = callTarget(name, params?.arguments);
      pending.set(id, { kind: "call", tool: target ?? name, trim: target !== undefined, ...(observer && params ? { params } : {}) });
    } else if (message.method === "initialize" && observer) {
      if (observer.mount.extension) {
        pending.set(id, { kind: "initialize", original: line });
        return child.stdin.write(`${JSON.stringify({ ...message, params: withUiExtension(message.params) })}\n`);
      }
      pending.set(id, { kind: "initialize" });
    } else if (message.method === "tools/list" || scope) {
      pending.set(id, { kind: message.method === "tools/list" ? "list" : "other" });
    }
  }
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let message: Json | undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) message = parsed;
  } catch {
    if (scope) fail("unreadable upstream frame on a restricted connection");
  }
  if (!message || (scope && message.jsonrpc !== "2.0")) {
    if (scope) fail("invalid upstream frame on a restricted connection");
    process.stdout.write(`${line}\n`);
    return;
  }
  const id = typeof message.method === "string" ? undefined : requestKey(message.id);
  const request = id === undefined ? undefined : pending.get(id);
  if (scope && id !== undefined && !request) fail("unrequested upstream response on a restricted connection");
  if (request?.kind === "initialize" && request.original && message.error !== undefined && id !== undefined) {
    pending.set(id, { kind: "initialize" });
    process.stderr.write(`mcp-gate(${NAME}): the server refused the MCP Apps extension; connecting without it\n`);
    child.stdin.write(`${request.original}\n`);
    return;
  }
  if (id !== undefined) pending.delete(id);
  const result = message.result;
  if (request?.kind === "initialize") observer?.initialized(result);
  // A tool only an MCP app's view may call is never listed to the model, and a call to it is refused.
  if (request?.kind === "list" && message.error === undefined && isRecord(result) && Array.isArray(result.tools)) {
    observer?.listed(result);
    for (const tool of result.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") continue;
      if (modelVisible(tool)) appOnly.delete(tool.name);
      else appOnly.add(tool.name);
    }
    result.tools = result.tools.filter(modelVisible);
  }
  if (scope && request?.kind === "list" && message.error === undefined) {
    if (!isRecord(result) || !Array.isArray(result.tools)
      || !result.tools.every((tool: unknown) => isRecord(tool) && typeof tool.name === "string" && tool.name.trim().length > 0)
      || (result.nextCursor !== undefined && typeof result.nextCursor !== "string")) {
      return rejectRequest(message.id, -32603, "Invalid tool catalog on a restricted connection");
    }
    result.tools = result.tools.filter((tool: Json) => (DIRECTORY && isDirectoryTool(tool.name))
      || allowsTool(scope, { kind: "mcp", server: NAME, name: tool.name as string }));
  }
  if (SCHEMA_PROFILE && request?.kind === "list" && message.error === undefined && isRecord(result) && Array.isArray(result.tools)) {
    result.tools = fitToolList(result.tools, SCHEMA_PROFILE, (note) => process.stderr.write(`mcp-gate(${NAME}): ${note}\n`));
  }
  if (BUDGET > 0 && request?.kind === "list" && message.error === undefined && isRecord(result) && Array.isArray(result.tools) && result.nextCursor === undefined) {
    result.tools = [...result.tools.filter((tool: unknown) => !isRecord(tool) || tool.name !== QUERY_TOOL_NAME), QUERY_TOOL];
  }
  if (request?.kind === "call" && observer && message.error === undefined) observer.returned(request.params, result);
  if (request?.kind === "call" && request.trim && isRecord(result)) {
    try {
      if (trimCallResult(result, request.tool)) {
        process.stderr.write(`mcp-gate(${NAME}): trimmed ${request.tool} to ${BUDGET} chars\n`);
      }
    } catch (error) {
      process.stderr.write(`mcp-gate(${NAME}): could not trim ${request.tool}: ${String(error)}\n`);
      process.stdout.write(`${line}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
