import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { CalendarSidebar } from "@/components/routines/CalendarSidebar";
import type { CalendarCall } from "@/lib/calendar-calls";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { addDays, calendarRangeLabel, projectCalls, projectedRoutineItems, scheduleAt, startOfDay, startOfWeek } from "@/lib/routine-calendar";
import { resetMarkers, useEngineLimits, type ResetMarker } from "@/lib/limit-resets";
import { automationsFrom, automationStatus } from "@/lib/automations";
import type { RoutineRun } from "@/lib/routines";
import { api, useStore } from "@/state/store";
import { CalendarGrid, EventDetails, EventEditor, QuickComposer, type CalendarEventItem, type EventKind, type EventSeed } from "../RoutineCalendarPage";
import type { ResetDrop } from "../routines/LimitResetMarkers";

/** The schedules (and scheduled calls) on a week or day grid. An automation opens the same panel as the list; a call
 * keeps its own details. */
export function AutomationsCalendar({ botFilter, selectedAutomationId, onOpenAutomation, onOpenRoom }: {
  botFilter: string;
  selectedAutomationId?: string | null;
  onOpenAutomation: (id: string) => void;
  onOpenRoom: (id: string) => void;
}) {
  const { state, dispatch } = useStore();
  const routinesOnly = window.ogb?.remoteClient?.active === true;
  const [days, setDays] = useState<1 | 7>(() => (window.innerWidth < 640 ? 1 : 7));
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [calls, setCalls] = useState<CalendarCall[]>([]);
  const [quick, setQuick] = useState<EventSeed | null>(null);
  const [editor, setEditor] = useState<EventSeed | null>(null);
  const [selected, setSelected] = useState<CalendarEventItem | null>(null);
  const [error, setError] = useState("");
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const rangeStart = days === 7 ? startOfWeek(anchor) : startOfDay(anchor);
  const rangeEnd = addDays(rangeStart, days);
  const markers = resetMarkers(useEngineLimits(), rangeStart, rangeEnd);

  const loadCalls = useCallback(async () => {
    try { setCalls((await api("/api/calendar-calls")).calls ?? []); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => { if (!routinesOnly) void loadCalls(); }, [loadCalls, routinesOnly]);

  const items = useMemo<CalendarEventItem[]>(() => {
    const botIds = new Set(state.bots.map((bot) => bot.id));
    const routines = state.routines.filter((routine) => botIds.has(routine.botId));
    const needsYou = new Set(automationsFrom({ routines, webhooks: [], runs: state.routineRuns }).filter((automation) => automationStatus(automation).state === "needs-you").map((automation) => automation.id));
    const routineItems = projectedRoutineItems(routines, state.routineRuns.filter((run) => botIds.has(run.botId)), rangeStart, rangeEnd)
      .map((item) => ({ ...item, kind: "routine" as const, needsYou: Boolean(item.routine && !item.run && needsYou.has(item.routine.id)) }));
    const callItems = projectCalls(calls, rangeStart, rangeEnd).map((item) => ({ ...item, kind: "call" as const }));
    return [...routineItems, ...callItems]
      .filter((item) => botFilter === "all" || (item.kind === "call" ? item.call.botIds.includes(botFilter) : (item.routine?.botId ?? item.run?.botId) === botFilter))
      .sort((left, right) => left.at - right.at);
  }, [state.routines, state.routineRuns, state.bots, calls, rangeStart, rangeEnd, botFilter]);

  const liveSelected = selected?.kind === "call"
    ? (() => { const call = calls.find((candidate) => candidate.id === selected.call.id); return call ? { ...selected, call } : null; })()
    : null;
  const openItem = (item: CalendarEventItem) => {
    if (item.kind === "call") { setSelected(item); return; }
    setSelected(null);
    const id = item.routine?.id ?? item.run?.routineId;
    if (id) onOpenAutomation(id);
  };
  const openRun = (run: RoutineRun) => onOpenAutomation(run.routineId);
  const selectedId = liveSelected?.id ?? items.find((item) => item.kind === "routine" && (item.routine?.id ?? item.run?.routineId) === selectedAutomationId)?.id;
  const upsertCall = (call: CalendarCall) => setCalls((current) => current.some((candidate) => candidate.id === call.id) ? current.map((candidate) => candidate.id === call.id ? call : candidate) : [call, ...current]);
  const moveEvent = async (dragged: { kind: EventKind; id: string; at: number }, nextAt: number) => {
    if (nextAt === dragged.at) return;
    try {
      if (dragged.kind === "routine") {
        const routine = state.routines.find((candidate) => candidate.id === dragged.id);
        if (!routine) return;
        if (routine.schedule.type === "cron") throw new Error("Open this automation to change its repeating schedule.");
        if (routine.schedule.type !== "once" && !window.confirm("Move every time it repeats?")) return;
        const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(routine.schedule, dragged.at, nextAt) }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        const call = calls.find((candidate) => candidate.id === dragged.id);
        if (!call) return;
        if (call.schedule.type === "daily" && !window.confirm("Move every time it repeats?")) return;
        const response = await api(`/api/calendar-calls/${call.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(call.schedule, dragged.at, nextAt) }) });
        upsertCall(response.call);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  /** A bot dropped on a reset opens the quick composer for a limit-reset automation; an automation dropped there runs
   * at that reset instead of its time. */
  const dropOnReset = async (drop: ResetDrop, marker: ResetMarker) => {
    if ("botId" in drop) {
      setSelected(null);
      setQuick({ kind: "routine", at: marker.at, durationMinutes: 30, botIds: [drop.botId], limitReset: { engine: marker.engine } });
      return;
    }
    if (drop.event.kind !== "routine") return setError(t("limits.callNotOnReset"));
    try {
      const response = await api(`/api/routines/${drop.event.id}`, { method: "PATCH", body: JSON.stringify({ schedule: { type: "limit_reset", engine: marker.engine, repeat: "once" } }) });
      dispatch({ type: "routinePatched", routine: response.routine });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const resizeEvent = async (item: CalendarEventItem, durationMinutes: number) => {
    try {
      if (item.kind === "routine" && item.routine) {
        const response = await api(`/api/routines/${item.routine.id}`, { method: "PATCH", body: JSON.stringify({ durationMinutes }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else if (item.kind === "call") {
        const response = await api(`/api/calendar-calls/${item.call.id}`, { method: "PATCH", body: JSON.stringify({ durationMinutes }) });
        upsertCall(response.call);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const editSelected = () => {
    if (!liveSelected) return;
    setEditor({ kind: "call", at: liveSelected.at, durationMinutes: liveSelected.call.durationMinutes, botIds: liveSelected.call.botIds, call: liveSelected.call });
    setSelected(null);
  };
  const segment = (active: boolean) => cn("rounded-md px-3 py-1 text-[12px] font-medium", active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink");

  return (
    <div className="@container/routines relative flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline/30 px-4 py-2">
        <button type="button" onClick={() => setAnchor((current) => addDays(current, -days))} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("routines.previous")}><ChevronLeft size={16} /></button>
        <button type="button" onClick={() => setAnchor((current) => addDays(current, days))} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("routines.next")}><ChevronRight size={16} /></button>
        <div className="min-w-0 truncate px-1 text-[14px] font-medium text-ink" aria-live="polite">{calendarRangeLabel(rangeStart, days)}</div>
        <button type="button" onClick={() => setAnchor(startOfDay(Date.now()))} className="rounded-lg border border-hairline/50 px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised">{t("routines.today")}</button>
        <div role="group" className="ml-auto flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5" aria-label={t("routines.view.label")}>
          <button type="button" aria-pressed={days === 1} onClick={() => setDays(1)} className={segment(days === 1)}>{t("routines.view.day")}</button>
          <button type="button" aria-pressed={days === 7} onClick={() => setDays(7)} className={segment(days === 7)}>{t("routines.view.week")}</button>
        </div>
        {error && <button type="button" onClick={() => setError("")} className="w-full text-left text-[12px] text-danger">{error}</button>}
      </div>
      <div className="relative flex min-h-0 flex-1">
        {!liveSelected && <div className="hidden shrink-0 @min-[1040px]/routines:block"><CalendarSidebar bots={visibleBots} anchor={anchor} onSelectDate={(at) => setAnchor(startOfDay(at))} /></div>}
        <CalendarGrid anchor={rangeStart} days={days} items={items} bots={state.bots} groups={state.groups} selectedId={selectedId}
          onOpen={openItem}
          onCreate={(seed) => { setSelected(null); setQuick(seed); }}
          onMove={(item, at) => void moveEvent(item, at)} onResize={(item, duration) => void resizeEvent(item, duration)}
          markers={markers} onDropOnReset={(drop, marker) => void dropOnReset(drop, marker)} />
        {liveSelected && (
          <div className="absolute inset-y-0 right-0 z-30 flex shadow-2xl @min-[760px]/routines:static @min-[760px]/routines:shadow-none">
            <EventDetails key={`${liveSelected.kind}:${liveSelected.id}`} item={liveSelected} bots={state.bots} onClose={() => setSelected(null)} onEdit={editSelected} onOpenRun={openRun}
              onCallChanged={(id) => { if (id) setCalls((current) => current.filter((call) => call.id !== id)); else void loadCalls(); }} onOpenRoom={onOpenRoom} />
          </div>
        )}
      </div>
      {quick && <><div className="fixed inset-0 z-40 bg-black/25" onMouseDown={() => setQuick(null)} /><QuickComposer seed={quick} bots={visibleBots} routinesOnly={routinesOnly} onClose={() => setQuick(null)} onMore={(seed) => { setQuick(null); setEditor(seed); }} onSavedRoutine={(routine) => dispatch({ type: "routinePatched", routine })} onSavedCall={upsertCall} /></>}
      {editor && <EventEditor seed={editor} bots={visibleBots} routinesOnly={routinesOnly} onClose={() => setEditor(null)} onSavedCall={upsertCall} />}
    </div>
  );
}
