import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { findCliCandidates } from "../env-path.ts";
import { captureCliTree, killCliTree } from "../procs.ts";
import { appendNative } from "./native.ts";
import { armIdleClose, engineIdleMs, sessionIdlePolicy, stopIdleClose } from "./session-idle.ts";

/** Codex 0.160.1 lists a table's entries (its plugins, its MCP servers) in a different order from one `config/read` to the
 * next, so tables are compared with their keys in order. */
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, ordered(entry)]))
    : value;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(ordered(value)) ?? "").digest("hex");

/** A fingerprint of the effective configuration `config/read` returned, one per top-level setting. */
export function codexConfigDigest(config: unknown): string {
  const settings = config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : { config };
  return JSON.stringify({ config: ordered(Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, digest(value)]))) });
}

export interface CodexUsageTotal {
  input: number;
  output: number;
  cachedInput: number;
}

/** What the turn that owns an app-server hears from it. */
export interface CodexTurnLink {
  message(message: any): void;
  error(error: Error): void;
  close(code: number | null, signal: NodeJS.Signals | null): void;
}

/** One `codex app-server` process and its NDJSON stream. Request ids and line framing belong to the process, so they
 * outlive the turn that started it. */
export class CodexConnection {
  nextId = 1;
  /** `config/read` replies, which carry the person's configuration. */
  readonly sensitiveResponseIds = new Set<number>();
  stderr = "";
  /** Only stderr after the last protocol message can explain an exit. */
  stderrSinceOutput = "";
  /** The native thread's running token total (codex-cli 0.160.1 counts per app-server process). */
  usageTotal: CodexUsageTotal | undefined;
  /** The native thread a kept process has loaded. */
  nativeThreadId: string | null = null;
  /** Called once when the process exits with no turn attached. */
  exitedIdle: (() => void) | null = null;
  private link: CodexTurnLink | null = null;
  private buffer = "";
  private readonly asked = new Map<number, (result: unknown) => void>();
  readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
      this.stderrSinceOutput = (this.stderrSinceOutput + chunk).slice(-2048);
    });
    child.on("error", (error) => this.link?.error(error));
    child.on("close", (code, signal) => this.link?.close(code, signal));
    child.once("exit", () => { if (!this.link) this.exitedIdle?.(); });
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  attach(link: CodexTurnLink): void {
    this.link = link;
    this.stderr = "";
    this.stderrSinceOutput = "";
  }

  detach(): void {
    this.link = null;
  }

  /** A request of the connection's own, answered whether or not a turn is attached. Resolves undefined on an error
   * reply; never resolves if the process exits first. */
  ask(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    if (method === "config/read") this.sensitiveResponseIds.add(id);
    return new Promise((resolve) => {
      this.asked.set(id, resolve);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  write(message: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n");
    } catch {}
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.stderrSinceOutput = "";
      const answer = message?.id !== undefined && !message.method ? this.asked.get(message.id) : undefined;
      if (answer) {
        this.asked.delete(message.id);
        answer(message.result);
      } else if (this.link) this.link.message(message);
      else this.unattended(message);
    }
  }

  /** No turn is running: a request from the app-server is refused, and only the token total is kept. */
  private unattended(message: any): void {
    if (message?.id !== undefined && message.method) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No OpenMausBot turn is running on this thread." } });
      return;
    }
    const total = message?.method === "thread/tokenUsage/updated" && message.params?.threadId === this.nativeThreadId
      ? message.params.tokenUsage?.total : null;
    if (total) this.usageTotal = { input: total.inputTokens ?? 0, output: total.outputTokens ?? 0, cachedInput: total.cachedInputTokens ?? 0 };
  }
}

/** The Codex login a process started with, by account rather than by token: Codex rewrites auth.json when it renews
 * a token (codex-cli 0.160.1), and that is no reason to start again. */
export function codexLoginIdentity(stored: string | null): string | null {
  if (stored === null) return null;
  try {
    const auth = JSON.parse(stored) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { account_id?: unknown } };
    const account = auth.tokens?.account_id;
    if (auth.tokens && typeof account !== "string") return digest(stored);
    return digest({ mode: auth.auth_mode ?? null, key: auth.OPENAI_API_KEY ?? null, account: account ?? null });
  } catch {
    return digest(stored);
  }
}

/** Which copy of the CLI a launch runs: an update in place replaces the file. */
function cliIdentity(cli: string, path: string | undefined): string {
  const at = findCliCandidates(cli, path ?? "")[0] ?? cli;
  try {
    const { mtimeMs, size } = statSync(at);
    return `${at}:${mtimeMs}:${size}`;
  } catch {
    return at;
  }
}

/** Everything an app-server is given when it starts and when its thread starts. A kept process serves a later turn only
 * when all of it is unchanged. Values are hashed: arguments and environment carry credentials. */
export function codexSpawnContract(parts: {
  cli: string;
  args: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
  box: unknown;
  thread: unknown;
  login: string | null;
}): string {
  let config: string | null = null;
  try {
    config = digest(readFileSync(join(parts.env.CODEX_HOME || join(parts.env.HOME || parts.env.USERPROFILE || homedir(), ".codex"), "config.toml"), "utf8"));
  } catch {}
  return JSON.stringify({
    config,
    cli: cliIdentity(parts.cli, parts.env.PATH),
    args: digest(parts.args),
    cwd: parts.cwd,
    box: digest(parts.box),
    thread: digest(parts.thread),
    login: parts.login,
    env: Object.fromEntries(Object.entries(parts.env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => [name, digest(value)])),
  });
}

/** The names of what changed between two contracts, never the values. */
export function codexContractDiff(previous: string, next: string): string[] {
  let before: Record<string, unknown>, after: Record<string, unknown>;
  try {
    before = JSON.parse(previous);
    after = JSON.parse(next);
  } catch {
    return [];
  }
  const changed: string[] = [];
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    const was = before[field], now = after[field];
    if (!was || !now || typeof was !== "object" || typeof now !== "object") {
      changed.push(field);
      continue;
    }
    const old = was as Record<string, unknown>, current = now as Record<string, unknown>;
    for (const name of new Set([...Object.keys(old), ...Object.keys(current)])) if (old[name] !== current[name]) changed.push(`${field}:${name}`);
  }
  return changed;
}

/** A process kept after a completed turn, with what its next turn needs to carry on. */
export interface KeptCodex<Carried> {
  connection: CodexConnection;
  contract: string;
  nativeThreadId: string;
  /** The effective configuration the process reported when its last turn ended. Codex 0.160.1 adds its plugins and
   * their MCP servers some time after it starts, so what it reports at start is not what it reports later. */
  configDigest: string;
  cwd: string;
  carried: Carried;
}

/** `OMB_CODEX_SESSION_KEEP=0` ends every app-server with its turn. */
const keepEnabled = (): boolean => process.env.OMB_CODEX_SESSION_KEEP !== "0";

/**
 * One provider account's kept app-servers, one per conversation (per-chat in session-idle.ts): a completed turn leaves
 * its process up for the conversation's next turn, which then starts no process, MCP servers or native thread.
 * Security invariant: a kept process is never handed to another conversation, and never to a turn whose contract differs.
 */
export function codexWarmSessions<Carried>(instanceId: string) {
  const policy = sessionIdlePolicy("CODEX");
  const kept = new Map<string, { session: KeptCodex<Carried>; idleTimer: ReturnType<typeof setTimeout> }>();
  const stopping = new Set<Promise<boolean>>();
  const idleKey = (threadId: string) => `${instanceId}\0${threadId}`;

  const forget = (threadId: string, why: string, contractChanged?: string[]) => {
    const entry = kept.get(threadId);
    if (!entry) return null;
    kept.delete(threadId);
    stopIdleClose(idleKey(threadId), entry.idleTimer);
    appendNative(threadId, { dir: "out", source: "codex.session", msg: { close: why, ...(contractChanged?.length ? { contractChanged } : {}) } });
    return entry.session;
  };

  /** Ends the whole tree: an app-server's MCP servers and shells can outlive it. */
  const end = async (session: KeptCodex<Carried>): Promise<void> => {
    const stopped = killCliTree(session.connection.child);
    stopping.add(stopped);
    try {
      await stopped;
    } finally {
      stopping.delete(stopped);
    }
  };

  const close = async (threadId: string, why: string, contractChanged?: string[]): Promise<void> => {
    const session = forget(threadId, why, contractChanged);
    if (session) await end(session);
  };

  return {
    /** Keeps a process whose turn completed. False when it is not kept: the caller ends it. */
    keep(threadId: string, session: KeptCodex<Carried>): boolean {
      const { connection } = session;
      captureCliTree(connection.child);
      if (!keepEnabled() || !connection.alive || kept.has(threadId)) return false;
      connection.detach();
      connection.nativeThreadId = session.nativeThreadId;
      void connection.ask("config/read", { cwd: session.cwd, includeLayers: false }).then((result) => {
        const config = (result as { config?: unknown } | undefined)?.config;
        if (config !== undefined) session.configDigest = codexConfigDigest(config);
      });
      const entry = {
        session,
        idleTimer: armIdleClose(idleKey(threadId), engineIdleMs(threadId, policy), {
          close: () => void close(threadId, "idle"),
          idle: () => kept.get(threadId)?.session === session,
          threadId,
          policy,
        }),
      };
      kept.set(threadId, entry);
      connection.exitedIdle = () => {
        if (kept.get(threadId) === entry && forget(threadId, "exited while idle")) void end(session);
      };
      return true;
    },

    /** The conversation's kept process when it can serve this turn. Any other one is ended: `retired` resolves once
     * it has exited. */
    take(threadId: string, contract: string, nativeThreadId: string | null): KeptCodex<Carried> | null {
      const entry = kept.get(threadId);
      if (!entry) return null;
      const { session } = entry;
      if (session.connection.alive && session.contract === contract && session.nativeThreadId === nativeThreadId) {
        kept.delete(threadId);
        stopIdleClose(idleKey(threadId), entry.idleTimer);
        return session;
      }
      const changed = codexContractDiff(session.contract, contract);
      void close(threadId, changed.length ? "spawn contract changed" : "another native session", changed);
      return null;
    },

    close,

    /** Every kept process being ended has exited, so a new one may load its native thread. */
    async retired(): Promise<void> {
      await Promise.all(stopping);
    },

    async closeAll(why: string): Promise<void> {
      await Promise.all([...[...kept.keys()].map((threadId) => close(threadId, why)), ...stopping]);
    },

    has: (threadId: string): boolean => kept.has(threadId),
    pid: (threadId: string): number | undefined => kept.get(threadId)?.session.connection.child.pid,
  };
}
