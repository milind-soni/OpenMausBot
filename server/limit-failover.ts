// A conversation whose engine hit its usage limit, or was signed out, continues on the configured backup, and goes back to
// its own engine once that limit has reset or it is signed in again.
import { readFileSync } from "node:fs";

import { sameModelSelection } from "../shared/thread-model.ts";
import type { ModelSelection } from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfig } from "./contracts.ts";
import { hostTimeZone } from "./turn-clock.ts";

/** Engines a person signs in to with a subscription whose usage limit refuses turns. */
const SUBSCRIPTION_DRIVERS = new Set(["claudeAgent", "codex", "grokAgent"]);
/** An engine instance with one of these keys bills each use instead of drawing on a subscription's limit. */
const PAY_PER_USE_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "XAI_API_KEY"];

type Engine = { instanceId: string; driverKind: string };

/** Whether `to` may take over a turn `from`'s usage limit refused. Never the same engine, and never another sign-in to
 * the same subscription engine: rotating accounts to get past a provider's usage limit breaks its terms and can get the
 * accounts closed. Another engine, or a pay-per-use key on the same one, is fine. */
export function limitBackupAllowed(from: Engine, to: Engine, toConfig?: Pick<InstanceConfig, "environment" | "access">): boolean {
  if (to.instanceId === from.instanceId) return false;
  if (to.driverKind !== from.driverKind || !SUBSCRIPTION_DRIVERS.has(from.driverKind)) return true;
  return billsEachUse(toConfig);
}

/** An engine instance that bills each use (a pay-per-use key, as its access or in its environment) instead of drawing on
 * a plan's limit. */
export function billsEachUse(config?: Pick<InstanceConfig, "environment" | "access">): boolean {
  return config?.access === "api" || PAY_PER_USE_KEYS.some((key) => Boolean(config?.environment?.[key]?.trim()));
}

export function resetClock(at: number, timeZone = hostTimeZone()): string {
  try {
    const sameDay = new Date(at).toDateString() === new Date().toDateString();
    return new Date(at).toLocaleString("en-US", { ...(sameDay ? {} : { weekday: "short" }), hour: "numeric", minute: "2-digit", timeZone });
  } catch {
    return new Date(at).toISOString().slice(11, 16) + " UTC";
  }
}

/** "Claude hit its limit (resets 3:40 PM), so Codex took over." */
export function failoverLine(from: string, to: string, resetsAt: number | undefined): string {
  return `${from} hit its limit${resetsAt ? ` (resets ${resetClock(resetsAt)})` : ""}, so ${to} took over.`;
}

export function backLine(engine: string, why?: LimitFailover["why"]): string {
  return why === "signed-out" ? `${engine} is signed in again, so this conversation is back on ${engine}.`
    : `${engine}'s limit has reset, so this conversation is back on ${engine}.`;
}

/** "Claude is signed out, so Codex took over." */
export function signedOutLine(from: string, to: string): string {
  return `${from} is signed out, so ${to} took over.`;
}

export interface LimitFailover {
  botId: string;
  threadId: string;
  from: ModelSelection;
  to: ModelSelection;
  /** When `from`'s limit resets; unknown means its usage decides, after UNKNOWN_RESET_WAIT_MS. */
  resetsAt: number | null;
  at: number;
  /** `from` was signed out, not limited: the conversation goes back once it is signed in again. */
  why?: "signed-out";
}

/** With no reset time known, a conversation tries its own engine again no sooner than this. */
const UNKNOWN_RESET_WAIT_MS = 60 * 60_000;

export interface LimitFailoverDeps {
  file: string;
  now?: () => number;
  /** Until when this engine refuses work; null when it should be working. */
  blockedUntil: (engine: string) => number | null;
  /** This engine refused a turn because it is signed out, and has not been signed in again since. */
  signedOut?: (engine: string) => boolean;
  /** The thread's model now, or null when the thread is gone. */
  threadModel: (botId: string, threadId: string) => ModelSelection | null;
  /** Switches the thread back; false when that is not allowed now (a busy thread, a permission change). */
  switchBack: (failover: LimitFailover) => boolean;
  /** One plain line in the conversation. */
  note: (threadId: string, line: string) => void;
  engineName: (engine: string) => string;
}

function load(file: string): LimitFailover[] {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(rows) ? rows.filter((row): row is LimitFailover => typeof row?.botId === "string" && typeof row?.threadId === "string" &&
      typeof row?.from?.instanceId === "string" && typeof row?.to?.instanceId === "string" && (row.resetsAt === null || Number.isFinite(row.resetsAt)) &&
      Number.isFinite(row.at) && (row.why === undefined || row.why === "signed-out")) : [];
  } catch {
    return [];
  }
}

export class LimitFailovers {
  private readonly deps: LimitFailoverDeps;
  private rows: LimitFailover[];

  constructor(deps: LimitFailoverDeps) {
    this.deps = deps;
    this.rows = load(deps.file);
  }

  /** A thread moved to `to` because `from`'s usage limit refused it, or `from` was signed out. */
  record(failover: LimitFailover): void {
    const earlier = this.rows.find((row) => row.threadId === failover.threadId);
    // A second failover keeps the engine the conversation started on, so it still goes back there.
    const from = earlier && sameModelSelection(earlier.to, failover.from) ? earlier.from : failover.from;
    // A reset already past when the limit refused names no time: the engine's own hold decides when it goes back.
    const resetsAt = failover.resetsAt !== null && failover.resetsAt > failover.at ? failover.resetsAt : null;
    this.rows = [...this.rows.filter((row) => row.threadId !== failover.threadId), { ...failover, from, resetsAt }].slice(-500);
    this.save();
  }

  /** Before a turn: a thread on a backup goes back to its own engine once that engine's limit has reset, or it is
   * signed in again, with one line saying so. A thread someone moved to another model since is left alone. */
  restore(botId: string, threadId: string): boolean {
    const row = this.rows.find((candidate) => candidate.threadId === threadId && candidate.botId === botId);
    if (!row) return false;
    const now = this.deps.now?.() ?? Date.now();
    const current = this.deps.threadModel(botId, threadId);
    if (!current || !sameModelSelection(current, row.to)) return this.forget(threadId);
    const waitUntil = row.why === "signed-out" ? row.at : row.resetsAt ?? row.at + UNKNOWN_RESET_WAIT_MS;
    if (waitUntil > now || this.deps.blockedUntil(row.from.instanceId) !== null) return false;
    if (row.why === "signed-out" && this.deps.signedOut?.(row.from.instanceId)) return false;
    if (!this.deps.switchBack(row)) return false;
    this.forget(threadId);
    this.deps.note(threadId, backLine(this.deps.engineName(row.from.instanceId), row.why));
    return true;
  }

  forget(threadId: string): false {
    const kept = this.rows.filter((row) => row.threadId !== threadId);
    if (kept.length !== this.rows.length) {
      this.rows = kept;
      this.save();
    }
    return false;
  }

  list(): LimitFailover[] {
    return this.rows.map((row) => ({ ...row }));
  }

  private save(): void {
    try {
      writeFileAtomic(this.deps.file, JSON.stringify(this.rows, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error(`limit failovers: could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
