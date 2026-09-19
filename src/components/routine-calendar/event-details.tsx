import { useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, Clock3, ExternalLink, FileText, Loader2, Paperclip, Pause, Play, Target, Trash2, UserRoundPlus, UsersRound, X } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import { CronSchedulePreview } from "@/components/routines/CronScheduleFields";
import { routineRunLabel } from "@/lib/routine-display";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { durationLabel, niceDate, niceTime, scheduleLabel } from "@/lib/schedule-label";
import type { RoutineRun } from "../../../shared/routines";
import { api, openNotificationTarget, useStore, type Bot } from "@/state/store";
import { type CalendarEventItem } from "./helpers";
import { AttachmentChips } from "./attachment-chips";

export function EventDetails({
  item,
  bots,
  onClose,
  onEdit,
  onCallChanged,
  onOpenRoom,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  onClose: () => void;
  onEdit: () => void;
  onCallChanged: (id: string | null) => void;
  onOpenRoom: (id: string) => void;
}) {
  const { state, dispatch } = useStore();
  const [working, setWorking] = useState(false);
  const runNowPending = useRef(false);
  const [starting, setStarting] = useState(false);
  // undefined preserves the selected historical run; null clears it for a new attempt.
  const [submittedRun, setSubmittedRun] = useState<RoutineRun | null | undefined>(undefined);
  const [error, setError] = useState("");
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = submittedRun === undefined
    ? item.kind === "routine" ? item.run : null
    : submittedRun && (state.routineRuns.find((candidate) => candidate.id === submittedRun.id) ?? submittedRun);
  const call = item.kind === "call" ? item.call : null;
  const isRoomGoal = !isCall && (run?.target ?? routine?.target) === "room-goal";
  const goalGroupId = isRoomGoal ? run?.groupId ?? routine?.groupId : undefined;
  const goalGroup = state.groups.find((group) => group.id === goalGroupId);
  const executionThreadId = run?.executionThreadId ?? run?.threadId;
  const botIds = call?.botIds ?? [run?.botId ?? routine?.botId ?? ""];
  const invited = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = invited[0];
  const executionOwner = isRoomGoal ? goalGroup : primary;
  const canOpenExecution = Boolean(executionThreadId && (executionOwner?.threadId === executionThreadId || executionOwner?.tasks?.some((task) => task.threadId === executionThreadId)));
  const report = run ?? routine;
  const resultsThreadId = report?.resultsThreadId ?? report?.sourceThreadId;
  const canOpenResults = resultsThreadId && [...state.bots, ...state.groups].some((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId));
  const title = call?.name ?? run?.routineName ?? routine?.name ?? "Routine";
  const description = call?.description ?? run?.prompt ?? routine?.prompt ?? "";
  const attachments = call?.attachments ?? run?.attachments ?? routine?.attachments ?? [];
  const roomId = call?.botIds.length === 1 ? primary?.id : undefined;
  const safetyLimit = run ? run.timeoutMinutes : routine?.timeoutMinutes;

  const openRunTask = () => {
    if (!executionThreadId) return;
    if (isRoomGoal && goalGroupId) {
      dispatch({ type: "switchGroupTask", groupId: goalGroupId, threadId: executionThreadId });
      onOpenRoom(goalGroupId);
    } else if (primary) {
      dispatch({ type: "select", id: primary.id });
      dispatch({ type: "switchTask", botId: primary.id, threadId: executionThreadId });
    }
    onClose();
  };

  const invoke = async (path: string, method = "POST", body?: unknown) => {
    setWorking(true);
    setError("");
    try {
      const response = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.routine) dispatch({ type: "routinePatched", routine: response.routine });
      if (response.run) dispatch({ type: "routineRunPatched", run: response.run });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const runRoutineNow = () => {
    if (!routine || working || runNowPending.current) return;
    runNowPending.current = true;
    setStarting(true);
    setSubmittedRun(null);
    setWorking(true);
    setError("");
    // The store flushes pending model and approval-level changes before it
    // starts the run. Keep this button pending through that barrier and the
    // POST so a double-click cannot create two routine runs.
    dispatch({
      type: "runRoutine",
      routineId: routine.id,
      // Prefer subsequent SSE records over this response, which may already be stale.
      onStarted: setSubmittedRun,
      onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
      onSettled: () => {
        runNowPending.current = false;
        setStarting(false);
        setWorking(false);
      },
    });
  };

  const joinRoom = async () => {
    if (!call) return;
    setWorking(true);
    setError("");
    try {
      const { group: created } = await api(`/api/calendar-calls/${call.id}/room`, { method: "POST" });
      dispatch({ type: "groupPatched", group: created });
      onOpenRoom(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const deleteEvent = async () => {
    if (!window.confirm(t("calendar.eventDetails.deleteConfirm", { title }))) return;
    setWorking(true);
    setError("");
    try {
      if (call) {
        await api(`/api/calendar-calls/${call.id}`, { method: "DELETE" });
        onCallChanged(call.id);
      } else if (routine) {
        dispatch({ type: "deleteRoutine", routineId: routine.id });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const dialogRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute("hidden"));
    (dialog.querySelector<HTMLInputElement>("input:not([disabled])") ?? focusable()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return event.preventDefault();
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-[2px]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("calendar.eventDetails.dialogAria")} tabIndex={-1} className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-start gap-4 border-b border-hairline/40 px-5 py-4">
          <span className={cn("mt-1 size-4 shrink-0 rounded", isCall ? "bg-[#6d7cff]" : "bg-accent")} />
          <div className="min-w-0 flex-1">
            <div className="text-[19px] font-semibold text-ink">{title}</div>
            <div className="mt-1 text-[12.5px] text-ink-secondary">
              {niceDate(item.at)} · {niceTime(item.at)}{isCall ? ` – ${niceTime(item.at + item.durationMinutes * 60_000)}` : ""}
            </div>
            {(routine || call) && <div className="mt-1 text-[11.5px] text-ink-secondary">{scheduleLabel((routine ?? call)!.schedule)}</div>}
            {routine?.schedule.type === "cron" && <div className="mt-3"><CronSchedulePreview schedule={routine.schedule} paused={!routine.enabled} /></div>}
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("calendar.eventDetails.close")}><X size={17} /></button>
        </div>

        <div className="max-h-[58vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-start gap-3">
            {isRoomGoal ? <Target size={17} className="mt-1 shrink-0 text-ink-secondary" /> : <UserRoundPlus size={17} className="mt-1 shrink-0 text-ink-secondary" />}
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{isCall ? t("calendar.eventDetails.botsInvited") : isRoomGoal ? t("calendar.eventDetails.leadCoordinator") : t("calendar.eventDetails.assignedBot")}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {invited.map((bot) => <div key={bot.id} className="flex items-center gap-2 rounded-full border border-hairline/50 bg-inset py-1 pl-1 pr-2.5"><BotAvatar bot={bot} state="idle" size={26} animated={false} /><span className="text-[11.5px] text-ink">{bot.name}</span></div>)}
              </div>
            </div>
          </div>
          {isRoomGoal && (
            <div className="flex items-start gap-3">
              <UsersRound size={17} className="mt-1 shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{t("calendar.eventDetails.teamGoalGroup")}</div>
                <div className="mt-1 text-[12.5px] text-ink">{goalGroup?.name ?? t("calendar.eventDetails.groupUnavailable")}</div>
              </div>
            </div>
          )}
          {description && <div className="flex items-start gap-3"><FileText size={17} className="mt-1 shrink-0 text-ink-secondary" /><div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{description}</div></div>}
          {attachments.length > 0 && <div className="flex items-start gap-3"><Paperclip size={17} className="mt-1 shrink-0 text-ink-secondary" /><div className="min-w-0 flex-1 space-y-2"><AttachmentChips attachments={attachments} />{call && <div className="text-[11px] leading-relaxed text-ink-secondary">{call.botIds.length > 1 ? t("calendar.eventDetails.attachmentsShared") : t("calendar.eventDetails.attachmentsStay")}</div>}</div></div>}
          {!isCall && <div className="flex items-start gap-3"><Clock3 size={17} className="mt-1 shrink-0 text-ink-secondary" /><div><div className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{t("calendar.eventDetails.runLimit")}</div><div className="mt-1 text-[12.5px] text-ink">{safetyLimit == null ? t("calendar.eventDetails.noTimeLimit") : t("calendar.eventDetails.stopsAfter", { duration: durationLabel(safetyLimit) })}</div></div></div>}
          {run && <div role="status" aria-live="polite" className="rounded-xl border border-hairline/40 bg-inset p-3"><div className="flex items-center gap-2 text-[12px] font-medium text-ink">{run.status === "running" && <Loader2 size={13} className="animate-spin text-accent" />}{routineRunLabel(run)}</div>{run.output && <div className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-secondary">{run.output}</div>}{run.error && <div className="mt-2 text-[11.5px] text-danger">{run.error}</div>}</div>}
          {run?.attention && <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-warning"><CircleAlert size={15} className="mt-0.5 shrink-0" /><div className="min-w-0 whitespace-pre-wrap text-[11.5px] leading-relaxed">{run.attention}</div></div>}
          {run?.status === "waiting" && !run.attention && <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-[11.5px] text-warning">{t("calendar.eventDetails.waitingHint")}</div>}
          {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</div>}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-hairline/40 px-4 py-3">
          {roomId && <button onClick={() => onOpenRoom(roomId)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110"><ExternalLink size={13} />{t("calendar.eventDetails.joinGroup")}</button>}
          {call && call.botIds.length > 1 && <button onClick={joinRoom} disabled={working} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"><ExternalLink size={13} />{t("calendar.eventDetails.joinGroup")}</button>}
          {isRoomGoal && goalGroup && !executionThreadId && <button onClick={() => { onOpenRoom(goalGroup.id); onClose(); }} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110"><ExternalLink size={13} />{t("calendar.eventDetails.openGroup")}</button>}
          {routine && <button onClick={runRoutineNow} disabled={working} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50">{starting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}{starting ? t("calendar.eventDetails.starting") : t("calendar.eventDetails.runNow")}</button>}
          {canOpenExecution && <button onClick={openRunTask} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><ExternalLink size={13} />{isRoomGoal ? t("calendar.eventDetails.openGroupThread") : t("calendar.eventDetails.openThread")}</button>}
          {canOpenResults && resultsThreadId && <button type="button" onClick={() => { openNotificationTarget(dispatch, { botId: botIds[0], threadId: resultsThreadId }, state); onClose(); }} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><ExternalLink size={13} />{t("routines.results.open")}</button>}
          {routine && <button type="button" onClick={() => { dispatch({ type: "showRoutines", section: "logs", routineId: routine.id, botId: routine.botId }); onClose(); }} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><FileText size={13} />{t("routines.logs")}</button>}
          {run && ["queued", "running", "waiting"].includes(run.status) && <button onClick={() => void invoke(`/api/routine-runs/${run.id}/cancel`)} disabled={working} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"><X size={13} />{t("calendar.eventDetails.cancelRun")}</button>}
          <div className="ml-auto flex items-center gap-1">
            {(routine || call) && <button onClick={onEdit} className="rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">{t("calendar.eventDetails.edit")}</button>}
            {routine && <button disabled={working} onClick={() => void invoke(`/api/routines/${routine.id}`, "PATCH", { enabled: !routine.enabled })} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40" title={routine.enabled ? t("calendar.eventDetails.pauseRoutine") : t("calendar.eventDetails.resumeRoutine")}>{routine.enabled ? <Pause size={15} /> : <Play size={15} />}</button>}
            {(routine || call) && <button onClick={() => void deleteEvent()} disabled={working} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40" title={t("calendar.eventDetails.delete")}><Trash2 size={15} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}
