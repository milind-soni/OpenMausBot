// A pass-through MCP server that keeps one tool result from eating a
// conversation.
//
// The provider CLI mounts this instead of the bot's real MCP server. Every
// JSON-RPC frame is relayed in both directions. With a tool selection, discovery
// is filtered and excluded calls are rejected before upstream execution.
// An oversized `tools/call` result is cut to a budget (mcp-trim.ts), the
// untrimmed text is written to a file, and the model is told in the result
// where that file is so it can read or grep the rest with its ordinary tools.
//
// Why here and not in the driver: on every vendor-CLI engine the tool call and
// its result never pass through the harness at all. The CLI runs the server
// itself and appends the raw answer to the session it owns. Standing between
// the two processes is the only place the harness can see, or shrink, what a
// tool puts into the model's context.
//
// stdout is the MCP transport. Never log there.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { allowsTool, parseToolScope, type ToolScope } from "../shared/tool-scope.ts";

import { resolveCliSpawn } from "./env-path.ts";
import { directoryCallTarget, isDirectoryTool } from "./mcp-directory.ts";
import { DEFAULT_RESULT_BUDGET, trimResultText, trimStructured } from "./mcp-trim.ts";
import { killCliTree } from "./procs.ts";

type Json = Record<string, unknown>;

/** Codex imports env variables from one shared app-server environment. Each
 * mount names its own private record; only the variable name reaches argv. */
function gateEnvironment(): NodeJS.ProcessEnv {
  if (process.argv.length === 2) return process.env;
  try {
    const key = process.argv[3];
    if (process.argv.length !== 4 || process.argv[2] !== "--config-env" || !key || !/^OMB_GATE_CONFIG_[a-f0-9]{64}$/.test(key)) throw new Error();
    const value = JSON.parse(process.env[key] ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !["OMB_GATE_NAME", "OMB_GATE_UPSTREAM", "OMB_GATE_TOOL_SCOPE"].every(name => typeof value[name] === "string")
      || !Object.entries(value).every(([name, setting]) => GATE_ENV_KEYS.includes(name) && typeof setting === "string")) throw new Error();
    return value;
  } catch {
    process.stderr.write("mcp-gate: invalid private configuration\n"); process.exit(1);
  }
}
/** The gate's own settings never reach the upstream server's environment. */
const GATE_ENV_KEYS = ["OMB_GATE_NAME", "OMB_GATE_SPILL_DIR", "OMB_GATE_BUDGET", "OMB_GATE_UPSTREAM", "OMB_GATE_SPILL_HINT", "OMB_GATE_TOOL_SCOPE", "OMB_GATE_DIRECTORY"];
const gateEnv = gateEnvironment();
const NAME = gateEnv.OMB_GATE_NAME || "mcp";
const SPILL_DIR = gateEnv.OMB_GATE_SPILL_DIR || "";
const rawBudget = Number(gateEnv.OMB_GATE_BUDGET);
const BUDGET = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : DEFAULT_RESULT_BUDGET;
/** Spilled results older than this are swept at startup: they exist for the
 * turn that produced them, not forever. */
const SPILL_MAX_AGE_MS = 24 * 60 * 60_000;
/** Whether the model is told where the untrimmed result was saved. Off by
 * default: offering the path measured WORSE than no trimming, because the
 * model reads the file back in. See TrimInput.spillHint. */
const SPILL_HINT = gateEnv.OMB_GATE_SPILL_HINT === "1";
/** The upstream is the remote proxy with its tool directory on
 * (mcp-directory.ts). Its search_tools and describe_tool only read a catalog
 * the proxy has already narrowed to this selection, so they pass, untrimmed:
 * the directory bounds them itself, and a schema cut short is no schema.
 * call_tool is checked, and trimmed, as the tool it runs; one naming no tool
 * runs nothing and is answered by the directory. The proxy guarantees those
 * three names mean nothing else. */
const DIRECTORY = gateEnv.OMB_GATE_DIRECTORY === "1";

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

/** Delete spilled results older than SPILL_MAX_AGE_MS. Best effort: a sweep
 * that fails must never stop the bot's tools from working. */
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
      /* another gate may be sweeping the same directory */
    }
  }
}

let spilled = 0;

/** Save the untrimmed text and return its path, or undefined when there is
 * nowhere to put it — the trim still happens, the model is just told the rest
 * was discarded rather than where to find it. */
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

/** Rewrite one `tools/call` result in place. Returns true when anything was
 * actually trimmed, so the caller can report it on stderr. */
function trimCallResult(result: Json, tool: string): boolean {
  if (BUDGET === 0) return false;
  const content = result.content;
  if (!Array.isArray(content)) return false;

  // The text blocks are what a provider puts in the model's context, and a
  // server that answers with several is answering with one payload split up,
  // so they share the budget rather than each getting it.
  const textBlocks = content.filter(
    (block): block is Json & { text: string } =>
      Boolean(block) && typeof block === "object" && (block as Json).type === "text" && typeof (block as Json).text === "string",
  );
  const total = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
  if (!textBlocks.length || total <= BUDGET) return false;

  const share = Math.floor(BUDGET / textBlocks.length);
  const path = spill(tool, textBlocks.map((block) => block.text).join("\n"));
  let trimmed = false;
  for (const block of textBlocks) {
    const outcome = trimResultText({ text: block.text, budget: share, spillPath: path, spillHint: SPILL_HINT, toolName: tool });
    if (!outcome.trimmed) continue;
    block.text = outcome.text;
    trimmed = true;
  }

  // A tool that also answers with structuredContent would otherwise hand the
  // provider a second, full copy of everything just cut. Trim it the same way
  // — structurally only, so it stays valid against the tool's output schema —
  // and leave it untouched when it cannot be cut without mangling it.
  if (trimmed && result.structuredContent && typeof result.structuredContent === "object") {
    const structured = trimStructured(result.structuredContent, BUDGET);
    if (structured) result.structuredContent = structured.value as Json;
  }
  return trimmed;
}

// Validate before starting a process: corrupt policy must never become pass-through.
const scope = toolScope();
const spec = upstreamSpec();
if (SPILL_DIR) sweepSpill(SPILL_DIR);

const childEnv: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
for (const key of Object.keys(childEnv)) if (key.startsWith("OMB_GATE_")) delete childEnv[key];

// The CLI used to spawn this server itself, on every platform, so the gate
// has to spawn it exactly as well. On Windows CreateProcess cannot exec an
// npm .cmd shim or a node-shebang script, which is what `npx -y mcp-remote`
// is — resolveCliSpawn rewrites it to the real executable without a shell, so
// quoting-sensitive JSON argv survives. A shell here would re-interpret the
// server's own arguments.
const resolved = resolveCliSpawn(spec.command, spec.args ?? []);
const child = spawn(resolved.command, resolved.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
  shell: false,
  // a console app spawned from the desktop shell flashes a window otherwise
  ...(process.platform === "win32" ? { windowsHide: true } : {}),
});

// The gate owns this process. If the gate is killed rather than closed —
// the CLI reaping its MCP servers at the end of a turn — the real server
// must not be left behind, and on Windows only taskkill /T reaps a tree.
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

type Pending = { kind: "call"; tool: string; trim: boolean } | { kind: "list" | "other" };

/** The upstream tool one call runs: its own name or call_tool's target, or
 * undefined when the directory answers the call itself. */
function callTarget(name: string, args: unknown): string | undefined {
  return DIRECTORY ? directoryCallTarget(name, args) : name;
}
/** JSON-RPC string and numeric IDs are separate, even when their text is equal. */
const pending = new Map<string, Pending>();

// client -> server: verbatim, but remember which ids are tool calls
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
  if (scope && message?.method === "tools/call") {
    if (!id || typeof params?.name !== "string"
      || (params.arguments !== undefined && !isRecord(params.arguments))) {
      return rejectRequest(message.id, -32602, "Invalid tool call");
    }
    const target = callTarget(params.name, params.arguments);
    if (target !== undefined && !allowsTool(scope, { kind: "mcp", server: NAME, name: target })) {
      return rejectRequest(message.id, -32602, "Tool selection excludes this tool. Check the bot's Access settings.");
    }
  }
  if (scope && message?.method === "tools/list" && !id) {
    return rejectRequest(message.id, -32600, "Tool listing needs a request ID");
  }
  if (id && typeof message?.method === "string") {
    if (scope && pending.has(id)) fail("duplicate request ID on a restricted connection");
    if (message.method === "tools/call") {
      const name = typeof params?.name === "string" ? params.name : "tool";
      const target = callTarget(name, params?.arguments);
      pending.set(id, { kind: "call", tool: target ?? name, trim: target !== undefined });
    } else if (scope) {
      pending.set(id, { kind: message.method === "tools/list" ? "list" : "other" });
    }
  }
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());

// server -> client: the one direction that gets rewritten
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let message: Json | undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) message = parsed;
  } catch {
    // Not JSON the gate understands. Relay it exactly as it came: a frame the
    // gate cannot read is still the upstream server's answer to give.
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
  if (id !== undefined) pending.delete(id);
  const result = message.result;
  if (scope && request?.kind === "list" && message.error === undefined) {
    if (!isRecord(result) || !Array.isArray(result.tools)
      || !result.tools.every((tool: unknown) => isRecord(tool) && typeof tool.name === "string" && tool.name.trim().length > 0)
      || (result.nextCursor !== undefined && typeof result.nextCursor !== "string")) {
      return rejectRequest(message.id, -32603, "Invalid tool catalog on a restricted connection");
    }
    result.tools = result.tools.filter((tool: Json) => (DIRECTORY && isDirectoryTool(tool.name))
      || allowsTool(scope, { kind: "mcp", server: NAME, name: tool.name as string }));
  }
  if (request?.kind === "call" && request.trim && isRecord(result)) {
    try {
      if (trimCallResult(result, request.tool)) {
        process.stderr.write(`mcp-gate(${NAME}): trimmed ${request.tool} to ${BUDGET} chars\n`);
      }
    } catch (error) {
      // A result the trimmer chokes on is relayed whole. Costing context is
      // recoverable; dropping a tool answer is not.
      process.stderr.write(`mcp-gate(${NAME}): could not trim ${request.tool}: ${String(error)}\n`);
      process.stdout.write(`${line}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
