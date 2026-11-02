// The engines' usage limits as the app shows them: "Claude: 92% used · resets 3:40 PM", the calendar's reset markers,
// and the automations due before a reset. One shared poll of /api/limit-resets feeds every place that shows them.
import { useEffect, useState } from "react";

import { AFTER_RESET_MS, nearLimit, type EngineLimit, type EngineLimitsReport, type LimitResetSchedule } from "../../shared/limit-reset";
import { t } from "@/lib/i18n";
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
  return date.toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** "Claude: 92% used · resets 3:40 PM", or "Claude: at its limit · resets 3:40 PM". */
export function limitLine(limit: EngineLimit, now = Date.now()): string {
  const used = limit.blocked ? t("limits.atLimit", { engine: limit.name }) : t("limits.used", { engine: limit.name, percent: Math.round(limit.usedPercent ?? 0) });
  return limit.resetsAt !== null && limit.resetsAt > now ? `${used} · ${t("limits.resets", { time: resetTime(limit.resetsAt, now) })}` : used;
}

export const nearLimitEngines = (engines: readonly EngineLimit[]) => engines.filter(nearLimit);

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
