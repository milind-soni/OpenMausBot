import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cloud,
  ExternalLink,
  History,
  Laptop,
  LayoutList,
  Loader2,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
  Webhook,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { WebhooksPanel } from "@/components/WebhooksPanel";
import { cn } from "@/lib/cn";
import { MAUS_COLORS, type MausState } from "@/lib/mascot";
import type { Routine, RoutineInput, RoutineRun, RoutineRunOn, RoutineRunStatus } from "@/lib/routines";
import { tokenUsageLabel } from "@/lib/usage";
import { api, useStore, type Bot } from "@/state/store";

const HOUR_HEIGHT = 68;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type CalendarItem = {
  id: string;
  at: number;
  routine: Routine | null;
  run: RoutineRun | null;
};

type OperationsSnapshot = {
  generatedAt: number;
  capture: {
    sourceHealth: Array<{ botId: string; sourceId: string; status: string; freshness?: "fresh" | "stale" | "unknown"; lastSuccessAt: number | null; lastAttemptAt: number; lastError: string | null }>;
    memory: { activeItems: number; tombstones: number; sensitiveItems: number; bySource: Array<{ sourceId: string; count: number }> };
  };
  routines: {
    active: RoutineRun[];
    overlong: RoutineRun[];
    failuresToday: RoutineRun[];
    skippedToday: RoutineRun[];
    usageToday: { inputTokens: number; outputTokens: number; costUsd: number; reportedRuns: number; unreportedRuns: number };
    budgets: Array<{ id: string; name: string; budget: NonNullable<Routine["budget"]> }>;
  };
  performance: {
    summary: {
      turns: number;
      medianProviderStartupMs: number | null;
      medianFirstVisibleMs: number | null;
      p95FirstVisibleMs: number | null;
      medianCompletionMs: number | null;
      tokenTurnsProvider: number;
      tokenTurnsEstimated: number;
      tokenTurnsUnavailable: number;
      providerReportedCoverage: number | null;
      estimatedTokens: number;
      coldTurns?: number;
      warmTurns?: number;
      unknownTurns?: number;
      reuseRate?: number | null;
      medianColdFirstVisibleMs?: number | null;
      medianWarmFirstVisibleMs?: number | null;
    };
  };
  webhooks: { available: boolean; error?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperationsSnapshot(value: unknown): value is OperationsSnapshot {
  if (!isRecord(value) || typeof value.generatedAt !== "number" || !isRecord(value.capture) || !isRecord(value.routines) || !isRecord(value.performance) || !isRecord(value.webhooks)) return false;
  const capture = value.capture;
  const routines = value.routines;
  const memory = capture.memory;
  const usage = routines.usageToday;
  const performanceSummary = value.performance.summary;
  return Array.isArray(capture.sourceHealth)
    && isRecord(memory)
    && typeof memory.activeItems === "number"
    && typeof memory.tombstones === "number"
    && typeof memory.sensitiveItems === "number"
    && Array.isArray(memory.bySource)
    && Array.isArray(routines.active)
    && Array.isArray(routines.overlong)
    && Array.isArray(routines.failuresToday)
    && Array.isArray(routines.skippedToday)
    && Array.isArray(routines.budgets)
    && isRecord(usage)
    && typeof usage.inputTokens === "number"
    && typeof usage.outputTokens === "number"
    && typeof usage.costUsd === "number"
    && typeof usage.reportedRuns === "number"
    && typeof usage.unreportedRuns === "number"
    && isRecord(performanceSummary)
    && typeof performanceSummary.turns === "number"
    && typeof performanceSummary.tokenTurnsProvider === "number"
    && typeof performanceSummary.tokenTurnsEstimated === "number"
    && typeof performanceSummary.tokenTurnsUnavailable === "number"
    && (performanceSummary.providerReportedCoverage === null || typeof performanceSummary.providerReportedCoverage === "number")
    && typeof performanceSummary.estimatedTokens === "number"
    && (performanceSummary.coldTurns === undefined || typeof performanceSummary.coldTurns === "number")
    && (performanceSummary.warmTurns === undefined || typeof performanceSummary.warmTurns === "number")
    && (performanceSummary.unknownTurns === undefined || typeof performanceSummary.unknownTurns === "number")
    && (performanceSummary.reuseRate === undefined || performanceSummary.reuseRate === null || typeof performanceSummary.reuseRate === "number")
    && (performanceSummary.medianColdFirstVisibleMs === undefined || performanceSummary.medianColdFirstVisibleMs === null || typeof performanceSummary.medianColdFirstVisibleMs === "number")
    && (performanceSummary.medianWarmFirstVisibleMs === undefined || performanceSummary.medianWarmFirstVisibleMs === null || typeof performanceSummary.medianWarmFirstVisibleMs === "number")
    && typeof value.webhooks.available === "boolean";
}

function startOfDay(at: number) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(at: number, days: number) {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function startOfWeek(at: number) {
  const date = new Date(startOfDay(at));
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

function atLocalTime(day: number, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(day);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

function toInputDateTime(at: number) {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function niceDate(at: number, includeWeekday = true) {
  return new Date(at).toLocaleDateString([], {
    weekday: includeWeekday ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: new Date(at).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function niceTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function scheduleLabel(routine: Routine) {
  if (routine.schedule.type === "once") {
    return `${niceDate(routine.schedule.at)}, ${niceTime(routine.schedule.at)}`;
  }
  const days = routine.schedule.weekdays;
  const dayLabel =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => DAY_NAMES[day]).join(", ");
  if (routine.schedule.type === "interval") {
    const cadence = routine.schedule.everyMinutes === 1 ? "Every minute" : `Every ${routine.schedule.everyMinutes} minutes`;
    return `${dayLabel}, ${cadence.toLowerCase()}, ${niceTime(atLocalTime(Date.now(), routine.schedule.from))}–${niceTime(atLocalTime(Date.now(), routine.schedule.to))}`;
  }
  return `${dayLabel} at ${niceTime(atLocalTime(Date.now(), routine.schedule.time))}`;
}

function canToggleRoutine(routine: Routine) {
  return routine.schedule.type !== "once" || routine.schedule.at > Date.now();
}

function statusState(status: RoutineRunStatus): MausState {
  switch (status) {
    case "queued":
      return "drowsy";
    case "running":
      return "working";
    case "waiting":
      return "curious";
    case "blocked":
      return "sad";
    case "completed":
    case "verified":
      return "proud";
    case "failed":
    case "missed":
      return "sad";
    case "cancelled":
    case "skipped":
      return "sleeping";
  }
}

function statusTone(status: RoutineRunStatus) {
  switch (status) {
    case "running":
      return "text-accent";
    case "waiting":
      return "text-warning";
    case "blocked":
      return "text-danger";
    case "completed":
    case "verified":
      return "text-success";
    case "failed":
    case "missed":
      return "text-danger";
    default:
      return "text-ink-secondary";
  }
}

function nextHour() {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function webhookPromptParts(prompt?: string) {
  if (!prompt) return null;
  const instructions = prompt.match(/\[USER-CONFIGURED WEBHOOK INSTRUCTIONS\]\n([\s\S]*?)\n\[\/USER-CONFIGURED WEBHOOK INSTRUCTIONS\]/)?.[1];
  const eventData = prompt.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1];
  return instructions && eventData ? { instructions, eventData } : null;
}

function projectedItems(routines: Routine[], runs: RoutineRun[], from: number, to: number): CalendarItem[] {
  const items: CalendarItem[] = runs
    .filter((run) => run.scheduledFor >= from && run.scheduledFor < to)
    .map((run) => ({
      id: `run-${run.id}`,
      at: run.scheduledFor,
      routine: routines.find((routine) => routine.id === run.routineId) ?? null,
      run,
    }));

  const hasReceipt = (routineId: string, at: number) =>
    runs.some((run) => run.routineId === routineId && Math.abs(run.scheduledFor - at) < 60_000);

  for (const routine of routines) {
    if (!routine.enabled) continue;
    if (routine.schedule.type === "once") {
      const at = routine.schedule.at;
      if (at >= from && at < to && !hasReceipt(routine.id, at)) {
        items.push({ id: `next-${routine.id}-${at}`, at, routine, run: null });
      }
      continue;
    }
    if (routine.schedule.type === "interval") {
      const at = routine.nextRunAt;
      if (at != null && at >= from && at < to && !hasReceipt(routine.id, at)) {
        items.push({ id: `next-${routine.id}-${at}`, at, routine, run: null });
      }
      continue;
    }
    for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
      const date = new Date(day);
      if (!routine.schedule.weekdays.includes(date.getDay())) continue;
      const at = atLocalTime(day, routine.schedule.time);
      if (at >= from && at < to && at >= routine.createdAt && !hasReceipt(routine.id, at)) {
        items.push({ id: `next-${routine.id}-${at}`, at, routine, run: null });
      }
    }
  }
  return items.sort((a, b) => a.at - b.at);
}

function RoutineCard({ item, bot, compact, onOpen }: { item: CalendarItem; bot: Bot; compact: boolean; onOpen: () => void }) {
  const status = item.run?.status;
  const color = MAUS_COLORS[bot.color];
  const title = item.routine?.name ?? item.run?.routineName ?? "Routine";
  const animated = status === "running" || status === "waiting";
  return (
    <button
      data-centipede-calendar-tile
      data-compact={compact ? "true" : "false"}
      data-status={status ?? "scheduled"}
      onClick={onOpen}
      className={cn(
        "centipede-calendar-tile group absolute left-1.5 right-1.5 z-10 overflow-hidden py-1.5 text-left",
        compact ? "px-1.5" : "px-2",
        status === "cancelled" && "opacity-55",
      )}
      style={{
        top: `${((new Date(item.at).getHours() * 60 + new Date(item.at).getMinutes()) / 60) * HOUR_HEIGHT}px`,
        minHeight: item.run?.triggerSource === "webhook"
          ? "48px"
          : `${Math.max(48, ((item.routine?.durationMinutes ?? item.run?.durationMinutes ?? 30) / 60) * HOUR_HEIGHT)}px`,
      }}
    >
      <span className="centipede-calendar-tile-accent" style={{ backgroundColor: color }} aria-hidden="true" />
      <div className={cn("flex min-w-0 items-center", compact ? "gap-1.5" : "gap-2")}>
        <BotAvatar
          bot={bot}
          state={status ? statusState(status) : "idle"}
          size={compact ? 32 : 38}
          animated={animated}
          trackPointer={animated}
          label={`${bot.name} — ${title}`}
        />
        <div className="min-w-0 flex-1">
          <div className="centipede-calendar-tile-title truncate text-[12px] font-semibold">{title}</div>
          <div className="centipede-calendar-tile-meta mt-0.5 flex items-center gap-1.5 truncate text-[10.5px]">
            {animated && <Loader2 size={10} className="animate-spin" />}
            <span>{niceTime(item.at)}</span>
            <span>·</span>
            {item.run?.triggerSource === "webhook" && <><Webhook size={10} /><span>Webhook</span><span>·</span></>}
            <span className="truncate">
              {status ? status.replace("waiting", "needs you") : bot.name}
              {(item.routine?.runOn ?? item.run?.runOn) === "cloud" ? " · VM" : ""}
            </span>
          </div>
        </div>
        {(status === "blocked" || status === "failed") && !item.run?.seenAt && <span className="centipede-calendar-tile-alert size-2 shrink-0 rounded-full bg-danger" />}
      </div>
    </button>
  );
}

function CalendarGrid({
  anchor,
  days,
  items,
  bots,
  onOpen,
}: {
  anchor: number;
  days: number;
  items: CalendarItem[];
  bots: Bot[];
  onOpen: (item: CalendarItem) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = startOfDay(Date.now());
  const starts = Array.from({ length: days }, (_, index) => addDays(anchor, index));
  const minDayWidth = days === 7 ? 110 : days === 3 ? 180 : 300;
  const gridTemplateColumns = `58px repeat(${days}, minmax(${minDayWidth}px, 1fr))`;
  const minWidth = 58 + days * minDayWidth;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: HOUR_HEIGHT * 7 - 24 });
  }, [days]);

  return (
    <div ref={scrollRef} className="centipede-calendar-grid min-h-0 flex-1 overflow-auto border-t border-hairline/40">
      <div className="centipede-calendar-header sticky top-0 z-30 grid bg-app/95 backdrop-blur" style={{ gridTemplateColumns, minWidth }}>
        <div className="border-b border-r border-hairline/40" />
        {starts.map((start) => {
          const isToday = start === today;
          const date = new Date(start);
          return (
            <div key={start} className="border-b border-r border-hairline/40 px-3 py-2.5 text-center last:border-r-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-secondary">{DAY_NAMES[date.getDay()]}</div>
              <div className={cn("mx-auto mt-1 flex size-7 items-center justify-center rounded-full text-[14px] font-semibold", isToday ? "bg-accent text-white" : "text-ink")}>{date.getDate()}</div>
            </div>
          );
        })}
      </div>
      <div className="centipede-calendar-body relative grid" style={{ height: HOUR_HEIGHT * 24, gridTemplateColumns, minWidth }}>
        <div className="relative border-r border-hairline/40">
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-ink-secondary/65" style={{ top: hour * HOUR_HEIGHT }}>
              {hour === 0 ? "" : new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}
            </div>
          ))}
        </div>
        {starts.map((start) => {
          const dayItems = items.filter((item) => startOfDay(item.at) === start);
          const now = new Date();
          const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;
          return (
            <div key={start} className="relative border-r border-hairline/40 last:border-r-0">
              {Array.from({ length: 24 }, (_, hour) => (
                <div key={hour} className="absolute inset-x-0 border-t border-hairline/25" style={{ top: hour * HOUR_HEIGHT }} />
              ))}
              {start === today && (
                <div className="absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop }}>
                  <span className="-ml-1 size-2 rounded-full bg-danger" />
                  <span className="h-px flex-1 bg-danger/80" />
                </div>
              )}
              {dayItems.map((item) => {
                const bot = bots.find((candidate) => candidate.id === (item.routine?.botId ?? item.run?.botId));
                return bot ? <RoutineCard key={item.id} item={item} bot={bot} compact={days === 7} onOpen={() => onOpen(item)} /> : null;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ACTIVE_RUN_STATUSES: RoutineRunStatus[] = ["queued", "running", "waiting"];

function runStatusLabel(status?: RoutineRunStatus) {
  if (!status) return "Scheduled";
  if (status === "waiting") return "Needs you";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function runStatusClasses(status?: RoutineRunStatus) {
  if (status === "running" || status === "verified" || status === "completed") return "border-success/20 bg-success/8 text-success";
  if (status === "waiting") return "border-warning/25 bg-warning/10 text-warning";
  if (status === "blocked" || status === "failed" || status === "missed") return "border-danger/25 bg-danger/10 text-danger";
  return "border-hairline/50 bg-raised/70 text-ink-secondary";
}

function agendaGroupLabel(at: number) {
  const day = startOfDay(at);
  const today = startOfDay(Date.now());
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return niceDate(at);
}

function AgendaRunRow({ item, bot, onOpen }: { item: CalendarItem; bot: Bot; onOpen: () => void }) {
  const status = item.run?.status;
  const title = item.routine?.name ?? item.run?.routineName ?? "Scheduled run";
  const runOn = item.routine?.runOn ?? item.run?.runOn;
  return (
    <button
      onClick={onOpen}
      className="grid w-full grid-cols-[58px_36px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-raised/75"
    >
      <div className="text-[12px] font-medium tabular-nums text-ink-secondary">{niceTime(item.at)}</div>
      <BotAvatar bot={bot} state={status ? statusState(status) : "idle"} size={36} animated={status === "running"} label={bot.name} />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-ink-secondary">
          <span className="truncate">{bot.name}</span>
          <span aria-hidden="true">·</span>
          {runOn === "cloud" ? <Cloud size={11} /> : <Laptop size={11} />}
          <span>{runOn === "cloud" ? "Cloud" : "This computer"}</span>
        </div>
      </div>
      <span className={cn("rounded-full border px-2 py-1 text-[10.5px] font-medium", runStatusClasses(status))}>{runStatusLabel(status)}</span>
    </button>
  );
}

function ScheduledRunsOverview({
  items,
  recentItems,
  routines,
  bots,
  onOpen,
  onEdit,
  onShowCalendar,
}: {
  items: CalendarItem[];
  recentItems: CalendarItem[];
  routines: Routine[];
  bots: Bot[];
  onOpen: (item: CalendarItem) => void;
  onEdit: (routine: Routine) => void;
  onShowCalendar: () => void;
}) {
  const now = Date.now();
  const upcoming = items.filter((item) => item.at >= now || (item.run && ACTIVE_RUN_STATUSES.includes(item.run.status))).slice(0, 16);
  const groups = new Map<string, CalendarItem[]>();
  for (const item of upcoming) {
    const label = agendaGroupLabel(item.at);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  const activeCount = recentItems.filter((item) => item.run && ACTIVE_RUN_STATUSES.includes(item.run.status)).length;
  const attentionCount = recentItems.filter((item) => item.run && ["waiting", "blocked", "failed", "missed"].includes(item.run.status)).length;
  const enabledRoutines = routines.filter((routine) => routine.enabled);
  const next = upcoming[0];

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 pb-8 pt-1">
      <div className="mx-auto grid max-w-[1180px] gap-4">
        <section className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-[18px] border border-hairline/45 bg-panel px-4 py-3.5">
            <div className="flex items-center gap-2 text-[11px] font-medium text-ink-secondary"><Clock3 size={13} />Next</div>
            <div className="mt-2 truncate text-[14px] font-semibold text-ink">{next ? next.routine?.name ?? next.run?.routineName ?? "Scheduled run" : "Nothing queued"}</div>
            <div className="mt-0.5 text-[11.5px] text-ink-secondary">{next ? `${agendaGroupLabel(next.at)} at ${niceTime(next.at)}` : "Your schedule is clear."}</div>
          </div>
          <div className="rounded-[18px] border border-hairline/45 bg-panel px-4 py-3.5">
            <div className="flex items-center gap-2 text-[11px] font-medium text-ink-secondary"><Play size={13} />Active now</div>
            <div className="mt-2 text-[22px] font-semibold leading-none tabular-nums text-ink">{activeCount}</div>
            <div className="mt-1.5 text-[11.5px] text-ink-secondary">{attentionCount > 0 ? `${attentionCount} need attention` : "Nothing needs you right now."}</div>
          </div>
          <div className="rounded-[18px] border border-hairline/45 bg-panel px-4 py-3.5">
            <div className="flex items-center gap-2 text-[11px] font-medium text-ink-secondary"><CalendarClock size={13} />Routines on</div>
            <div className="mt-2 text-[22px] font-semibold leading-none tabular-nums text-ink">{enabledRoutines.length}</div>
            <div className="mt-1.5 text-[11.5px] text-ink-secondary">Across {new Set(enabledRoutines.map((routine) => routine.botId)).size} agents</div>
          </div>
        </section>

        <div className="grid min-h-[420px] gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
          <section className="overflow-hidden rounded-[20px] border border-hairline/45 bg-panel">
            <div className="flex items-center justify-between border-b border-hairline/40 px-4 py-3.5">
              <div>
                <h2 className="text-[14px] font-semibold text-ink">Upcoming</h2>
                <p className="mt-0.5 text-[11px] text-ink-secondary">The next two weeks, in local time.</p>
              </div>
              <button onClick={onShowCalendar} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"><CalendarDays size={13} />Calendar</button>
            </div>
            {groups.size === 0 ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
                <CalendarClock size={27} className="text-ink-secondary/45" />
                <div className="mt-3 text-[13px] font-medium text-ink">No upcoming runs</div>
                <div className="mt-1 text-[11.5px] text-ink-secondary">Create a routine when you want an agent to work on a rhythm.</div>
              </div>
            ) : Array.from(groups.entries()).map(([label, groupItems]) => (
              <div key={label} className="border-b border-hairline/35 px-2 py-2 last:border-b-0">
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{label}</div>
                {groupItems.map((item) => {
                  const bot = bots.find((candidate) => candidate.id === (item.routine?.botId ?? item.run?.botId));
                  return bot ? <AgendaRunRow key={item.id} item={item} bot={bot} onOpen={() => onOpen(item)} /> : null;
                })}
              </div>
            ))}
          </section>

          <div className="grid content-start gap-4">
            <section className="overflow-hidden rounded-[20px] border border-hairline/45 bg-panel">
              <div className="flex items-center gap-2 border-b border-hairline/40 px-4 py-3.5"><LayoutList size={14} className="text-ink-secondary" /><h2 className="text-[13px] font-semibold text-ink">Routine library</h2></div>
              <div className="max-h-[250px] overflow-auto p-2">
                {routines.length === 0 ? <div className="px-3 py-6 text-center text-[11.5px] text-ink-secondary">No routines yet.</div> : routines.slice(0, 10).map((routine) => {
                  const bot = bots.find((candidate) => candidate.id === routine.botId);
                  return (
                    <button key={routine.id} onClick={() => onEdit(routine)} className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-raised/75">
                      {bot ? <BotAvatar bot={bot} state={routine.enabled ? "idle" : "sleeping"} size={30} animated={false} label={bot.name} /> : <div className="size-[30px] rounded-lg bg-raised" />}
                      <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-medium text-ink">{routine.name}</div><div className="truncate text-[10.5px] text-ink-secondary">{scheduleLabel(routine)}</div></div>
                      <span className={cn("size-1.5 rounded-full", routine.enabled ? "bg-success" : "bg-ink-secondary/35")} />
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="overflow-hidden rounded-[20px] border border-hairline/45 bg-panel">
              <div className="flex items-center gap-2 border-b border-hairline/40 px-4 py-3.5"><History size={14} className="text-ink-secondary" /><h2 className="text-[13px] font-semibold text-ink">Recent runs</h2></div>
              <div className="max-h-[235px] overflow-auto p-2">
                {recentItems.length === 0 ? <div className="px-3 py-6 text-center text-[11.5px] text-ink-secondary">Completed runs will appear here.</div> : recentItems.slice(0, 7).map((item) => (
                  <button key={item.id} onClick={() => onOpen(item)} className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-raised/75">
                    <span className={cn("size-2 rounded-full", item.run && ["completed", "verified"].includes(item.run.status) ? "bg-success" : item.run && ["blocked", "failed", "missed"].includes(item.run.status) ? "bg-danger" : "bg-ink-secondary/35")} />
                    <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-medium text-ink">{item.routine?.name ?? item.run?.routineName ?? "Run"}</div><div className="text-[10.5px] text-ink-secondary">{item.run ? runStatusLabel(item.run.status) : "Scheduled"} · {niceTime(item.at)}</div></div>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RoutineEditor({
  routine,
  bots,
  lockedBotId,
  defaultRunOn,
  onClose,
}: {
  routine?: Routine;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [botId, setBotId] = useState(lockedBotId ?? routine?.botId ?? bots[0]?.id ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(routine?.runOn ?? defaultRunOn ?? "maus");
  const [kind, setKind] = useState<"once" | "daily" | "interval">(routine?.schedule.type ?? "daily");
  const [at, setAt] = useState(
    toInputDateTime(routine?.schedule.type === "once" ? routine.schedule.at : nextHour()),
  );
  const [time, setTime] = useState(routine?.schedule.type === "daily" ? routine.schedule.time : "09:00");
  const [everyMinutes, setEveryMinutes] = useState(
    routine?.schedule.type === "interval" ? routine.schedule.everyMinutes : 5,
  );
  const [from, setFrom] = useState(routine?.schedule.type === "interval" ? routine.schedule.from : "08:00");
  const [to, setTo] = useState(routine?.schedule.type === "interval" ? routine.schedule.to : "19:55");
  const [weekdays, setWeekdays] = useState(
    routine && routine.schedule.type !== "once" ? routine.schedule.weekdays : [1, 2, 3, 4, 5],
  );
  const [durationMinutes, setDurationMinutes] = useState(routine?.durationMinutes ?? 30);
  const [maxRuns, setMaxRuns] = useState(routine?.budget?.maxScheduledRunsPerDay?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(routine?.budget?.maxTokensPerDay?.toString() ?? "");
  const [maxCost, setMaxCost] = useState(routine?.budget?.maxCostUsdPerDay?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cloudInstance = state.instances.find((instance) => instance.driverKind === "boxAgent");
  const cloudReady = Boolean(state.config?.box.configured && cloudInstance?.snapshot.state === "available");

  const save = async () => {
    const input: RoutineInput = {
      name,
      prompt,
      botId,
      runOn,
      enabled: routine ? undefined : true,
      durationMinutes,
      budget: {
        ...(maxRuns ? { maxScheduledRunsPerDay: Number(maxRuns) } : {}),
        ...(maxTokens ? { maxTokensPerDay: Number(maxTokens) } : {}),
        ...(maxCost ? { maxCostUsdPerDay: Number(maxCost) } : {}),
      },
      schedule:
        kind === "once"
          ? { type: "once", at: new Date(at).getTime() }
          : kind === "daily"
            ? { type: "daily", time, weekdays }
            : { type: "interval", everyMinutes, from, to, weekdays },
    };
    setSaving(true);
    setError("");
    try {
      const response = await api(routine ? `/api/routines/${routine.id}` : "/api/routines", {
        method: routine ? "PATCH" : "POST",
        body: JSON.stringify(input),
      });
      dispatch({ type: "routinePatched", routine: response.routine });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="max-h-[90vh] w-full max-w-[620px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-hairline/40 bg-panel/95 px-5 py-4 backdrop-blur">
          <div>
            <div className="text-[17px] font-semibold text-ink">{routine ? "Edit routine" : "New routine"}</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">Each run starts a fresh task for this agent. No cron syntax required.</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="space-y-5 p-5">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">Routine name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning research brief" className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" />
          </label>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-secondary">Daily safety budget <span className="font-normal">(optional)</span></div>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block"><span className="mb-1 block text-[11px] text-ink-secondary">Scheduled runs</span><input type="number" min="1" step="1" value={maxRuns} onChange={(event) => setMaxRuns(event.target.value)} placeholder="No limit" className="w-full rounded-xl border border-hairline/60 bg-inset px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70" /></label>
              <label className="block"><span className="mb-1 block text-[11px] text-ink-secondary">Tokens</span><input type="number" min="1" step="1000" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="No limit" className="w-full rounded-xl border border-hairline/60 bg-inset px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70" /></label>
              <label className="block"><span className="mb-1 block text-[11px] text-ink-secondary">Provider cost ($)</span><input type="number" min="0.01" step="0.01" value={maxCost} onChange={(event) => setMaxCost(event.target.value)} placeholder="No limit" className="w-full rounded-xl border border-hairline/60 bg-inset px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70" /></label>
            </div>
            <p className="mt-1.5 text-[11px] text-ink-secondary">Scheduled runs stop quietly at the first limit. Manual “Run now” remains available.</p>
          </div>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-secondary">Where does it run?</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRunOn("maus")}
                className={cn(
                  "rounded-xl border p-3 text-left transition",
                  runOn === "maus" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60",
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium text-ink"><Laptop size={15} />This computer</div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">Uses this agent's selected model, tools, and computer setting.</div>
              </button>
              <button
                type="button"
                disabled={!cloudReady && runOn !== "cloud"}
                onClick={() => setRunOn("cloud")}
                className={cn(
                  "rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45",
                  runOn === "cloud" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60",
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium text-ink"><Cloud size={15} />Cloud VM</div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">Runs the agent and its tools inside its Box virtual machine.</div>
              </button>
            </div>
            {runOn === "cloud" && (
              <div className={cn("mt-2 rounded-lg px-3 py-2 text-[11.5px] leading-relaxed", cloudReady ? "bg-accent/10 text-ink-secondary" : "border border-warning/25 bg-warning/10 text-warning")}>
                {cloudReady
                  ? "The VM wakes automatically for each run. Keep Agent Centipede running so its scheduler can launch the job."
                  : "Cloud VM needs a working Box API key in App Settings before this routine can run."}
              </div>
            )}
          </div>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-secondary">Who does it?</div>
            <div className={cn("grid gap-2", lockedBotId ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-3")}>
              {bots.map((bot) => (
                <button key={bot.id} type="button" disabled={Boolean(lockedBotId)} onClick={() => setBotId(bot.id)} className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left", botId === bot.id ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}>
                  <BotAvatar bot={bot} state={botId === bot.id ? "happy" : "idle"} size={38} animated={false} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{bot.name}</span>
                  {lockedBotId && <span className="text-[11px] text-ink-secondary">Assigned from Computer</span>}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">What should this agent do?</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="Check the latest project activity, summarize what changed, and call out anything that needs my attention…" className="w-full resize-y rounded-xl border border-hairline/60 bg-inset px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" />
          </label>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-secondary">When?</div>
            <div className="mb-3 inline-flex rounded-xl bg-inset p-1">
              {(["once", "daily", "interval"] as const).map((value) => (
                <button key={value} onClick={() => setKind(value)} className={cn("rounded-lg px-4 py-1.5 text-[13px] capitalize", kind === value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}>{value === "daily" ? "Daily" : value === "interval" ? "Interval" : "Once"}</button>
              ))}
            </div>
            {kind === "once" ? (
              <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} className="block rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70 [color-scheme:dark]" />
            ) : (
              <div className="space-y-3">
                {kind === "daily" ? (
                  <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70 [color-scheme:dark]" />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-ink-secondary">Every</span>
                      <select value={everyMinutes} onChange={(event) => setEveryMinutes(Number(event.target.value))} className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70">
                        {[1, 5, 10, 15, 30, 60, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} {minutes === 1 ? "minute" : "minutes"}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-ink-secondary">From</span>
                      <input type="time" value={from} onChange={(event) => setFrom(event.target.value)} className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70 [color-scheme:dark]" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-ink-secondary">To</span>
                      <input type="time" value={to} onChange={(event) => setTo(event.target.value)} className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70 [color-scheme:dark]" />
                    </label>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((label, day) => (
                    <button key={label} type="button" onClick={() => setWeekdays((current) => current.includes(day) ? (current.length === 1 ? current : current.filter((value) => value !== day)) : [...current, day].sort())} className={cn("size-10 rounded-xl border text-[11px] font-medium", weekdays.includes(day) ? "border-accent bg-accent text-white" : "border-hairline/50 bg-inset text-ink-secondary hover:text-ink")}>{label.slice(0, 2)}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">Calendar block</span>
            <select value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} className="rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70">
              {[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`}</option>)}
            </select>
          </label>
          {error && <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger"><CircleAlert size={16} className="mt-0.5 shrink-0" />{error}</div>}
        </div>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-hairline/40 bg-panel/95 px-5 py-4 backdrop-blur">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim() || !prompt.trim() || !botId} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">
            {saving && <Loader2 size={14} className="animate-spin" />}{routine ? "Save changes" : "Create routine"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoutineDetails({ item, bot, onClose, onEdit }: { item: CalendarItem; bot: Bot; onClose: () => void; onEdit: (routine: Routine) => void }) {
  const { dispatch } = useStore();
  const routine = item.routine;
  const run = item.run;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const title = routine?.name ?? run?.routineName ?? "Routine";
  const webhookParts = run?.triggerSource === "webhook" ? webhookPromptParts(run.prompt) : null;
  const visibleInstructions = webhookParts?.instructions ?? routine?.prompt ?? run?.prompt;

  const invoke = async (path: string, method = "POST", body?: unknown) => {
    setWorking(true);
    setError("");
    try {
      const response = await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.routine) dispatch({ type: "routinePatched", routine: response.routine });
      if (response.run) dispatch({ type: "routineRunPatched", run: response.run });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="relative overflow-hidden border-b border-hairline/40 px-5 py-5" style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${MAUS_COLORS[bot.color]} 28%, #111), #111)` }}>
          <button onClick={onClose} className="absolute right-3 top-3 rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"><X size={18} /></button>
          <div className="flex items-center gap-4 pr-10">
            <BotAvatar bot={bot} state={run ? statusState(run.status) : "idle"} size={72} animated={run?.status === "running" || run?.status === "waiting"} label={bot.name} />
            <div className="min-w-0">
              <div className="truncate text-[20px] font-semibold text-white">{title}</div>
              <div className="mt-1 flex items-center gap-2 text-[13px] text-white/65"><span>{bot.name}</span><span>·</span><span>{niceDate(item.at)}, {niceTime(item.at)}</span></div>
              <div className={cn("mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1 text-[11px] font-medium capitalize", run ? statusTone(run.status) : "text-white/70")}>
                {run?.status === "running" && <Loader2 size={11} className="animate-spin" />}
                {(run?.status === "completed" || run?.status === "verified") && <CheckCircle2 size={11} />}
                {run ? run.status.replace("waiting", "needs you") : "scheduled"}
              </div>
            </div>
          </div>
        </div>
        <div className="max-h-[55vh] space-y-4 overflow-y-auto p-5">
          {routine && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Schedule</div><div className="mt-1 text-[13px] text-ink">{scheduleLabel(routine)}</div></div>
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Runs on</div><div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink">{routine.runOn === "cloud" ? <Cloud size={13} /> : <Laptop size={13} />}{routine.runOn === "cloud" ? "Cloud VM" : "This computer"}</div></div>
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Duration</div><div className="mt-1 text-[13px] text-ink">{routine.durationMinutes} minutes</div></div>
            </div>
          )}
          {run?.triggerSource === "webhook" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Triggered by</div><div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink"><Webhook size={13} />Webhook</div></div>
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Runs on</div><div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink">{run.runOn === "cloud" ? <Cloud size={13} /> : <Laptop size={13} />}{run.runOn === "cloud" ? "Cloud VM" : "This computer"}</div></div>
              {run.deliveryId && <div className="col-span-2 rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Delivery ID</div><div className="mt-1 truncate font-mono text-[11.5px] text-ink">{run.deliveryId}</div></div>}
            </div>
          )}
          {visibleInstructions && <div><div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Instructions</div><div className="whitespace-pre-wrap rounded-xl border border-hairline/40 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink">{visibleInstructions}</div></div>}
          {webhookParts?.eventData && <div><div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Webhook event data</div><pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-accent/15 bg-accent/5 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-ink-secondary">{webhookParts.eventData}</pre></div>}
          {run?.output && <div><div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Last output</div><div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl border border-success/20 bg-success/5 px-3.5 py-3 text-[13px] leading-relaxed text-ink">{run.output}</div></div>}
          {run?.evidence?.length ? <div><div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Verification evidence</div><div className="space-y-2 rounded-xl border border-success/20 bg-success/5 px-3.5 py-3">{run.evidence.map((item) => <div key={item.id} className="text-[12px] leading-relaxed text-ink"><span className="font-medium capitalize">{item.kind}:</span> {item.summary}{item.reference ? <div className="truncate font-mono text-[10.5px] text-ink-secondary">{item.reference}</div> : null}</div>)}</div></div> : null}
          {run?.error && <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[13px] text-danger"><CircleAlert size={16} className="mt-0.5 shrink-0" /><span>{run.error}</span></div>}
          {error && <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[13px] text-danger"><CircleAlert size={16} className="mt-0.5 shrink-0" /><span>{error}</span></div>}
          {run?.status === "waiting" && <div className="rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[13px] text-warning">This run needs your answer. Open its task to continue.</div>}
          {run?.status === "blocked" && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[13px] text-danger">This run stopped at a recoverable blocker. Retry only with a materially different strategy.</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline/40 px-5 py-4">
          {routine && <button disabled={working} onClick={() => void invoke(`/api/routines/${routine.id}/run`)} className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Play size={14} />Run now</button>}
          {run?.threadId && <button onClick={() => { dispatch({ type: "select", id: bot.id }); dispatch({ type: "switchTask", botId: bot.id, threadId: run.threadId! }); onClose(); }} className="flex items-center gap-2 rounded-xl bg-raised px-3.5 py-2 text-[13px] text-ink hover:bg-raised-hover"><ExternalLink size={14} />Open task</button>}
          {run && ["queued", "running", "waiting"].includes(run.status) && <button disabled={working} onClick={() => void invoke(`/api/routine-runs/${run.id}/cancel`)} className="flex items-center gap-2 rounded-xl bg-raised px-3.5 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"><X size={14} />Cancel run</button>}
          {run && ["blocked", "failed"].includes(run.status) && (run.retryCount ?? 0) < (run.maxChangedStrategyRetries ?? 0) && <button disabled={working} onClick={() => { const strategy = window.prompt("What materially different strategy should the retry use?"); if (strategy) void invoke(`/api/routine-runs/${run.id}/retry`, "POST", { strategy }); }} className="flex items-center gap-2 rounded-xl bg-warning/15 px-3.5 py-2 text-[13px] text-warning hover:bg-warning/25 disabled:opacity-40"><Play size={14} />Retry differently</button>}
          <div className="flex-1" />
          {routine && canToggleRoutine(routine) && <button disabled={working} onClick={async () => { setWorking(true); setError(""); try { const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !routine.enabled }) }); dispatch({ type: "routinePatched", routine: response.routine }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setWorking(false); } }} className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">{routine.enabled ? <Pause size={14} /> : <Play size={14} />}{routine.enabled ? "Pause" : "Resume"}</button>}
          {routine && <button onClick={() => onEdit(routine)} className="rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Edit</button>}
          {routine && <button onClick={() => { if (!window.confirm(`Delete “${routine.name}”? Its past run receipts will stay in the calendar.`)) return; dispatch({ type: "deleteRoutine", routineId: routine.id }); onClose(); }} className="rounded-xl p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger" title="Delete routine"><Trash2 size={16} /></button>}
        </div>
      </div>
    </div>
  );
}

function PausedRoutines({ routines, bots, onClose, onEdit }: { routines: Routine[]; bots: Bot[]; onClose: () => void; onEdit: (routine: Routine) => void }) {
  const { dispatch } = useStore();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4">
          <div><div className="text-[17px] font-semibold text-ink">Paused routines</div><div className="mt-0.5 text-[12px] text-ink-secondary">They keep their history and will not create new runs.</div></div>
          <button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto p-4">
          {routines.map((routine) => {
            const bot = bots.find((candidate) => candidate.id === routine.botId);
            return (
              <div key={routine.id} className="flex items-center gap-3 rounded-xl border border-hairline/40 bg-inset p-3">
                {bot ? <BotAvatar bot={bot} state="sleeping" size={44} animated={false} label={bot.name} /> : <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-ink-secondary"><CalendarClock size={20} /></div>}
                <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-semibold text-ink">{routine.name}</div><div className="mt-0.5 truncate text-[11.5px] text-ink-secondary">{bot?.name ?? "Deleted agent"} · {scheduleLabel(routine)}</div></div>
                {bot && <button onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: true } })} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"><Play size={12} />Resume</button>}
                <button onClick={() => onEdit(routine)} className="rounded-lg px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">Edit</button>
                <button onClick={() => { if (!window.confirm(`Delete “${routine.name}”?`)) return; dispatch({ type: "deleteRoutine", routineId: routine.id }); }} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger" title="Delete routine"><Trash2 size={15} /></button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReliabilityPanel() {
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const result: unknown = await api("/api/operations");
        if (!isOperationsSnapshot(result)) throw new Error("Agent Centipede returned an invalid reliability snapshot");
        if (mounted) { setSnapshot(result); setError(""); }
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  if (!snapshot) return <div className="flex flex-1 items-center justify-center text-sm text-ink-secondary">{error || "Loading reliability…"}</div>;
  const unhealthy = snapshot.capture.sourceHealth.filter((source) => ["failed", "needs-auth"].includes(source.status) || source.freshness === "stale");
  const tokenCoverage = snapshot.routines.usageToday;
  const tokenValue = tokenUsageLabel({
    input: tokenCoverage.inputTokens,
    output: tokenCoverage.outputTokens,
    costUsd: tokenCoverage.costUsd,
    turns: tokenCoverage.reportedRuns + tokenCoverage.unreportedRuns,
    tokenTurns: tokenCoverage.reportedRuns,
  });
  const tokenDetail = tokenCoverage.unreportedRuns > 0
    ? `${tokenCoverage.reportedRuns} measured · ${tokenCoverage.unreportedRuns} estimated`
    : `$${tokenCoverage.costUsd.toFixed(2)} provider cost recorded`;
  const latency = snapshot.performance.summary;
  const telemetryDetail = `${latency.tokenTurnsProvider} provider counts · ${latency.tokenTurnsEstimated} estimated · ${latency.tokenTurnsUnavailable} unavailable`;
  const latencyValue = latency.medianFirstVisibleMs === null ? "No data" : `${(latency.medianFirstVisibleMs / 1000).toFixed(1)}s`;
  const latencyDetail = latency.p95FirstVisibleMs === null
    ? "Waiting for a measured provider turn"
    : `p95 ${(latency.p95FirstVisibleMs / 1000).toFixed(1)}s · startup ${latency.medianProviderStartupMs === null ? "n/a" : `${(latency.medianProviderStartupMs / 1000).toFixed(1)}s`}`;
  const reuseValue = latency.reuseRate == null ? "No data" : `${Math.round(latency.reuseRate * 100)}%`;
  const reuseDetail = `${latency.warmTurns ?? 0} warm · ${latency.coldTurns ?? 0} cold${latency.unknownTurns ? ` · ${latency.unknownTurns} older` : ""}`;
  const cards = [
    ["Source issues", unhealthy.length.toLocaleString(), unhealthy.length ? "Needs attention" : "All observed sources healthy"],
    ["Active queue", snapshot.routines.active.length.toLocaleString(), snapshot.routines.overlong.length ? `${snapshot.routines.overlong.length} overlong` : "No overlong work"],
    ["Memory records", snapshot.capture.memory.activeItems.toLocaleString(), `${snapshot.capture.memory.sensitiveItems} sensitive/restricted`],
    ["Tokens today", tokenValue, tokenDetail],
    ["Median first reply", latencyValue, latencyDetail],
    ["Warm session reuse", reuseValue, reuseDetail],
  ];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {cards.map(([label, value, detail]) => <div key={label} className="rounded-2xl border border-hairline/50 bg-panel p-4"><div className="text-[11px] uppercase tracking-wider text-ink-secondary">{label}</div><div className="mt-1 text-2xl font-semibold text-ink">{value}</div><div className="mt-1 text-[12px] text-ink-secondary">{detail}</div></div>)}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-hairline/50 bg-panel p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink"><Activity size={15} className="text-accent" />Source freshness</div>
          <div className="mt-3 space-y-2">
            {snapshot.capture.sourceHealth.map((source) => <div key={`${source.botId}:${source.sourceId}`} className="flex items-start justify-between gap-3 rounded-xl bg-inset px-3 py-2"><div className="min-w-0"><div className="truncate text-[13px] text-ink">{source.sourceId}</div><div className="truncate text-[11px] text-ink-secondary">{source.lastError ?? (source.lastSuccessAt ? `Last success ${new Date(source.lastSuccessAt).toLocaleString()}` : "No successful receipt")}</div></div><div className="flex shrink-0 items-center gap-1.5"><span className={cn("rounded-full px-2 py-0.5 text-[10px]", source.freshness === "fresh" ? "bg-success/10 text-success" : source.freshness === "stale" ? "bg-warning/10 text-warning" : "bg-raised text-ink-secondary")}>{source.freshness ?? "unknown"}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px]", ["ok", "empty"].includes(source.status) ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{source.status}</span></div></div>)}
            {snapshot.capture.sourceHealth.length === 0 && <p className="text-[12px] text-ink-secondary">No source receipts have been recorded yet.</p>}
          </div>
        </section>
        <section className="rounded-2xl border border-hairline/50 bg-panel p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink"><ShieldCheck size={15} className="text-accent" />Safeguards</div>
          <div className="mt-3 space-y-2 text-[12px]">
            <div className="rounded-xl bg-inset px-3 py-2 text-ink-secondary"><strong className="text-ink">Runtime limits:</strong> {snapshot.routines.overlong.length === 0 ? "enforced; no task is overlong" : `${snapshot.routines.overlong.length} task(s) need recovery`}</div>
            <div className="rounded-xl bg-inset px-3 py-2 text-ink-secondary"><strong className="text-ink">Daily budgets:</strong> {snapshot.routines.budgets.length ? `${snapshot.routines.budgets.length} routine(s) protected` : "not configured yet"}</div>
            <div className="rounded-xl bg-inset px-3 py-2 text-ink-secondary"><strong className="text-ink">Quiet skips:</strong> {snapshot.routines.skippedToday.length} deterministic skip(s) today</div>
            <div className="rounded-xl bg-inset px-3 py-2 text-ink-secondary"><strong className="text-ink">Token telemetry:</strong> {telemetryDetail}</div>
            <div className="rounded-xl bg-inset px-3 py-2 text-ink-secondary"><strong className="text-ink">Webhook ingress:</strong> {snapshot.webhooks.available ? "available" : snapshot.webhooks.error ?? "unavailable"}</div>
            <div className="rounded-xl bg-inset px-3 py-2 text-ink-secondary"><strong className="text-ink">Failures today:</strong> {snapshot.routines.failuresToday.length}</div>
          </div>
        </section>
      </div>
      <div className="mt-3 text-right text-[10px] text-ink-secondary">Updated {new Date(snapshot.generatedAt).toLocaleTimeString()}</div>
    </div>
  );
}

export function RoutinesPage() {
  const { state, dispatch } = useStore();
  const [section, setSection] = useState<"calendar" | "webhooks" | "reliability">("calendar");
  const [scheduleView, setScheduleView] = useState<"agenda" | "calendar">("agenda");
  const [viewDays, setViewDays] = useState<1 | 3 | 7>(7);
  const [anchor, setAnchor] = useState(() => startOfWeek(Date.now()));
  const [botFilter, setBotFilter] = useState("all");
  const [editor, setEditor] = useState<Routine | "new" | null>(null);
  const [selected, setSelected] = useState<CalendarItem | null>(null);
  const [pausedOpen, setPausedOpen] = useState(false);
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const rangeStart = viewDays === 7 ? startOfWeek(anchor) : startOfDay(anchor);
  const rangeEnd = addDays(rangeStart, viewDays);
  const items = useMemo(
    () => projectedItems(state.routines, state.routineRuns, rangeStart, rangeEnd).filter((item) => botFilter === "all" || (item.routine?.botId ?? item.run?.botId) === botFilter),
    [state.routines, state.routineRuns, rangeStart, rangeEnd, botFilter],
  );
  const agendaItems = useMemo(
    () => projectedItems(state.routines, state.routineRuns, startOfDay(Date.now()), addDays(startOfDay(Date.now()), 14))
      .filter((item) => botFilter === "all" || (item.routine?.botId ?? item.run?.botId) === botFilter),
    [state.routines, state.routineRuns, botFilter],
  );
  const recentItems = useMemo(
    () => [...state.routineRuns]
      .filter((run) => botFilter === "all" || run.botId === botFilter)
      .sort((left, right) => right.scheduledFor - left.scheduledFor)
      .map((run) => ({
        id: `recent-${run.id}`,
        at: run.scheduledFor,
        routine: state.routines.find((routine) => routine.id === run.routineId) ?? null,
        run,
      })),
    [state.routineRuns, state.routines, botFilter],
  );
  const liveSelected = selected
    ? {
        ...selected,
        routine: selected.routine ? state.routines.find((routine) => routine.id === selected.routine?.id) ?? null : null,
        run: selected.run ? state.routineRuns.find((run) => run.id === selected.run?.id) ?? selected.run : null,
      }
    : null;
  const selectedBot = liveSelected
    ? state.bots.find((bot) => bot.id === (liveSelected.routine?.botId ?? liveSelected.run?.botId))
    : undefined;
  const unseenFailures = state.routineRuns.filter((run) => ["blocked", "failed", "missed"].includes(run.status) && !run.seenAt).length;
  const running = state.routineRuns.filter((run) => ["queued", "running", "waiting"].includes(run.status)).length;
  const paused = state.routines.filter((routine) => !routine.enabled && canToggleRoutine(routine));
  useEffect(() => {
    if (pausedOpen && paused.length === 0) setPausedOpen(false);
  }, [pausedOpen, paused.length]);

  const move = (direction: number) => setAnchor((current) => addDays(current, direction * viewDays));
  const goToday = () => setAnchor(viewDays === 7 ? startOfWeek(Date.now()) : startOfDay(Date.now()));
  const openItem = (item: CalendarItem) => {
    setSelected(item);
    if (item.run && ["blocked", "failed", "missed"].includes(item.run.status) && !item.run.seenAt) {
      dispatch({ type: "markRoutineRunSeen", runId: item.run.id });
    }
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header
        className={cn(
          "shrink-0 px-5 pb-4 pt-4",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">{section === "calendar" ? <CalendarDays size={20} className="text-accent" /> : section === "webhooks" ? <Webhook size={20} className="text-accent" /> : <ShieldCheck size={20} className="text-accent" />}<h1 className="text-[19px] font-semibold tracking-tight text-ink">Scheduled runs</h1></div>
            <p className="mt-1 text-[12px] text-ink-secondary">{section === "calendar" ? "Give any agent a rhythm. Every run gets a fresh task." : section === "webhooks" ? "Start agent work when an outside event arrives." : "Freshness, failures, speed, usage, and recovery."}</p>
          </div>
          <div className="flex items-center gap-2">
            {running > 0 && <span className="flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1.5 text-[11px] text-accent"><Loader2 size={12} className="animate-spin" />{running} active</span>}
            {unseenFailures > 0 && <span className="flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger"><CircleAlert size={12} />{unseenFailures} need attention</span>}
            {paused.length > 0 && <button onClick={() => setPausedOpen(true)} className="flex items-center gap-1.5 rounded-full border border-hairline/50 bg-panel px-2.5 py-1.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"><Pause size={12} />{paused.length} paused</button>}
            {section === "calendar" && <button onClick={() => setEditor("new")} disabled={visibleBots.length === 0} className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white shadow-lg shadow-accent/10 hover:brightness-110 disabled:opacity-40"><Plus size={15} />New routine</button>}
          </div>
        </div>
        <div className="mt-4 flex items-center gap-1 rounded-xl bg-panel p-1 sm:w-fit">
          <button onClick={() => setSection("calendar")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium", section === "calendar" ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}><CalendarDays size={13} />Schedule</button>
          <button onClick={() => setSection("webhooks")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium", section === "webhooks" ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}><Webhook size={13} />Triggers{state.webhooks.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[10px] text-accent">{state.webhooks.length}</span>}</button>
          <button onClick={() => setSection("reliability")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium", section === "reliability" ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}><ShieldCheck size={13} />Health</button>
        </div>
        {section === "calendar" && <div className="mt-3 flex flex-wrap items-center gap-2">
          {scheduleView === "calendar" && <div className="flex items-center rounded-xl border border-hairline/50 bg-panel p-0.5">
            <button onClick={() => move(-1)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Previous dates"><ChevronLeft size={16} /></button>
            <button onClick={goToday} className="px-2.5 py-1.5 text-[12px] font-medium text-ink hover:text-accent">Today</button>
            <button onClick={() => move(1)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Next dates"><ChevronRight size={16} /></button>
          </div>}
          {scheduleView === "calendar" && <div className="min-w-[190px] px-2 text-[14px] font-semibold text-ink">
            {new Date(rangeStart).toLocaleDateString([], { month: "long", year: "numeric" })}
          </div>}
          <select value={botFilter} onChange={(event) => setBotFilter(event.target.value)} className="rounded-xl border border-hairline/50 bg-panel px-3 py-2 text-[12px] text-ink outline-none focus:border-accent/60">
            <option value="all">All agents</option>
            {visibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
          <div className="ml-auto flex rounded-xl bg-panel p-1">
            <button onClick={() => setScheduleView("agenda")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium", scheduleView === "agenda" ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}><LayoutList size={13} />Agenda</button>
            <button onClick={() => setScheduleView("calendar")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium", scheduleView === "calendar" ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}><CalendarDays size={13} />Calendar</button>
          </div>
          {scheduleView === "calendar" && <div className="flex rounded-xl bg-panel p-1">
            {([1, 3, 7] as const).map((days) => <button key={days} onClick={() => { setViewDays(days); setAnchor(days === 7 ? startOfWeek(anchor) : startOfDay(anchor)); }} className={cn("rounded-lg px-3 py-1.5 text-[11px] font-medium", viewDays === days ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}>{days === 1 ? "Day" : days === 3 ? "3 days" : "Week"}</button>)}
          </div>}
        </div>}
      </header>

      {section === "reliability" ? (
        <ReliabilityPanel />
      ) : section === "webhooks" ? (
        <WebhooksPanel bots={visibleBots} />
      ) : state.routines.length === 0 && state.routineRuns.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="max-w-[430px] text-center">
            <div className="relative mx-auto mb-5 flex h-28 w-44 items-end justify-center">
              {visibleBots.slice(0, 3).map((bot, index) => <div key={bot.id} className="-ml-3 first:ml-0" style={{ transform: `translateY(${Math.abs(index - 1) * 9}px) rotate(${(index - 1) * 5}deg)` }}><BotAvatar bot={bot} state={index === 1 ? "excited" : "idle"} size={84} /></div>)}
              {visibleBots.length === 0 && <CalendarClock size={58} className="text-ink-secondary/40" />}
            </div>
            <h2 className="text-[18px] font-semibold text-ink">Put your agents on a rhythm</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">Plan research briefs, daily check-ins, recurring reviews, or one-time work. Every run becomes a separate task with its own result.</p>
            <button onClick={() => setEditor("new")} disabled={visibleBots.length === 0} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Plus size={15} />Create your first routine</button>
            {visibleBots.length === 0 && <p className="mt-3 text-[12px] text-warning">Create an agent first, then come back to schedule it.</p>}
          </div>
        </div>
      ) : scheduleView === "calendar" ? (
        <CalendarGrid anchor={rangeStart} days={viewDays} items={items} bots={state.bots} onOpen={openItem} />
      ) : (
        <ScheduledRunsOverview
          items={agendaItems}
          recentItems={recentItems}
          routines={state.routines.filter((routine) => botFilter === "all" || routine.botId === botFilter)}
          bots={state.bots}
          onOpen={openItem}
          onEdit={setEditor}
          onShowCalendar={() => setScheduleView("calendar")}
        />
      )}

      {editor && <RoutineEditor routine={editor === "new" ? undefined : editor} bots={visibleBots} onClose={() => setEditor(null)} />}
      {liveSelected && selectedBot && <RoutineDetails item={liveSelected} bot={selectedBot} onClose={() => setSelected(null)} onEdit={(routine) => { setSelected(null); setEditor(routine); }} />}
      {pausedOpen && <PausedRoutines routines={paused} bots={state.bots} onClose={() => setPausedOpen(false)} onEdit={(routine) => { setPausedOpen(false); setEditor(routine); }} />}
    </main>
  );
}
