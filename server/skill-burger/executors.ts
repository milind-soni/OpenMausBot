// Where a Skill Burger's steps really run. Security invariant: each one goes through the same door the bot's own call
// went through, so a replay is never allowed more than the bot was: a command on the bot's own computer runs in its bot
// box (spawnCli as "bot"); one on its cloud computer goes through that computer's own route; an app action goes through
// the connectors gate (grants, read or write scope, team rules) with a capability for this turn; a page opens in the
// bot's own browser through its route; a file is written only inside the conversation's folder.
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

import { appToolCall } from "../connector-app-tools.ts";
import { toolData } from "../connected-reads.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import type { ExecResult, StepExecutors } from "./runner.ts";

const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const FILE_OUTSIDE = "a saved step writes files only inside this conversation's folder";
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !isAbsolute(rel));
}

function writeInside(cwd: string, path: string, content: string): ExecResult {
  const root = realpathSync(cwd);
  const target = resolvePath(root, path);
  const inside = relative(root, target);
  if (!inside || !isInside(root, target)) return { ok: false, error: FILE_OUTSIDE };
  const dir = dirname(target);
  // Check the deepest existing ancestor before creating folders so a symlinked directory cannot escape mkdirSync.
  for (let cur = dir; cur !== root;) {
    try {
      lstatSync(cur);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: FILE_OUTSIDE };
      const parent = dirname(cur);
      if (parent === cur) return { ok: false, error: FILE_OUTSIDE };
      cur = parent;
      continue;
    }
    try {
      if (!isInside(root, realpathSync(cur))) return { ok: false, error: FILE_OUTSIDE };
    } catch {
      return { ok: false, error: FILE_OUTSIDE };
    }
    break;
  }
  mkdirSync(dir, { recursive: true });
  if (!isInside(root, realpathSync(dir))) return { ok: false, error: FILE_OUTSIDE };
  try {
    if (lstatSync(target).isSymbolicLink()) return { ok: false, error: FILE_OUTSIDE };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: FILE_OUTSIDE };
  }
  let fd: number;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return { ok: false, error: FILE_OUTSIDE };
    throw error;
  }
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return { ok: true, output: inside };
}

export interface ExecutorContext {
  botId: string;
  /** The conversation's folder: commands start here and files are written under it. */
  cwd: string;
  /** Posts a JSON body to one of the server's internal routes as this turn, with a capability of `kind`; with no body,
   * a GET. */
  internal(kind: "agents" | "connectors" | "computer" | "browser", path: string, body: unknown, signal: AbortSignal): Promise<{ ok: boolean; body: Record<string, unknown>; status?: number }>;
  /** The apps this bot is connected to, or null when that can't be told. */
  connected?: () => Promise<readonly string[] | null>;
  /** The shell a command runs in on this computer. */
  shell?: { command: string; args: (script: string) => string[] };
}

const tooLarge = (maxBytes: number): ExecResult => ({ ok: false, error: `the output went over ${Math.round(maxBytes / 1024)} KB`, tooLarge: true });
const rpcId = () => Math.floor(Math.random() * 1e9);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

/** The text of an MCP tools/call answer, or its error. */
function callText(frame: Record<string, unknown>): ExecResult {
  const error = record(frame.error)?.message;
  if (typeof error === "string") return { ok: false, error };
  const result = record(frame.result);
  const text = (Array.isArray(result?.content) ? result.content : []).map(record).map((part) => part?.text).filter((part) => typeof part === "string").join("\n");
  return result?.isError === true ? { ok: false, error: text || "the call failed" } : { ok: true, output: text };
}

/** The server's PATH with the system's own folders after it: a server started with a short PATH still finds sleep or cp. */
function commandPath(): string {
  const own = process.env.PATH ?? "";
  if (process.platform === "win32") return own;
  const parts = own.split(":").filter(Boolean);
  for (const dir of ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(":");
}

function defaultShell(): NonNullable<ExecutorContext["shell"]> {
  return process.platform === "win32"
    ? { command: process.env.ComSpec || "cmd.exe", args: (script) => ["/d", "/s", "/c", script] }
    : { command: "/bin/sh", args: (script) => ["-c", script] };
}

/** Runs `script` as the bot, in its box where the box is on, and collects up to `maxBytes` of each stream. */
function runInBox(context: ExecutorContext, input: Parameters<StepExecutors["shell"]>[0]): Promise<ExecResult> {
  const shell = context.shell ?? defaultShell();
  return new Promise((done) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(shell.command, shell.args(input.command), {
        cwd: input.cwd ? resolvePath(context.cwd, input.cwd) : context.cwd,
        env: { PATH: commandPath(), HOME: process.env.HOME, LANG: process.env.LANG, ...input.env },
        stdio: ["pipe", "pipe", "pipe"],
        box: { botId: context.botId },
      }, "bot");
    } catch (error) {
      done({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let over = false;
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > input.maxBytes) {
        if (!over) { over = true; void killCliTree(child, 0); }
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    const stop = () => { void killCliTree(child, 0); };
    input.signal.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => done({ ok: false, error: error.message }));
    child.on("close", (code) => {
      input.signal.removeEventListener("abort", stop);
      if (over) return done(tooLarge(input.maxBytes));
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      done(code === 0 ? { ok: true, output: stdout } : { ok: false, error: (stderr.trim() || stdout.trim() || `exit code ${code}`).slice(-2_000) });
    });
    child.stdin.end(input.stdin ?? "");
  });
}

/** A command on the cloud computer: the bot's VM or VPS desktop through vm-exec, else the cloud computer's own exec. */
async function runOnVm(context: ExecutorContext, input: Parameters<StepExecutors["shell"]>[0]): Promise<ExecResult> {
  const prefix = Object.entries(input.env).map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ");
  const command = prefix ? `export ${prefix}; ${input.command}` : input.command;
  const vm = await context.internal("agents", "/api/internal/vm-exec", { command, timeout_seconds: 600 }, input.signal);
  if (vm.ok) {
    const stdout = String(vm.body.stdout ?? "");
    if (Buffer.byteLength(stdout) > input.maxBytes) return tooLarge(input.maxBytes);
    return Number(vm.body.exitCode ?? 0) === 0 && !vm.body.timedOut ? { ok: true, output: stdout } : { ok: false, error: String(vm.body.stderr || vm.body.stdout || "the command failed").slice(-2_000) };
  }
  if (vm.status !== 409 || vm.body.code !== "no_vm_for_turn") return { ok: false, error: String(vm.body.error ?? "the command failed") };
  const computer = await context.internal("computer", "/api/internal/computer/mcp", { jsonrpc: "2.0", id: rpcId(), method: "tools/call", params: { name: "exec", arguments: { command } } }, input.signal);
  if (!computer.ok) return { ok: false, error: String(vm.body.error ?? computer.body.error ?? "there is no cloud computer to run this on") };
  const result = callText(computer.body);
  return result.ok && typeof result.output === "string" && Buffer.byteLength(result.output) > input.maxBytes ? tooLarge(input.maxBytes) : result;
}

/** Single-quoted for a POSIX shell: the value is data, never code. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The connectors gate's call for an app step: a plain app tool by its own name, any other app action through the one
 * multi-execute tool. */
export function appFrame(tool: string, args: Record<string, unknown>, account: string | undefined, id: number): { slug: string; frame: Record<string, unknown> } {
  // Recorded plain app tools keep their dotted name (gmail.search_emails); a Composio slug always goes through multi-execute.
  const plain = tool.includes(".") ? appToolCall(tool, { ...args, ...(account ? { account } : {}) }) : null;
  if (plain) return { slug: plain.slug, frame: plain.frame(id) };
  return {
    slug: tool,
    frame: { jsonrpc: "2.0", id, method: "tools/call", params: { name: MULTI_EXECUTE, arguments: { tools: [{ tool_slug: tool, arguments: args, ...(account ? { account } : {}) }] } } },
  };
}

export function createExecutors(context: ExecutorContext): StepExecutors {
  return {
    ...(context.connected ? { connected: context.connected } : {}),
    // A delegate step's hand-offs go through coordinate_bots' own route, as this turn: the same reach, limits and receipts.
    async teammates(signal) {
      const answer = await context.internal("agents", `/api/internal/agents?self=${encodeURIComponent(context.botId)}`, undefined, signal);
      const bots = Array.isArray(answer.body.bots) ? answer.body.bots.map(record).filter((bot): bot is Record<string, unknown> => Boolean(bot)) : [];
      return bots.flatMap((bot) => (typeof bot.id === "string" && typeof bot.name === "string" ? [{ id: bot.id, name: bot.name, ...(typeof bot.title === "string" ? { title: bot.title } : {}) }] : []));
    },
    async delegate(input) {
      const answer = await context.internal("agents", "/api/internal/coordinate-bots", {
        botIds: input.botIds, message: input.message, ...(input.doneWhen ? { done_when: input.doneWhen } : {}), ...(input.rework ? { rework: true } : {}), ...(input.consult ? { consult: true } : {}),
      }, input.signal);
      const receipts = (Array.isArray(answer.body.receipts) ? answer.body.receipts : []).map(record).flatMap((receipt) => (
        receipt && receipt.outcome !== "failed" && typeof receipt.botId === "string" && typeof receipt.requestId === "string" ? [{ botId: receipt.botId, name: String(receipt.botName ?? receipt.botId), requestId: receipt.requestId }] : []));
      if (!answer.ok || !receipts.length || input.botIds.some((botId) => !receipts.some((receipt) => receipt.botId === botId))) {
        const refusedOne = (Array.isArray(answer.body.receipts) ? answer.body.receipts : []).map(record).find((receipt) => receipt?.detail && !receipts.some((one) => one.botId === receipt.botId));
        return { ok: false, error: String(answer.body.error ?? refusedOne?.detail ?? "the hand-off was refused"), receipts };
      }
      return { ok: true, receipts };
    },
    async assignment(id, signal) {
      const answer = await context.internal("agents", `/api/internal/assignment-status?id=${encodeURIComponent(id)}`, undefined, signal);
      const row = record(answer.body.assignment) ?? answer.body;
      return answer.ok && typeof row.status === "string" ? { status: row.status, result: typeof row.result === "string" ? row.result : "" } : null;
    },
    shell: (input) => (input.where === "vm" ? runOnVm(context, input) : runInBox(context, input)),
    async app(input) {
      const { slug, frame } = appFrame(input.tool, input.args, input.account, rpcId());
      const answer = await context.internal("connectors", "/api/internal/connectors/mcp", frame, input.signal);
      if (!answer.ok) return { ok: false, error: String(answer.body.error ?? "the app call was refused") };
      if (Buffer.byteLength(JSON.stringify(answer.body)) > input.maxBytes) return tooLarge(input.maxBytes);
      try {
        return { ok: true, output: toolData(slug, answer.body) };
      } catch (error) {
        const content = record(answer.body.result)?.content;
        const text = Array.isArray(content) ? content.map(record).find((part) => typeof part?.text === "string")?.text : undefined;
        if (typeof text === "string") {
          try { JSON.parse(text); } catch {
            const plain = callText(answer.body);
            if (plain.ok) return plain;
          }
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async browser(input) {
      const cloud = input.where === "vm";
      const answer = await context.internal(cloud ? "computer" : "browser", cloud ? "/api/internal/computer/mcp" : "/api/internal/browser/mcp", { jsonrpc: "2.0", id: rpcId(), method: "tools/call", params: { name: cloud ? "open_url" : "agent_browser_open", arguments: { url: input.url } } }, input.signal);
      return answer.ok ? callText(answer.body) : { ok: false, error: String(answer.body.error ?? (cloud ? "the cloud computer isn't available" : "the browser isn't available")) };
    },
    async file(input) {
      return writeInside(context.cwd, input.path, input.content);
    },
  };
}
