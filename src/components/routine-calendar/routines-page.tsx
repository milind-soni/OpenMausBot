import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, CircleAlert, Clock3, FileText, List, Loader2, Pause, Plus, Video, Webhook, X } from "lucide-react";
import { CalendarSidebar } from "@/components/routines/CalendarSidebar";
import { RoutineList } from "@/components/routines/RoutineList";
import { RoutineLogs } from "@/components/routines/RoutineLogs";
import { t } from "@/lib/i18n";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { WebhooksPanel } from "@/components/WebhooksPanel";
import type { CalendarCall } from "@/lib/calendar-calls";
import { cn } from "@/lib/cn";
import { addDays, atLocalTime, calendarRangeLabel, projectedRoutineItems, scheduleAt, startOfDay, startOfWeek } from "@/lib/routine-calendar";
import { scheduleLabel } from "@/lib/schedule-label";
import type { Routine, RoutineRun } from "../../../shared/routines";
import { api, useStore } from "@/state/store";
import { type EventKind, type CalendarEventItem, type EventSeed, nextHour, projectCalls } from "./helpers";
import { CalendarGrid } from "./calendar-grid";
import { EventDetails } from "./event-details";
import { EventEditor } from "./event-editor";
import { PausedList } from "./paused-list";
import { QuickComposer } from "./quick-composer";
import { RoutineWakeBar } from "./routine-wake-bar";

export function RoutinesPage({ onBack, onOpenRoom }: { onBack: () => void; onOpenRoom: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const routinesOnly = window.ogb?.remoteClient?.active === true;
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const newMenuRef = useRef<HTMLDetailsElement>(null);
  const [section, setSection] = useState<"calendar" | "logs" | "webhooks">(state.routinesFocus?.section === "logs" ? "logs" : "calendar");
  const [scheduleView, setScheduleView] = useState<"calendar" | "list">(state.routinesFocus?.view ?? "calendar");
  const [viewDays, setViewDays] = useState<1 | 3 | 7>(7);
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [botFilter, setBotFilter] = useState(state.routinesFocus?.botId ?? "all");
  const [routineFilter, setRoutineFilter] = useState<string | undefined>(state.routinesFocus?.routineId);
  const [calls, setCalls] = useState<CalendarCall[]>([]);
  const [quick, setQuick] = useState<EventSeed | null>(null);
  const [editor, setEditor] = useState<EventSeed | null>(null);
  const [selected, setSelected] = useState<CalendarEventItem | null>(null);
  const [pausedOpen, setPausedOpen] = useState(false);
  const [webhookCreateRequest, setWebhookCreateRequest] = useState(0);
  const [error, setError] = useState("");
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const rangeStart = viewDays === 7 ? startOfWeek(anchor) : startOfDay(anchor);
  const rangeEnd = addDays(rangeStart, viewDays);

  useEffect(() => {
    const focus = state.routinesFocus;
    setSection(focus?.section === "logs" ? "logs" : "calendar");
    setScheduleView(focus?.view ?? "calendar");
    setBotFilter(focus?.botId ?? "all");
    setRoutineFilter(focus?.routineId);
  }, [state.routinesFocus]);

  const loadCalls = useCallback(async () => {
    try {
      const response = await api("/api/calendar-calls");
      setCalls(response.calls ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    if (!routinesOnly) void loadCalls();
  }, [loadCalls, routinesOnly]);
  useEffect(() => { backButtonRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const closeNewMenu = (event: PointerEvent) => {
      const menu = newMenuRef.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeNewMenu);
    return () => document.removeEventListener("pointerdown", closeNewMenu);
  }, []);

  const items = useMemo<CalendarEventItem[]>(() => {
    const routineItems = projectedRoutineItems(state.routines, state.routineRuns, rangeStart, rangeEnd).map((item) => ({ ...item, kind: "routine" as const }));
    const callItems = projectCalls(calls, rangeStart, rangeEnd).map((item) => ({ ...item, kind: "call" as const }));
    return [...routineItems, ...callItems]
      .filter((item) => botFilter === "all" || (item.kind === "call" ? item.call.botIds.includes(botFilter) : (item.routine?.botId ?? item.run?.botId) === botFilter))
      .sort((left, right) => left.at - right.at);
  }, [state.routines, state.routineRuns, calls, rangeStart, rangeEnd, botFilter]);

  const liveSelected = selected?.kind === "call"
    ? (() => { const call = calls.find((candidate) => candidate.id === selected.call.id); return call ? { ...selected, call } : null; })()
    : selected?.kind === "routine"
      ? {
          ...selected,
          routine: selected.routine ? state.routines.find((routine) => routine.id === selected.routine?.id) ?? null : null,
          run: selected.run ? state.routineRuns.find((run) => run.id === selected.run?.id) ?? selected.run : null,
        }
      : null;
  const paused = state.routines.filter((routine) => !routine.enabled && (routine.schedule.type !== "once" || routine.schedule.at > Date.now()));
  const running = state.routineRuns.filter((run) => ["queued", "running", "waiting"].includes(run.status)).length;
  const unseenFailures = state.routineRuns.filter((run) => ["failed", "missed"].includes(run.status) && !run.seenAt).length;
  const filteredRoutines = state.routines.filter((routine) => botFilter === "all" || routine.botId === botFilter);
  const filteredRuns = state.routineRuns.filter((run) => botFilter === "all" || run.botId === botFilter);
  const openRoutine = (routine: Routine) => setSelected({ kind: "routine", id: routine.id, at: routine.nextRunAt ?? (routine.schedule.type === "once" ? routine.schedule.at : routine.schedule.type === "interval" ? routine.schedule.anchorAt : routine.schedule.type === "cron" ? nextHour() : atLocalTime(Date.now(), routine.schedule.time)), durationMinutes: routine.durationMinutes, routine, run: null });
  const openLogs = (routine: Routine) => { setRoutineFilter(routine.id); setSection("logs"); };
  const openRun = (run: RoutineRun) => {
    setSelected({ kind: "routine", id: run.id, at: run.scheduledFor, durationMinutes: run.durationMinutes ?? 30, routine: state.routines.find((routine) => routine.id === run.routineId) ?? null, run });
    if (["failed", "missed"].includes(run.status) && !run.seenAt) dispatch({ type: "markRoutineRunSeen", runId: run.id });
  };
  const macInset = capabilities.windowChrome === "mac-inset";
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as CSSProperties)
    : undefined;
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as CSSProperties)
    : undefined;

  const setView = (days: 1 | 3 | 7) => {
    setViewDays(days);
    setAnchor((current) => startOfDay(current));
  };
  const goToday = useCallback(() => setAnchor(startOfDay(Date.now())), []);
  const handleWebhookCreateHandled = useCallback(() => setWebhookCreateRequest(0), []);
  const openCreate = useCallback((seed?: Partial<EventSeed>) => {
    setSelected(null);
    setQuick({ kind: "routine", at: nextHour(), durationMinutes: 30, botIds: [], ...seed });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "Escape") { newMenuRef.current?.removeAttribute("open"); setQuick(null); setEditor(null); setSelected(null); setPausedOpen(false); return; }
      if (newMenuRef.current?.open || quick || editor || selected || pausedOpen) return;
      if (section !== "calendar" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "c") { event.preventDefault(); openCreate(); }
      if (event.key.toLowerCase() === "t") goToday();
      if (event.key === "1") setView(1);
      if (event.key === "3") setView(3);
      if (event.key.toLowerCase() === "w") setView(7);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, openCreate, goToday, anchor, quick, editor, selected, pausedOpen]);

  const upsertCall = (call: CalendarCall) => setCalls((current) => current.some((candidate) => candidate.id === call.id) ? current.map((candidate) => candidate.id === call.id ? call : candidate) : [call, ...current]);
  const moveEvent = async (dragged: { kind: EventKind; id: string; at: number }, nextAt: number) => {
    if (nextAt === dragged.at) return;
    try {
      if (dragged.kind === "routine") {
        const routine = state.routines.find((candidate) => candidate.id === dragged.id);
        if (!routine) return;
        if (routine.schedule.type === "cron") throw new Error(t("routines.cronMoveError"));
        if (routine.schedule.type !== "once" && !window.confirm(t("routines.moveSeriesConfirm"))) return;
        const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(routine.schedule, dragged.at, nextAt) }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        const call = calls.find((candidate) => candidate.id === dragged.id);
        if (!call) return;
        if (call.schedule.type === "daily" && !window.confirm(t("routines.moveSeriesConfirm"))) return;
        const response = await api(`/api/calendar-calls/${call.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(call.schedule, dragged.at, nextAt) }) });
        upsertCall(response.call);
      }
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

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app animate-workspace-in">
      <header
        className={cn("shrink-0 border-b border-hairline/35 bg-app py-3 pr-4", macInset ? "pl-[86px]" : "pl-4")}
        style={windowDragStyle}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            ref={backButtonRef}
            onClick={onBack}
            aria-label={t("routines.back")}
            title={t("routines.back")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
            style={windowNoDragStyle}
          >
            <ArrowLeft size={18} />
          </button>
          <div data-tour="automations-page" className="mr-2 flex items-center gap-2"><CalendarDays size={21} className="text-accent" /><h1 className="text-[18px] font-semibold tracking-tight text-ink">{t("routines.title")}</h1></div>
          <div className="flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5" style={windowNoDragStyle} aria-label={t("routines.sectionLabel")}>
            <button type="button" aria-pressed={section === "calendar"} onClick={() => setSection("calendar")} className={cn("rounded-md px-3 py-1.5 text-[11.5px] font-medium", section === "calendar" ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>{routinesOnly ? t("routines.tab.scheduledRoutines") : t("routines.tab.schedule")}</button>
            <button type="button" aria-pressed={section === "logs"} onClick={() => { setSection("logs"); setRoutineFilter(undefined); }} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-medium", section === "logs" ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}><FileText size={12} />{t("routines.logs")}{unseenFailures > 0 && <span className="rounded-full bg-danger/10 px-1.5 text-[9px] text-danger">{unseenFailures}</span>}</button>
            {!routinesOnly && <button type="button" aria-pressed={section === "webhooks"} onClick={() => setSection("webhooks")} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-medium", section === "webhooks" ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}><Webhook size={12} />{t("routines.tab.webhooks")}{state.webhooks.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[9px] text-accent">{state.webhooks.length}</span>}</button>}
          </div>
          <details ref={newMenuRef} className="group relative ml-auto" style={windowNoDragStyle}>
            <summary role="button" aria-label={t("routines.newAria")} className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12px] font-semibold text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              <Plus size={15} aria-hidden="true" />{t("routines.new")}
            </summary>
            <div role="group" aria-label={t("routines.newGroup")} className="absolute right-0 top-full z-40 mt-1.5 w-[280px] rounded-xl border border-hairline/60 bg-card p-1.5 shadow-2xl">
              <button type="button" aria-label={t("routines.newTaskAria")} onClick={() => { newMenuRef.current?.removeAttribute("open"); setSection("calendar"); openCreate({ kind: "routine" }); }} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised">
                <Clock3 size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span><span className="block text-[12.5px] font-medium text-ink">{t("routines.newTask")}</span><span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-secondary">{t("routines.newTaskHint")}</span></span>
              </button>
              {!routinesOnly && <button type="button" aria-label={t("routines.newCallAria")} onClick={() => { newMenuRef.current?.removeAttribute("open"); setSection("calendar"); openCreate({ kind: "call" }); }} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised">
                <Video size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span><span className="block text-[12.5px] font-medium text-ink">{t("routines.newCall")}</span><span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-secondary">{t("routines.newCallHint")}</span></span>
              </button>}
              {!routinesOnly && <button type="button" aria-label={t("routines.newWebhookAria")} disabled={visibleBots.length === 0} onClick={() => { newMenuRef.current?.removeAttribute("open"); setSection("webhooks"); setWebhookCreateRequest((request) => request + 1); }} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40">
                <Webhook size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span><span className="block text-[12.5px] font-medium text-ink">{t("routines.trigger.webhook")}</span><span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-secondary">{t("routines.newWebhookHint")}</span></span>
              </button>}
            </div>
          </details>
        </div>
        {section !== "webhooks" && <div className="mt-2 flex flex-wrap items-center gap-2" style={windowNoDragStyle}>
          {section === "calendar" && <div className="flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5" aria-label={t("routines.viewLabel")}>
            <button type="button" aria-pressed={scheduleView === "list"} onClick={() => setScheduleView("list")} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px]", scheduleView === "list" ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}><List size={13} />{t("routines.view.list")}</button>
            <button type="button" aria-pressed={scheduleView === "calendar"} onClick={() => setScheduleView("calendar")} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px]", scheduleView === "calendar" ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}><CalendarDays size={13} />{t("routines.view.calendar")}</button>
          </div>}
          {section === "calendar" && scheduleView === "calendar" && <><div className="flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5">
            <button onClick={() => setAnchor((current) => addDays(current, -viewDays))} className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("routines.prevDates")}><ChevronLeft size={16} /></button>
            <button onClick={goToday} className="rounded-md px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised">{t("routines.today")}</button>
            <button onClick={() => setAnchor((current) => addDays(current, viewDays))} className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("routines.nextDates")}><ChevronRight size={16} /></button>
          </div>
          <div className="min-w-[220px] px-2 text-[15px] font-medium text-ink">{calendarRangeLabel(rangeStart, viewDays)}</div></>}
          <div className="ml-auto flex items-center gap-2">
            {running > 0 && <span className="hidden items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1.5 text-[10.5px] text-accent sm:flex"><Loader2 size={11} className="animate-spin" />{t("routines.activeCount", { count: running })}</span>}
            {unseenFailures > 0 && <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs" })} className="hidden items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1.5 text-[10.5px] text-danger sm:flex" title={t("routines.failedLogs")} aria-label={t("routines.failedLogs")}><CircleAlert size={11} />{unseenFailures}</button>}
            {paused.length > 0 && <button onClick={() => setPausedOpen(true)} aria-label={t("routines.pausedAria")} className="hidden items-center gap-1.5 rounded-full border border-hairline/50 px-2.5 py-1.5 text-[10.5px] text-ink-secondary hover:bg-raised sm:flex"><Pause size={11} />{paused.length}</button>}
            <select aria-label={t("routines.filterBots")} value={botFilter} onChange={(event) => { setBotFilter(event.target.value); setRoutineFilter(undefined); }} className="max-w-[180px] rounded-lg border border-hairline/50 bg-panel px-2.5 py-2 text-[11.5px] text-ink outline-none focus:border-accent"><option value="all">{t("routines.allBots")}</option>{visibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
            {section === "calendar" && scheduleView === "calendar" && <select aria-label={t("routines.rangeLabel")} value={viewDays} onChange={(event) => setView(Number(event.target.value) as 1 | 3 | 7)} className="rounded-lg border border-hairline/50 bg-panel px-2.5 py-2 text-[11.5px] text-ink outline-none focus:border-accent"><option value={1}>{t("routines.range.day")}</option><option value={3}>{t("routines.range.days3")}</option><option value={7}>{t("routines.range.week")}</option></select>}
          </div>
          {error && <button onClick={() => setError("")} className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[10.5px] text-danger"><CircleAlert size={11} />{error}<X size={11} /></button>}
          {section === "calendar" && scheduleView === "calendar" && state.routinesLoadState === "error" && <p role="alert" className="w-full text-[11.5px] text-danger">{t("routines.loadError")}</p>}
          {section === "calendar" && scheduleView === "calendar" && state.routinesLoadState === "loading" && state.routines.length === 0 && <p role="status" className="w-full text-[11.5px] text-ink-secondary">{t("routines.loading")}</p>}
        </div>}
      </header>
      <RoutineWakeBar />

      {section === "webhooks" ? <WebhooksPanel bots={visibleBots} createRequest={webhookCreateRequest} onCreateHandled={handleWebhookCreateHandled} /> : section === "logs" ? (
        <div className="min-h-0 flex-1 overflow-y-auto"><RoutineLogs runs={filteredRuns} bots={state.bots} loading={state.routinesLoadState === "loading" && filteredRuns.length === 0} error={state.routinesLoadState === "error"} routineId={routineFilter} onClearRoutine={() => setRoutineFilter(undefined)} onOpen={openRun} /></div>
      ) : scheduleView === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
          <div><h2 className="text-[17px] font-semibold text-ink">{t("routines.listHeading")}</h2><p className="mt-1 text-[12px] text-ink-secondary">{t("routines.listHint")}</p></div>
          <RoutineList routines={filteredRoutines} runs={state.routineRuns} bots={state.bots} loading={state.routinesLoadState === "loading" && filteredRoutines.length === 0} error={state.routinesLoadState === "error"} onOpen={openRoutine} onLogs={openLogs} />
          {!routinesOnly && calls.some((call) => botFilter === "all" || call.botIds.includes(botFilter)) && <section className="space-y-2" aria-label={t("routines.callsHeading")}><h2 className="text-[15px] font-semibold text-ink">{t("routines.callsHeading")}</h2>{calls.filter((call) => botFilter === "all" || call.botIds.includes(botFilter)).map((call) => <button key={call.id} type="button" onClick={() => setSelected({ kind: "call", id: call.id, at: call.schedule.type === "once" ? call.schedule.at : atLocalTime(Date.now(), call.schedule.time), durationMinutes: call.durationMinutes, call })} className="flex w-full items-center gap-3 rounded-xl border border-hairline/40 bg-card p-4 text-left hover:bg-raised"><Video size={17} className="text-accent" /><span><span className="block text-[13px] font-medium text-ink">{call.name}</span><span className="mt-1 block text-[11.5px] text-ink-secondary">{scheduleLabel(call.schedule)}</span></span></button>)}</section>}
        </div></div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="hidden shrink-0 lg:block"><CalendarSidebar bots={visibleBots} anchor={anchor} onSelectDate={(at) => setAnchor(startOfDay(at))} /></div>
          <CalendarGrid anchor={rangeStart} days={viewDays} items={items} bots={state.bots} groups={state.groups} onOpen={(item) => { setSelected(item); if (item.kind === "routine" && item.run && ["failed", "missed"].includes(item.run.status) && !item.run.seenAt) dispatch({ type: "markRoutineRunSeen", runId: item.run.id }); }} onCreate={openCreate} onMove={(item, at) => void moveEvent(item, at)} onResize={(item, duration) => void resizeEvent(item, duration)} />
        </div>
      )}

      {quick && <><div className="fixed inset-0 z-40 bg-black/25" onMouseDown={() => setQuick(null)} /><QuickComposer seed={quick} bots={visibleBots} routinesOnly={routinesOnly} onClose={() => setQuick(null)} onMore={(seed) => { setQuick(null); setEditor(seed); }} onSavedRoutine={(routine) => dispatch({ type: "routinePatched", routine })} onSavedCall={upsertCall} /></>}
      {editor && <EventEditor seed={editor} bots={visibleBots} routinesOnly={routinesOnly} onClose={() => setEditor(null)} onSavedCall={upsertCall} />}
      {liveSelected && <EventDetails key={`${liveSelected.kind}:${liveSelected.id}`} item={liveSelected} bots={state.bots} onClose={() => setSelected(null)} onEdit={() => { const seed: EventSeed = liveSelected.kind === "call" ? { kind: "call", at: liveSelected.at, durationMinutes: liveSelected.call.durationMinutes, botIds: liveSelected.call.botIds, call: liveSelected.call } : { kind: "routine", at: liveSelected.at, durationMinutes: liveSelected.routine?.durationMinutes ?? liveSelected.run?.durationMinutes ?? 30, botIds: [liveSelected.routine?.botId ?? liveSelected.run?.botId ?? ""].filter(Boolean), routine: liveSelected.routine ?? undefined }; setSelected(null); setEditor(seed); }} onCallChanged={(id) => { if (id) setCalls((current) => current.filter((call) => call.id !== id)); else void loadCalls(); }} onOpenRoom={onOpenRoom} />}
      {pausedOpen && <PausedList routines={paused} bots={state.bots} groups={state.groups} onClose={() => setPausedOpen(false)} onEdit={(routine) => { setPausedOpen(false); const at = routine.schedule.type === "once" ? routine.schedule.at : routine.schedule.type === "interval" ? routine.schedule.anchorAt : routine.schedule.type === "cron" ? routine.nextRunAt ?? nextHour() : atLocalTime(Date.now(), routine.schedule.time); setEditor({ kind: "routine", at, durationMinutes: routine.durationMinutes, botIds: [routine.botId], routine }); }} onOpenRoom={onOpenRoom} />}
    </main>
  );
}
