// The engines' usage limits as the app shows them: "Claude: 92% used · resets 3:40 PM", the calendar's reset markers,
// and the automations due before a reset. One shared poll of /api/limit-resets feeds every place that shows them.
import { useEffect, useState } from "react";

import { AFTER_RESET_MS, NEAR_LIMIT_PERCENT, nearLimit, type EngineLimit, type EngineLimitsReport, type LimitResetSchedule, type LimitWindowName } from "../../shared/limit-reset";
import { intlLocale, t } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import { unlessRefused } from "@/lib/admin-scope";
import { api } from "@/state/store";

export { AFTER_RESET_MS, nearLimit, NEAR_LIMIT_PERCENT, isLimitResetSchedule, type EngineLimit, type LimitResetSchedule } from "../../shared/limit-reset";

const POLL_MS = 60_000;
const names = new Map<string, string>();
let report: EngineLimitsReport | null = null;
let loading: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(next: EngineLimitsReport) => void>();

/** "Claude", "Codex", or the engine's own name; an engine the server has not named yet reads as its id, capitalised. */
export function engineName(engine: string): string {
  return names.get(engine) ?? (engine.charAt(0).toUpperCase() + engine.slice(1));
}

/** A server that predates limit resets answers without engines: that reads as none. */
export function rememberLimits(next: Partial<EngineLimitsReport> | null | undefined): void {
  report = { checkedAt: next?.checkedAt ?? 0, engines: Array.isArray(next?.engines) ? next.engines : [] };
  for (const limit of report.engines) names.set(limit.engine, limit.name);
  for (const listener of listeners) listener(report);
}

function readLimits(request: () => Promise<EngineLimitsReport>): Promise<void> {
  return unlessRefused("/api/limit-resets", request, null)
    .then((next) => { if (next) rememberLimits(next); }, () => undefined);
}

/** A person's refresh always asks again; a background read joins the one already on its way. */
export function loadLimits(refresh = false): Promise<void> {
  if (refresh) return readLimits(() => api<EngineLimitsReport>("/api/limit-resets?refresh=1"));
  loading ??= readLimits(() => api<EngineLimitsReport>("/api/limit-resets", { background: true })).finally(() => { loading = null; });
  return loading;
}

/** "Try again now": the server ends the engine's limit hold, so the next turn goes to it; a refusal holds it again. */
export async function releaseLimit(engine: string): Promise<void> {
  rememberLimits(await api<EngineLimitsReport>("/api/limit-resets/release", { method: "POST", body: JSON.stringify({ engine }) }));
}

/** When the server last read the engines' usage; 0 before any read. */
export const limitsCheckedAt = () => report?.checkedAt ?? 0;

/** Every engine's limit, kept fresh while something on screen shows it. */
export function useEngineLimits(): EngineLimit[] {
  const [engines, setEngines] = useState<EngineLimit[]>(() => report?.engines ?? []);
  useEffect(() => {
    const listener = (next: EngineLimitsReport) => setEngines(next.engines);
    listeners.add(listener);
    if (report) setEngines(report.engines);
    void loadLimits();
    timer ??= setInterval(() => void loadLimits(), POLL_MS);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
  return engines;
}

/** A clock time today, or a weekday and time further out. */
export function resetTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return date.toLocaleString(intlLocale(), sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** "Claude: 92% used · resets 3:40 PM", or "Claude: at its limit · resets 3:40 PM"; a screen reader's copy joins with a comma. */
export function limitLine(limit: EngineLimit, now = Date.now(), separator = " · "): string {
  const used = limit.blocked ? t("limits.atLimit", { engine: limit.name }) : t("limits.used", { engine: limit.name, percent: Math.round(limit.usedPercent ?? 0) });
  return limit.resetsAt !== null && limit.resetsAt > now ? `${used}${separator}${t("limits.resets", { time: resetTime(limit.resetsAt, now) })}` : used;
}

export const nearLimitEngines = (engines: readonly EngineLimit[]) => engines.filter(nearLimit);

export type UsageTone = "fine" | "near" | "out";

export const USAGE_BARS = 4;

/** An engine that reports usage; API keys and local models report none, and show nothing. */
export const reportsUsage = (limit: EngineLimit | undefined): limit is EngineLimit => Boolean(limit && (limit.blocked || limit.usedPercent !== null));

export function usageTone(limit: Pick<EngineLimit, "usedPercent" | "blocked">): UsageTone {
  if (limit.blocked || (limit.usedPercent ?? 0) >= 100) return "out";
  return nearLimit(limit) ? "near" : "fine";
}

/** Filled bars for the share of the deciding window left: none at the limit, one through the near-limit band, so a
 * single bar is always the warning one, and the room above that band in equal thirds: 2, 3, then 4 above 70% left. */
export function usageBars(limit: Pick<EngineLimit, "usedPercent" | "blocked">): number {
  const tone = usageTone(limit);
  if (tone !== "fine") return tone === "near" ? 1 : 0;
  const band = 100 - NEAR_LIMIT_PERCENT;
  const third = (100 - band) / 3;
  const left = 100 - (limit.usedPercent ?? 0);
  return left > band + 2 * third ? 4 : left > band + third ? 3 : 2;
}

export interface UsageRow {
  window: LimitWindowName;
  /** Whole percent left, 0–100. */
  left: number;
  resetsAt: number | null;
  tone: UsageTone;
}

/** One row per window the engine reported, or the deciding window alone from a server that sends no list. A blocked
 * engine's deciding window is at its limit until the engine's own reset, which a refusal can name apart from usage. */
export function usageRows(limit: EngineLimit): UsageRow[] {
  const windows = limit.windows?.length ? limit.windows : reportsUsage(limit)
    ? [{ window: limit.window ?? "other", usedPercent: limit.usedPercent ?? 100, resetsAt: limit.resetsAt }] : [];
  const deciding = windows.some((entry) => entry.window === limit.window) ? limit.window : windows[0]?.window;
  return windows.map((entry) => {
    const refused = limit.blocked && entry.window === deciding;
    const tone = refused ? "out" : usageTone({ usedPercent: entry.usedPercent, blocked: false });
    return { window: entry.window, left: tone === "out" ? 0 : Math.max(0, 100 - Math.round(entry.usedPercent)), resetsAt: refused ? limit.resetsAt : entry.resetsAt, tone };
  });
}

export function windowLabel(window: LimitWindowName): string {
  return window === "5-hour" ? t("planUsage.fiveHour") : window === "weekly" ? t("planUsage.weekly") : t("usage.title");
}

export interface ResetMarker { engine: string; name: string; at: number }

/** The calendar's markers: each engine's next known reset inside the range. */
export function resetMarkers(engines: readonly EngineLimit[], from: number, to: number, now = Date.now()): ResetMarker[] {
  return engines.flatMap((limit) => limit.resetsAt !== null && limit.resetsAt >= Math.max(from, now) && limit.resetsAt < to
    ? [{ engine: limit.engine, name: limit.name, at: limit.resetsAt }] : []);
}

/** Schedules whose next run comes before `engine`'s reset, on a bot that works on that engine: "Move to after reset". */
export function dueBeforeReset(routines: readonly Routine[], botEngine: (botId: string) => string | undefined, limit: EngineLimit, now = Date.now()): Routine[] {
  if (limit.resetsAt === null || limit.resetsAt <= now) return [];
  return routines.filter((routine) => routine.enabled && routine.schedule.type !== "limit_reset" && routine.nextRunAt !== null &&
    routine.nextRunAt < limit.resetsAt! + AFTER_RESET_MS && botEngine(routine.botId) === limit.engine);
}

/** "When your Claude limit resets", or "Each time your Claude limit resets". */
export function limitResetWhen(schedule: Pick<LimitResetSchedule, "engine" | "repeat">): string {
  return t(schedule.repeat === "every_reset" ? "automations.when.everyLimitReset" : "automations.when.limitReset", { engine: engineName(schedule.engine) });
}
