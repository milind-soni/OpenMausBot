// When each engine's usage limit resets, from its plan usage and from the refusals its turns meet, so a limit-reset
// automation knows when to run, the app can warn before a limit is reached, and every new turn of every bot goes
// straight to another AI while one is held. The holds are saved: a restart or a sleep the Cloud was stopped for keeps them.
import { readFileSync } from "node:fs";

import { NEAR_LIMIT_PERCENT, type EngineLimit, type EngineLimitsReport, type LimitWindowName } from "../shared/limit-reset.ts";
import { writeFileAtomic } from "./atomic.ts";
import { loadPlanUsage, type PlanAccount, type PlanProviderRow, type PlanUsageReport, type PlanWindow } from "./plan-usage.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";

/** How often a waiting limit-reset automation checks usage again, and how fresh a shown limit must be. */
export const LIMIT_POLL_MS = 5 * 60_000;
/** A refusal's reset is kept a little past its time, so a run due right then still finds it. */
const REFUSAL_GRACE_MS = 10 * 60_000;
const SOON_AFTER_REFUSAL_MS = 5_000;

type Driver = EngineLimit["driver"];

function windowLine(name: LimitWindowName, window: PlanWindow): { window: LimitWindowName; used: number; resetsAt: number | null } | null {
  if (!window.available || window.usedPercent === null) return null;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return { window: name, used: window.usedPercent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

/** An engine's limit from its plan-usage row. The windows at their limit decide, and all must reset, so the latest of
 * their resets counts; with none at the limit, the fullest window counts. Null when the row has no usage. */
export function engineLimitFromUsage(row: PlanProviderRow): EngineLimit | null {
  if (!row.ok || (row.driver !== "claude" && row.driver !== "codex" && row.driver !== "grok")) return null;
  const base = { engine: row.id, name: row.name, driver: row.driver as Driver };
  const windows = [windowLine("5-hour", row.fiveHour), windowLine("weekly", row.weekly)].filter((line) => line !== null);
  if (!windows.length) return { ...base, window: null, usedPercent: null, resetsAt: null, blocked: false };
  const full = windows.filter((line) => line.used >= 100);
  if (full.length) {
    const latest = full.reduce((left, right) => (right.resetsAt ?? 0) > (left.resetsAt ?? 0) ? right : left);
    return { ...base, window: latest.window, usedPercent: 100, resetsAt: full.some((line) => line.resetsAt === null) ? null : latest.resetsAt, blocked: true };
  }
  const fullest = [...windows].sort((left, right) => right.used - left.used || (left.resetsAt ?? Infinity) - (right.resetsAt ?? Infinity))[0]!;
  return { ...base, window: fullest.window, usedPercent: fullest.used, resetsAt: fullest.resetsAt, blocked: false };
}

const PRODUCT_NAMES: Record<string, string> = { claudeAgent: "Claude", codex: "Codex", grokAgent: "Grok" };

/** "Claude", "Codex", or the name the person gave that engine. */
export function engineLabel(engine: string, instance?: { displayName?: string; driverKind: string }): string {
  return instance?.displayName?.trim() || (instance ? PRODUCT_NAMES[instance.driverKind] ?? instance.driverKind : engine);
}

/** A line for the turn's text when its engine is nearly out of usage, so the bot can set up its own continuation. */
export function nearLimitNote(limit: EngineLimit | undefined, name: string, timeZone: string): string {
  if (!limit || limit.usedPercent === null || limit.usedPercent < NEAR_LIMIT_PERCENT) return "";
  let resets = "";
  if (limit.resetsAt !== null) {
    try { resets = `; it resets ${new Date(limit.resetsAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`; }
    catch { resets = `; it resets ${new Date(limit.resetsAt).toISOString()}`; }
  }
  return ` ${name}'s ${limit.window === "weekly" ? "weekly" : "usage"} limit is ${Math.round(limit.usedPercent)}% used${resets}.`;
}

export interface LimitClockOptions {
  /** The signed-in subscription engines whose usage can be read. */
  accounts: () => PlanAccount[];
  /** Plan usage for those engines; the default reads each engine's own sign-in, or OMB_TEST_PLAN_USAGE_FILE. */
  loadUsage?: (accounts: PlanAccount[], refresh: boolean) => Promise<PlanUsageReport>;
  /** Something is waiting on a reset time, so usage is checked again on its own. */
  waiting?: () => boolean;
  /** The known reset times changed. */
  onChange?: () => void;
  now?: () => number;
  /** Where the refusals' holds are kept across restarts; none in tests that need no file. */
  file?: string;
}

/** A test fixture's plan usage, read fresh each time so a test can move a reset. Never set outside tests. */
function fixtureUsage(path: string, now: number): PlanUsageReport {
  try {
    const report = JSON.parse(readFileSync(path, "utf8")) as PlanUsageReport;
    return { fetchedAt: new Date(now).toISOString(), providers: Array.isArray(report.providers) ? report.providers : [] };
  } catch {
    return { fetchedAt: new Date(now).toISOString(), providers: [] };
  }
}

/** With no reset time named, a usage limit holds its engine this long after its last refusal. */
export const UNNAMED_LIMIT_MS = 60 * 60_000;

export class LimitResetClock {
  private readonly options: LimitClockOptions;
  private readonly now: () => number;
  private usage = new Map<string, EngineLimit>();
  private readonly refusals = new Map<string, number>();
  /** Engines held by a refusal that named no reset time: the hold is a guess, never shown as a reset. */
  private readonly guessed = new Set<string>();
  private readonly turnEngines = new Map<string, string>();
  private checkedAt = 0;
  private loading: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LimitClockOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.loadHolds();
  }

  /** The reset a limit-reset automation for this engine waits for: a refusal's own time unless usage shows a later
   * window still at its limit; otherwise the usage's. It may have passed, which means the limit has reset. */
  resetAt(engine: string): number | null {
    const refused = this.guessed.has(engine) ? null : this.refusal(engine);
    const usage = this.usage.get(engine);
    if (refused === null) return usage?.resetsAt ?? null;
    return usage?.blocked && usage.resetsAt !== null && usage.resetsAt > refused ? usage.resetsAt : refused;
  }

  /** Until when this engine refuses work, as far as is known; null when it should be working. */
  blockedUntil(engine: string): number | null {
    const now = this.now();
    const refused = this.refusal(engine);
    const usage = this.usage.get(engine);
    const until = Math.max(refused ?? 0, usage?.blocked && usage.resetsAt !== null ? usage.resetsAt : 0);
    return until > now ? until : null;
  }

  limit(engine: string): EngineLimit | undefined {
    return this.report().engines.find((candidate) => candidate.engine === engine);
  }

  report(): EngineLimitsReport {
    const engines = new Map(this.usage);
    for (const engine of this.refusals.keys()) {
      const until = this.blockedUntil(engine);
      const known = engines.get(engine);
      if (until !== null) engines.set(engine, { ...(known ?? this.unnamed(engine)), blocked: true, usedPercent: 100, resetsAt: this.guessed.has(engine) ? known?.resetsAt ?? null : until });
    }
    return { checkedAt: this.checkedAt, engines: [...engines.values()] };
  }

  /** Every runtime event, with the engine its turn runs on when known: a refusal holds the engine, and a turn that
   * works on it afterwards ends the hold, since the account plainly has room again (another model, plan or account). */
  noteRuntimeEvent(engine: string | undefined, event: RuntimeEvent): void {
    if (event.type === "turn.started" && engine) this.turnEngines.set(event.threadId, engine);
    else if (event.type === "runtime.error") {
      const refused = engine ?? this.turnEngines.get(event.threadId);
      // One model's own limit leaves the engine's other models working: only that model is held (host/limit-takeover).
      if (event.limit === "engine") this.noteLimit(refused, event.limitResetsAt);
      else if (event.limit === undefined) this.noteRefusal(refused, event.limitResetsAt);
    }
    else if (event.type === "turn.completed" || event.type === "session.exited") {
      const ran = this.turnEngines.get(event.threadId) ?? engine;
      this.turnEngines.delete(event.threadId);
      if (event.type === "turn.completed" && event.ok && ran && this.refusals.delete(ran)) { this.guessed.delete(ran); this.saveHolds(); this.options.onChange?.(); }
    }
  }

  /** The engine's own usage limit refused a turn: held until the reset it named, or for an hour after this refusal when
   * it named none (a guess, never shown as a reset time). A reset already past (a stale window, a skewed clock) names
   * none: the refusal still holds the engine, so the next turn does not go there again at once. */
  noteLimit(engine: string | undefined, resetsAt: number | undefined): void {
    if (resetsAt !== undefined && resetsAt > this.now()) return this.noteRefusal(engine, resetsAt);
    // A reset the engine named still stands: a refusal that names none never shortens it.
    if (!engine || ((this.refusal(engine) ?? 0) > this.now() && !this.guessed.has(engine))) return;
    this.hold(engine, this.now() + UNNAMED_LIMIT_MS, true);
  }

  /** A turn on this engine was refused by its usage limit; `resetsAt` is when the engine said it resets. */
  noteRefusal(engine: string | undefined, resetsAt: number | undefined): void {
    if (!engine || resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= this.now() || (this.refusals.get(engine) === resetsAt && !this.guessed.has(engine))) return;
    this.hold(engine, resetsAt, false);
  }

  private hold(engine: string, until: number, guessed: boolean): void {
    if (guessed) this.guessed.add(engine);
    else this.guessed.delete(engine);
    this.refusals.set(engine, until);
    this.saveHolds();
    this.options.onChange?.();
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => { this.soon = null; void this.refresh(true); }, SOON_AFTER_REFUSAL_MS);
    this.soon.unref?.();
  }

  noteUsage(report: PlanUsageReport): void {
    const next = new Map<string, EngineLimit>();
    for (const row of report.providers) {
      const limit = engineLimitFromUsage(row);
      if (limit) next.set(limit.engine, limit);
    }
    this.usage = next;
    this.checkedAt = this.now();
    this.options.onChange?.();
  }

  /** Reads usage again when what is known is older than `maxAgeMs`; one read at a time. */
  async ensureFresh(maxAgeMs = LIMIT_POLL_MS): Promise<void> {
    if (this.now() - this.checkedAt < maxAgeMs) return;
    await this.refresh(false);
  }

  async refresh(force: boolean): Promise<void> {
    if (this.loading) return this.loading;
    const accounts = this.options.accounts();
    this.loading = (async () => {
      try {
        if (accounts.length) this.noteUsage(await this.load(accounts, force));
        else this.checkedAt = this.now();
      } catch {
        this.checkedAt = this.now();
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { if (this.options.waiting?.()) void this.ensureFresh(LIMIT_POLL_MS - 1_000); }, 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = this.soon = null;
  }

  private load(accounts: PlanAccount[], force: boolean): Promise<PlanUsageReport> {
    if (this.options.loadUsage) return this.options.loadUsage(accounts, force);
    const fixture = process.env.OMB_TEST_PLAN_USAGE_FILE;
    if (fixture) return Promise.resolve(fixtureUsage(fixture, this.now()));
    return loadPlanUsage({ accounts, refresh: force });
  }

  private refusal(engine: string): number | null {
    const at = this.refusals.get(engine);
    if (at === undefined) return null;
    if (at < this.now() - REFUSAL_GRACE_MS) {
      this.refusals.delete(engine);
      this.guessed.delete(engine);
      this.saveHolds();
      return null;
    }
    return at;
  }

  /** The holds a restart left, without the ones already past. */
  private loadHolds(): void {
    if (!this.options.file) return;
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(this.options.file, "utf8")); } catch { return; }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [engine, hold] of Object.entries(saved as Record<string, { until?: unknown; guessed?: unknown } | null>)) {
      const until = hold?.until;
      if (typeof until !== "number" || !Number.isFinite(until) || until < this.now() - REFUSAL_GRACE_MS) continue;
      this.refusals.set(engine, until);
      if (hold?.guessed === true) this.guessed.add(engine);
    }
  }

  private saveHolds(): void {
    if (!this.options.file) return;
    const holds = Object.fromEntries([...this.refusals].map(([engine, until]) => [engine, { until, guessed: this.guessed.has(engine) }]));
    try {
      writeFileAtomic(this.options.file, JSON.stringify(holds), { mode: 0o600 });
    } catch (error) {
      console.error(`limit holds: could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private unnamed(engine: string): EngineLimit {
    const account = this.options.accounts().find((candidate) => candidate.id === engine);
    return { engine, name: account?.name ?? engine, driver: account?.driver ?? "claude", window: null, usedPercent: null, resetsAt: null, blocked: false };
  }
}
