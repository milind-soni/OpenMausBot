// Where a direct turn's setup time goes, between its message being stored and its engine being asked: one fixed name per
// awaited step and per long synchronous stretch. Numbers only; a step's name never comes from outside this list.
import { exactQuantile, type PhaseStats } from "./phases.ts";

/**
 * `handoff`: what the request that sent the message still had to do before the first step could run. `engineRead`: the
 * engine's first status read. `cloudReady`: a cloud routine's computer. `summaries`: a summary of the conversation still
 * being written that this turn needs. `videoFrames`: frames cut from attached videos. `compact`: conversation compaction.
 * `context`: choosing what the engine is shown of the conversation. `apps`: connected apps. `mcp`: the bot's own MCP
 * servers. `workspace`: the bot's folders and skills. `ownCloud`: a hand-off's own cloud computer. `computer`: mounting
 * the place the bot works. `localVm`: the private desktop when no place was named. `checkpoint`: the project snapshot.
 * `browser`: the bot's browser. `handshakeClear`: a stopped turn's engine start still unwinding. `prompt`: the system
 * prompt. `sync`: every other synchronous stretch. `total`: all of it.
 */
export const SETUP_STEPS = ["handoff", "engineRead", "cloudReady", "summaries", "videoFrames", "compact", "context", "apps", "mcp", "workspace", "ownCloud",
  "computer", "localVm", "checkpoint", "browser", "handshakeClear", "prompt", "sync", "total"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupMs = Partial<Record<SetupStep, number>>;
export type SetupStats = Partial<Record<SetupStep, PhaseStats>>;

/** Each lap takes the time since the one before it; a name lapped twice adds up. The first lap, `handoff`, is taken by
 * itself as soon as the code that made the clock has run to its end. */
export function createSetupClock(now: () => number = () => performance.now(), soon: (run: () => void) => void = queueMicrotask) {
  const startedAt = now();
  let last = startedAt, done = false;
  const spent: SetupMs = {};
  const lap = (step: Exclude<SetupStep, "total">) => {
    if (done) return;
    const at = now();
    spent[step] = (spent[step] ?? 0) + Math.max(0, at - last);
    last = at;
  };
  soon(() => lap("handoff"));
  return {
    lap,
    /** Whole milliseconds; a step under one is left out. */
    done(): SetupMs {
      lap("sync");
      done = true;
      const out: SetupMs = { total: Math.round(Math.max(0, last - startedAt)) };
      for (const step of SETUP_STEPS) {
        const ms = Math.round(spent[step] ?? 0);
        if (step !== "total" && ms >= 1) out[step] = ms;
      }
      return out;
    },
  };
}
export type SetupClock = ReturnType<typeof createSetupClock>;

/** Setup timings from outside (the saved file, a caller): known steps with whole, finite, non-negative numbers only. */
export function parseSetupMs(value: unknown): SetupMs | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>, out: SetupMs = {};
  for (const step of SETUP_STEPS) {
    const ms = Object.hasOwn(raw, step) ? raw[step] : undefined;
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) out[step] = Math.min(Math.round(ms), 1e10);
  }
  return out.total === undefined ? undefined : out;
}

export function setupStatsOf(turns: ReadonlyArray<{ setup?: SetupMs }>): SetupStats {
  const stats: SetupStats = {};
  for (const step of SETUP_STEPS) {
    const values = turns.flatMap((turn) => (turn.setup?.[step] === undefined ? [] : [turn.setup[step]])).sort((left, right) => left - right);
    if (values.length) stats[step] = { p50: exactQuantile(values, 0.5), p95: exactQuantile(values, 0.95), max: values.at(-1)!, n: values.length };
  }
  return stats;
}

/** The whole setup, then its steps with the highest 95th percentile first, at most `kept` of them. */
export function slowestSetupSteps(stats: SetupStats, kept: number): Array<[SetupStep, PhaseStats]> {
  const steps = SETUP_STEPS.flatMap((step) => (step !== "total" && stats[step] ? [[step, stats[step]] as [SetupStep, PhaseStats]] : []))
    .sort((left, right) => right[1].p95 - left[1].p95 || right[1].max - left[1].max).slice(0, kept);
  return [...(stats.total ? [["total", stats.total] as [SetupStep, PhaseStats]] : []), ...steps];
}
