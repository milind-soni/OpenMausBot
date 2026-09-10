// A pass-through MCP server that keeps one tool result from eating a
// conversation.
//
// The provider CLI mounts this instead of the bot's real MCP server. Every
// JSON-RPC frame is relayed in both directions untouched, except the response
// to a `tools/call`: an oversized result is cut to a budget (mcp-trim.ts), the
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

import { resolveCliSpawn } from "./env-path.ts";
import { DEFAULT_RESULT_BUDGET, trimResultText, trimStructured } from "./mcp-trim.ts";
import { killCliTree } from "./procs.ts";

type Json = Record<string, unknown>;

const NAME = process.env.OMB_GATE_NAME || "mcp";
const SPILL_DIR = process.env.OMB_GATE_SPILL_DIR || "";
const BUDGET = Number(process.env.OMB_GATE_BUDGET) > 0 ? Number(process.env.OMB_GATE_BUDGET) : DEFAULT_RESULT_BUDGET;
/** Spilled results older than this are swept at startup: they exist for the
 * turn that produced them, not forever. */
const SPILL_MAX_AGE_MS = 24 * 60 * 60_000;
/** Whether the model is told where the untrimmed result was saved. Off by
 * default: offering the path measured WORSE than no trimming, because the
 * model reads the file back in. See TrimInput.spillHint. */
const SPILL_HINT = process.env.OMB_GATE_SPILL_HINT === "1";

/** The gate's own settings never reach the upstream server's environment. */
const GATE_ENV_KEYS = ["OMB_GATE_NAME", "OMB_GATE_SPILL_DIR", "OMB_GATE_BUDGET", "OMB_GATE_UPSTREAM", "OMB_GATE_SPILL_HINT"];

function fail(message: string): never {
  process.stderr.write(`mcp-gate(${NAME}): ${message}\n`);
  process.exit(1);
}

interface Upstream {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function upstreamSpec(): Upstream {
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.OMB_GATE_UPSTREAM ?? "");
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

const spec = upstreamSpec();
if (SPILL_DIR) sweepSpill(SPILL_DIR);

const childEnv: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
for (const key of GATE_ENV_KEYS) delete childEnv[key];

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

/** id -> tool name, for the calls whose answers are still in flight. */
const pending = new Map<string, string>();

// client -> server: verbatim, but remember which ids are tool calls
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) {
    try {
      const message = JSON.parse(line) as Json;
      if (message.method === "tools/call" && message.id !== undefined && message.id !== null) {
        const params = message.params as Json | undefined;
        pending.set(String(message.id), typeof params?.name === "string" ? params.name : "tool");
      }
    } catch {
      /* not our business to validate the client's frames */
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
    message = JSON.parse(line) as Json;
  } catch {
    // Not JSON the gate understands. Relay it exactly as it came: a frame the
    // gate cannot read is still the upstream server's answer to give.
    process.stdout.write(`${line}\n`);
    return;
  }
  const id = message.id === undefined || message.id === null ? undefined : String(message.id);
  const tool = id === undefined ? undefined : pending.get(id);
  if (id !== undefined) pending.delete(id);
  const result = message.result;
  if (tool && result && typeof result === "object" && !Array.isArray(result)) {
    try {
      if (trimCallResult(result as Json, tool)) {
        process.stderr.write(`mcp-gate(${NAME}): trimmed ${tool} to ${BUDGET} chars\n`);
      }
    } catch (error) {
      // A result the trimmer chokes on is relayed whole. Costing context is
      // recoverable; dropping a tool answer is not.
      process.stderr.write(`mcp-gate(${NAME}): could not trim ${tool}: ${String(error)}\n`);
      process.stdout.write(`${line}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
