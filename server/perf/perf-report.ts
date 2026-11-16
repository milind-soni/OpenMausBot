// The timings as the Admin's health read carries them (compact JSON under PERF_HEALTH_MAX_BYTES) and as people read them
// (plain lines for a @devs report and the desktop's diagnostics). Built only from the turn records' checked fields, the
// process buckets and the limit clock's driver kinds, windows and times: nothing else reaches either.
import type { EngineLimitsReport } from "../../shared/limit-reset.ts";
import type { DayAggregate } from "./day-ledger.ts";
import { SLOW_TURN_MS } from "./day-ledger.ts";
import { PHASES, type Phase, type PhaseStats } from "./phases.ts";
import type { ProcessReport } from "./process-sampler.ts";
import type { LiveTurnView, WindowStats } from "./turn-timings.ts";
import type { TurnTiming } from "./turn-record.ts";

/** The health report's `perf` field is at most this many bytes of JSON; parts are dropped, least useful first, to fit. */
export const PERF_HEALTH_MAX_BYTES = 8 * 1024;
export const PERF_HEALTH_VERSION = 1;
const LIVE_SHOWN = 5, TOOLS_SHOWN = 8, HOLDS_SHOWN = 8;
const LIMIT_DRIVERS = new Set(["claude", "codex", "grok", "opencode"]);
const WINDOWS = new Set(["5-hour", "weekly", "other"]);

export interface LimitHold { driver: string; window: string | null; usedPercent: number | null; resetsAt: number | null; blocked: boolean; held: boolean }

export interface PerfSources {
  hour: WindowStats;
  day: DayAggregate;
  live: LiveTurnView[];
  limits: EngineLimitsReport | null | undefined;
  process: ProcessReport | null;
}

/** Engines refusing work, or within 10 points of their limit: driver kind, window, use and reset time only. */
export function limitHolds(report: EngineLimitsReport | null | undefined): LimitHold[] {
  return (report?.engines ?? []).filter((limit) => LIMIT_DRIVERS.has(limit.driver) && (limit.blocked || (limit.usedPercent ?? 0) >= 90)).map((limit) => ({
    driver: limit.driver, window: limit.window && WINDOWS.has(limit.window) ? limit.window : null,
    usedPercent: typeof limit.usedPercent === "number" ? Math.round(limit.usedPercent) : null,
    resetsAt: typeof limit.resetsAt === "number" && Number.isFinite(limit.resetsAt) ? limit.resetsAt : null, blocked: limit.blocked === true, held: limit.held === true,
  })).slice(0, HOLDS_SHOWN);
}

const phasesOf = (phases: Partial<Record<Phase, PhaseStats>>) => Object.fromEntries(PHASES.flatMap((phase) => (phases[phase] ? [[phase, phases[phase]]] : [])));

export function perfHealth(sources: PerfSources) {
  const { hour, day } = sources;
  const body = {
    v: PERF_HEALTH_VERSION,
    slowEdgesMs: [...SLOW_TURN_MS],
    h1: { turns: hour.turns, failed: hour.failed, partial: hour.partial, slow: hour.slow, phases: phasesOf(hour.phases) },
    h24: { turns: day.turns, failed: day.failed, slow: day.slow, phases: phasesOf(day.phases), tools: day.tools.slice(0, TOOLS_SHOWN), retries: day.retries, limits: day.limits, failovers: day.failovers },
    live: sources.live.slice(0, LIVE_SHOWN),
    holds: limitHolds(sources.limits),
    process: sources.process,
  };
  const size = () => JSON.stringify(body).length;
  if (size() > PERF_HEALTH_MAX_BYTES && body.process) body.process = { ...body.process, buckets: body.process.buckets.slice(0, 6) };
  if (size() > PERF_HEALTH_MAX_BYTES) body.h24.tools = body.h24.tools.slice(0, 4);
  if (size() > PERF_HEALTH_MAX_BYTES) body.live = body.live.slice(0, 2);
  if (size() > PERF_HEALTH_MAX_BYTES) body.process = null;
  return body;
}
export type PerfHealth = ReturnType<typeof perfHealth>;

/** 850ms, 14s, 6m12s, 1h03m. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
const phaseLine = (phases: Partial<Record<Phase, PhaseStats>>) =>
  PHASES.flatMap((phase) => { const stats = phases[phase]; return stats ? [`${phase} p50 ${duration(stats.p50)} p95 ${duration(stats.p95)} max ${duration(stats.max)}`] : []; }).join("; ");
const slowLine = (slow: number[]) => SLOW_TURN_MS.map((edge, index) => `${slow[index] ?? 0} over ${duration(edge)}`).join(", ");
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const counts = (map: Record<string, number>) => Object.entries(map).sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(", ");

export function turnLine(turn: TurnTiming): string {
  const parts = PHASES.filter((phase) => phase !== "total" && turn.ms[phase] !== undefined)
    .map((phase) => `${phase} ${duration(turn.ms[phase]!)}${phase === "queue" && turn.queueWhy ? ` (${turn.queueWhy})` : ""}`);
  const tools = turn.tools.map((tool) => `${tool.kind} ${tool.n}x ${duration(tool.ms)}${tool.errors ? ` ${tool.errors} failed` : ""}${tool.open ? ` ${tool.open} left open` : ""}`);
  const extra = [
    turn.retries ? `retries ${turn.retries} (${(turn.retryWhy ?? []).join(", ")}), backoff ${duration(turn.backoffMs)}` : "",
    turn.limit ? `usage limit (${turn.limit})${turn.limitResetsAt ? ` resets ${iso(turn.limitResetsAt)}` : ""}` : "",
    turn.failover ? `moved to a backup AI (${turn.failover})` : "",
  ].filter(Boolean);
  return `${iso(turn.startedAt)} bot ${turn.botId ?? "?"} thread ${turn.threadId ?? "?"} ${turn.engine ?? "?"} ${turn.stop} ${duration(turn.ms.total ?? 0)}: ${parts.join(", ")}`
    + (tools.length ? ` [${tools.join("; ")}]` : "") + (extra.length ? `; ${extra.join("; ")}` : "");
}

/** Plain lines for people: the last hour and day, what runs now, usage limits, processes and the given recent turns. */
export function perfLines(sources: PerfSources, recent: readonly TurnTiming[], recentTitle: string): string[] {
  const { hour, day } = sources;
  const lines = ["## Performance (timings only: no messages, names, files or addresses)"];
  lines.push(`Last hour: ${plural(hour.turns, "turn")}, ${hour.failed} failed${hour.partial ? " (only the latest 200 kept)" : ""}; slow: ${slowLine(hour.slow)}`);
  if (hour.turns) lines.push(`  ${phaseLine(hour.phases)}`);
  lines.push(`Last 24 h: ${plural(day.turns, "turn")}, ${day.failed} failed; slow: ${slowLine(day.slow)}`);
  if (day.turns) lines.push(`  ${phaseLine(day.phases)}`);
  if (day.tools.length) lines.push(`  Tool kinds by time: ${day.tools.slice(0, TOOLS_SHOWN).map((tool) =>
    `${tool.kind} ${duration(tool.ms)} (${plural(tool.n, "call")}, p95 ${duration(tool.p95)}, max ${duration(tool.max)}${tool.errors ? `, ${tool.errors} failed` : ""}${tool.open ? `, ${tool.open} left open` : ""})`).join("; ")}`);
  if (day.retries.n) lines.push(`  Retries: ${day.retries.n} in ${plural(day.retries.turns, "turn")}, ${duration(day.retries.backoffMs)} of backoff (${counts(day.retries.why)})`);
  if (Object.keys(day.limits).length || day.failovers) lines.push(`  Usage limits refused: ${counts(day.limits) || "none"}; moved to a backup AI: ${day.failovers}`);
  const holds = limitHolds(sources.limits);
  lines.push(`Usage limits now: ${holds.length ? holds.map((hold) => `${hold.driver} ${hold.window ?? "?"} ${hold.usedPercent ?? "?"}%${hold.blocked ? " refusing work" : ""}${hold.resetsAt ? ` until ${iso(hold.resetsAt)}` : ""}`).join("; ") : "none near or at a limit"}`);
  lines.push(`Running now: ${sources.live.length ? sources.live.slice(0, LIVE_SHOWN).map((turn) =>
    `bot ${turn.botId ?? "?"} thread ${turn.threadId ?? "?"} ${turn.engine ?? "?"} ${duration(turn.ageMs)}, ${turn.state}${turn.tool ? ` (${turn.tool})` : ""} for ${duration(turn.stateMs)}`).join("; ") : "no turn"}`);
  const proc = sources.process;
  if (proc && proc.samples) {
    lines.push(`Processes, last hour (${proc.scope === "all" ? "every process here" : "this app's own"}, sampled every ${proc.intervalS}s): ${proc.buckets.map((bucket) =>
      `${bucket.bucket} ${bucket.cpu60mS}s CPU (5 min ${bucket.cpu5mS}s, peak ${bucket.peakPct}% of a core, ${bucket.procs} running, ${bucket.rssMB} MB)`).join("; ")}`);
    lines.push(`  Browsers running: ${proc.browsers}${proc.unseen60mS !== null ? `; CPU no sample accounts for: ${proc.unseen60mS}s` : ""}`);
    lines.push(`Event loop: busy ${proc.loop.eluPct ?? "?"}% (max ${proc.loop.eluMaxPct ?? "?"}%), timer late p95 ${duration(proc.loop.driftP95Ms)}, max ${duration(proc.loop.driftMaxMs)}`);
  } else lines.push("Processes: not sampled yet");
  lines.push(recentTitle);
  lines.push(...(recent.length ? recent.map((turn) => `  ${turnLine(turn)}`) : ["  (none)"]));
  return lines;
}
