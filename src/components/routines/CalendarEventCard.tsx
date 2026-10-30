import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Video } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MAUS_COLORS, type MausState } from "@/lib/mascot";
import { CALENDAR_SLOT_MINUTES } from "@/lib/routine-calendar";
import { routineRunLabel } from "@/lib/routine-display";
import type { RoutineRunStatus } from "@/lib/routines";
import { intervalLabel, niceTime } from "@/lib/schedule-label";
import type { Bot, Group } from "@/state/store";
import type { CalendarEventItem } from "../RoutineCalendarPage";
import { EVENT_DRAG_TYPE } from "./LimitResetMarkers";

export const HOUR_HEIGHT = 64;

export function statusState(status: RoutineRunStatus): MausState {
  if (status === "running") return "working";
  if (status === "waiting") return "curious";
  if (status === "completed") return "proud";
  if (status === "failed" || status === "missed") return "sad";
  if (status === "cancelled") return "sleeping";
  return "drowsy";
}

/** What a card has room for, from its drawn height: two lines need about 40px, so a 30-minute automation (32px) gets one
 * line of title, status and time, its bot shown by the card's colour, and the rest moves to the hover. */
export function cardLayout(height: number): "roomy" | "compact" | "tiny" {
  if (height >= 44) return "roomy";
  return height >= 22 ? "compact" : "tiny";
}

export function CalendarEventCard({
  item,
  bots,
  groups,
  compact,
  layout,
  selected = false,
  onOpen,
  onResize,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  groups: Group[];
  compact: boolean;
  layout: { column: number; columns: number };
  selected?: boolean;
  onOpen: () => void;
  onResize: (minutes: number) => void;
}) {
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = item.kind === "routine" ? item.run : null;
  const isRoomGoal = !isCall && (run?.target ?? routine?.target) === "room-goal";
  const roomId = isRoomGoal ? run?.groupId ?? routine?.groupId : undefined;
  const room = roomId ? groups.find((candidate) => candidate.id === roomId) ?? { name: t("routines.group") } : undefined;
  const ownerIds = isCall ? item.call.botIds : [run?.botId ?? routine?.botId ?? ""];
  const ownerBots = ownerIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = ownerBots[0];
  const name = isCall ? item.call.name : run?.routineName ?? routine?.name ?? "Automation";
  const color = isCall ? "var(--color-accent)" : primary ? MAUS_COLORS[primary.color] : "var(--color-ink-tertiary)";
  const paused = Boolean(routine && !run && !routine.enabled);
  const [previewDuration, setPreviewDuration] = useState(item.durationMinutes);
  useEffect(() => setPreviewDuration(item.durationMinutes), [item.durationMinutes]);
  const status = run?.status, attention = status === "failed" || status === "missed" || status === "waiting" || (item.kind === "routine" && !run && item.needsYou === true);
  const statusLabel = run ? routineRunLabel(run) : undefined;
  const canMove = isCall || Boolean(routine && !run && !paused && routine.schedule.type !== "cron");
  const schedule = isCall ? item.call.schedule : routine?.schedule;
  const recurring = Boolean(schedule && schedule.type !== "once");
  const intervalCadence = schedule?.type === "interval" ? intervalLabel(schedule.everyMinutes) : null;
  const height = Math.max(16, (previewDuration / 60) * HOUR_HEIGHT);
  const fit = cardLayout(height);
  const who = isCall ? t(ownerBots.length === 1 ? "routines.botCountOne" : "routines.botCountMany", { count: ownerBots.length }) : room ? room.name : primary?.name;
  const details = [name, niceTime(item.at), who, intervalCadence, paused ? t("routines.pausedSchedule") : statusLabel].filter(Boolean).join(" · ");
  const cronHint = routine?.schedule.type === "cron" ? "Open this automation to change its repeating schedule and time zone." : "";

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startDuration = previewDuration;
    let next = startDuration;
    const move = (pointer: PointerEvent) => {
      next = Math.max(CALENDAR_SLOT_MINUTES, Math.min(240, Math.round((startDuration + ((pointer.clientY - startY) / HOUR_HEIGHT) * 60) / CALENDAR_SLOT_MINUTES) * CALENDAR_SLOT_MINUTES));
      setPreviewDuration(next);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (next === item.durationMinutes) return;
      if (recurring && !window.confirm("Resize this entire recurring series?")) {
        setPreviewDuration(item.durationMinutes);
        return;
      }
      onResize(next);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  const dot = !isCall && <span data-event-status={paused ? "paused" : attention ? "needs-you" : "working"} className={cn("size-1.5 shrink-0 rounded-full", paused ? "bg-ink-tertiary" : attention ? "bg-warning" : "bg-success")} />;
  const avatar = (size: number) => isCall
    ? <Video size={13} className="mt-0.5 shrink-0" />
    : primary ? <BotAvatar bot={primary} state={status ? statusState(status) : paused ? "sleeping" : "idle"} size={size} animated={status === "running" || status === "waiting"} /> : null;

  return (
    <button
      data-event-card
      data-event-fit={fit}
      type="button"
      draggable={canMove}
      title={cronHint ? `${details}\n${cronHint}` : details}
      onDragStart={(event) => {
        if (!canMove) return event.preventDefault();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(EVENT_DRAG_TYPE, JSON.stringify({ kind: item.kind, id: isCall ? item.call.id : routine!.id, at: item.at }));
      }}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
      aria-pressed={selected}
      aria-label={`${name}, ${niceTime(item.at)}${paused ? `, ${t("routines.pausedSchedule")}` : statusLabel ? `, ${statusLabel}` : ""}`}
      className={cn(
        "group absolute z-10 overflow-hidden rounded-md border border-l-[3px] text-left transition hover:z-20 focus:z-20 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        fit === "roomy" ? "px-1.5 py-1" : "px-1.5 py-0",
        paused && "border-dashed opacity-70",
        status === "cancelled" && "opacity-55",
        (status === "failed" || status === "missed") && "border-danger/60",
        selected && "z-20 ring-2 ring-accent ring-offset-1 ring-offset-app",
      )}
      style={{
        left: `calc(${(layout.column / layout.columns) * 100}% + 2px)`,
        width: `calc(${100 / layout.columns}% - 4px)`,
        top: `${((new Date(item.at).getHours() * 60 + new Date(item.at).getMinutes()) / 60) * HOUR_HEIGHT}px`,
        height: `${height}px`,
        background: `color-mix(in srgb, ${color} ${paused ? 6 : 16}%, var(--color-card))`,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        borderLeftColor: color,
        color: `color-mix(in srgb, ${color} 55%, var(--color-ink))`,
      }}
    >
      {fit === "roomy" ? (
        <div className="flex min-w-0 items-start gap-1.5">
          {avatar(compact ? 18 : 22)}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-semibold leading-tight">{name}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] opacity-80">{dot}<span className="truncate">{niceTime(item.at)} · {intervalCadence && !room && !isCall ? `${who ?? ""} · ${intervalCadence}` : who}</span></div>
          </div>
          {ownerBots.length > 1 && <span className="rounded bg-inset/60 px-1 py-0.5 text-[8px]">+{ownerBots.length - 1}</span>}
        </div>
      ) : fit === "compact" ? (
        <div className="flex h-full min-w-0 items-center gap-1">
          {isCall && <Video size={11} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold leading-none">{name}</span>
          {dot}
          <span className="shrink-0 text-[10px] leading-none tabular-nums opacity-80">{niceTime(item.at)}</span>
        </div>
      ) : (
        <div className="flex h-full min-w-0 items-center truncate text-[10px] font-semibold leading-none">{name}</div>
      )}
      {isCall && <div onPointerDown={beginResize} className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize rounded-full opacity-0 transition group-hover:opacity-100" aria-label="Resize event"><div className="mx-auto mt-0.5 h-0.5 w-5 rounded-full bg-current opacity-50" /></div>}
    </button>
  );
}
