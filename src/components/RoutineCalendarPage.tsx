import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cloud,
  ExternalLink,
  FileText,
  Laptop,
  Loader2,
  Paperclip,
  Pause,
  Play,
  Plus,
  Repeat2,
  Search,
  Target,
  Trash2,
  UserRoundPlus,
  UsersRound,
  Video,
  Webhook,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { pathForFile } from "@/components/ComposerAttachments";
import { CalendarSidebar } from "@/components/routines/CalendarSidebar";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { WebhooksPanel } from "@/components/WebhooksPanel";
import type { CalendarCall, CalendarCallAttachment, CalendarCallInput } from "@/lib/calendar-calls";
import { cn } from "@/lib/cn";
import {
  imageAttachmentFromFile,
  intakeFiles,
  type Attachment,
} from "@/lib/composer-attachments";
import { MAUS_COLORS, type MausState } from "@/lib/mascot";
import {
  addDays,
  atLocalTime,
  CALENDAR_SLOT_MINUTES,
  calendarRangeLabel,
  formatGmtOffset,
  fromLocalDateAndTime,
  packCalendarCollisions,
  projectedRoutineItems,
  scheduleAt,
  slotAt,
  startOfDay,
  startOfWeek,
  toLocalDateInput,
  toLocalTimeInput,
  type RoutineCalendarItem,
} from "@/lib/routine-calendar";
import { DAY_NAMES, durationLabel, intervalLabel, niceDate, niceTime, scheduleLabel } from "@/lib/schedule-label";
import type {
  Routine,
  RoutineContextAttachment,
  RoutineGoalStatus,
  RoutineInput,
  RoutineRunOn,
  RoutineRunStatus,
  RoutineSchedule,
  RoutineTarget,
} from "@/lib/routines";
import { api, useStore, type Bot, type Group } from "@/state/store";

const HOUR_HEIGHT = 64;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const INTERVAL_PRESETS = [5, 10, 15, 30, 60];
const EVENT_DURATION_OPTIONS = Array.from({ length: 240 / CALENDAR_SLOT_MINUTES }, (_, index) => (index + 1) * CALENDAR_SLOT_MINUTES);
const BOT_DRAG_TYPE = "application/x-openmaus-bot";
const EVENT_DRAG_TYPE = "application/x-openmaus-calendar-event";

type EventKind = "routine" | "call";
type RecurrenceChoice = "none" | "daily" | "weekdays" | "weekly" | "custom" | "interval";
type CalendarRecurrenceChoice = Exclude<RecurrenceChoice, "interval">;

type CallOccurrence = {
  id: string;
  at: number;
  durationMinutes: number;
  call: CalendarCall;
};

type CalendarEventItem =
  | ({ kind: "routine" } & RoutineCalendarItem)
  | ({ kind: "call" } & CallOccurrence);

type EventSeed = {
  kind: EventKind;
  at: number;
  durationMinutes: number;
  botIds: string[];
  name?: string;
  description?: string;
  anchor?: { x: number; y: number };
  routine?: Routine;
  call?: CalendarCall;
};

function activeRoomMembers(group: Group | undefined, bots: Bot[]): Bot[] {
  if (!group) return [];
  return group.memberIds.flatMap((id) => {
    const bot = bots.find((candidate) => candidate.id === id);
    return bot && !bot.hidden ? [bot] : [];
  });
}

function roomCanRunGoal(group: Group): boolean {
  if (group.dm) return false;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
  return !hasSetupMarker ||
    group.setupCompletedAt != null ||
    group.setupSkippedAt != null ||
    (group.messages?.length ?? 0) > 0;
}

function preferredRoomLead(group: Group | undefined, bots: Bot[], preferredId?: string): Bot | undefined {
  const members = activeRoomMembers(group, bots);
  const explicitLeadId = group?.defaultResponder.kind === "member" ? group.defaultResponder.botId : undefined;
  return members.find((bot) => bot.id === preferredId)
    ?? members.find((bot) => bot.id === explicitLeadId)
    ?? members.find((bot) => bot.chiefOfStaff)
    ?? members[0];
}

function nextHour(): number {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function recurrenceFor(schedule: RoutineSchedule | CalendarCall["schedule"], at: number): RecurrenceChoice {
  if (schedule.type === "once") return "none";
  if (schedule.type === "interval") return "interval";
  if (schedule.weekdays.length === 7) return "daily";
  if (schedule.weekdays.join(",") === "1,2,3,4,5") return "weekdays";
  if (schedule.weekdays.length === 1 && schedule.weekdays[0] === new Date(at).getDay()) return "weekly";
  return "custom";
}

function makeCalendarSchedule(choice: CalendarRecurrenceChoice, at: number, weekdays: number[]): CalendarCall["schedule"] {
  if (choice === "none") return { type: "once", at };
  const selected = choice === "daily"
    ? ALL_DAYS
    : choice === "weekdays"
      ? WEEKDAYS
      : choice === "weekly"
        ? [new Date(at).getDay()]
        : weekdays;
  return { type: "daily", time: toLocalTimeInput(at), weekdays: [...selected].sort() };
}

function makeRoutineSchedule(choice: RecurrenceChoice, at: number, weekdays: number[], everyMinutes: number): RoutineSchedule {
  if (choice === "interval") return { type: "interval", everyMinutes, anchorAt: at };
  return makeCalendarSchedule(choice, at, weekdays);
}

function projectCalls(calls: CalendarCall[], from: number, to: number): CallOccurrence[] {
  const items: CallOccurrence[] = [];
  for (const call of calls) {
    if (call.schedule.type === "once") {
      if (call.schedule.at >= from && call.schedule.at < to) {
        items.push({ id: `call-${call.id}-${call.schedule.at}`, at: call.schedule.at, durationMinutes: call.durationMinutes, call });
      }
      continue;
    }
    for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
      if (!call.schedule.weekdays.includes(new Date(day).getDay())) continue;
      const at = atLocalTime(day, call.schedule.time);
      if (at >= from && at < to && at >= call.createdAt) {
        items.push({ id: `call-${call.id}-${at}`, at, durationMinutes: call.durationMinutes, call });
      }
    }
  }
  return items.sort((left, right) => left.at - right.at);
}

function statusState(status: RoutineRunStatus): MausState {
  if (status === "running") return "working";
  if (status === "waiting") return "curious";
  if (status === "completed") return "proud";
  if (status === "failed" || status === "missed") return "sad";
  if (status === "cancelled") return "sleeping";
  return "drowsy";
}

function goalStatusLabel(status: RoutineGoalStatus): string {
  if (status === "needs-input") return "needs your input";
  if (status === "limit-reached") return "turn limit reached";
  return status;
}

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Array<RoutineContextAttachment | CalendarCallAttachment>;
  onRemove?: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="flex max-w-[260px] items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-2.5 py-2 text-[12px] text-ink">
          <FileText size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          {onRemove && <button type="button" onClick={() => onRemove(attachment.id)} className="rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={`Remove ${attachment.name}`}><X size={12} /></button>}
        </div>
      ))}
    </div>
  );
}

function BotPicker({
  bots,
  selected,
  multiple,
  locked,
  onChange,
}: {
  bots: Bot[];
  selected: string[];
  multiple: boolean;
  locked?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = bots.filter((bot) => `${bot.name} ${bot.title}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="rounded-xl border border-hairline/50 bg-inset/60 p-2">
      {!locked && bots.length > 5 && (
        <label className="mb-2 flex items-center gap-2 rounded-lg bg-panel px-2.5 py-2 text-ink-secondary">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a bot" className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-secondary/60" />
        </label>
      )}
      <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
        {filtered.map((bot) => {
          const active = selected.includes(bot.id);
          return (
            <button
              key={bot.id}
              type="button"
              disabled={locked}
              onClick={() => onChange(multiple ? (active ? selected.filter((id) => id !== bot.id) : [...selected, bot.id]) : [bot.id])}
              className={cn("flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition", active ? "bg-accent/12 ring-1 ring-accent/50" : "hover:bg-raised", locked && "cursor-default")}
            >
              <BotAvatar bot={bot} state={active ? "happy" : "idle"} size={32} animated={false} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{bot.name}</span>
              {active && <CheckCircle2 size={14} className="shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function toContextAttachments(attachments: Attachment[]): Array<RoutineContextAttachment | CalendarCallAttachment> {
  return attachments.flatMap((attachment) => attachment.kind === "paste" ? [] : [{
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    path: attachment.path,
    size: attachment.size,
  }]);
}

function EventEditor({
  seed,
  bots,
  lockedBotId,
  defaultRunOn,
  routinesOnly = false,
  onClose,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  routinesOnly?: boolean;
  onClose: () => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { state, dispatch } = useStore();
  const existingRoutine = seed.routine;
  const existingCall = seed.call;
  const [kind, setKind] = useState<EventKind>(routinesOnly ? "routine" : seed.kind);
  const [name, setName] = useState(existingRoutine?.name ?? existingCall?.name ?? seed.name ?? "");
  const [description, setDescription] = useState(existingRoutine?.prompt ?? existingCall?.description ?? seed.description ?? "");
  const initialAt = existingRoutine?.schedule.type === "once"
    ? existingRoutine.schedule.at
    : existingRoutine?.schedule.type === "daily"
      ? atLocalTime(seed.at, existingRoutine.schedule.time)
      : existingRoutine?.schedule.type === "interval"
        ? existingRoutine.schedule.anchorAt
      : existingCall?.schedule.type === "once"
        ? existingCall.schedule.at
        : existingCall?.schedule.type === "daily"
          ? atLocalTime(seed.at, existingCall.schedule.time)
          : seed.at;
  const schedule = existingRoutine?.schedule ?? existingCall?.schedule ?? { type: "once" as const, at: initialAt };
  const [date, setDate] = useState(toLocalDateInput(initialAt));
  const [startTime, setStartTime] = useState(toLocalTimeInput(initialAt));
  const [durationMinutes, setDurationMinutes] = useState(existingRoutine?.durationMinutes ?? existingCall?.durationMinutes ?? seed.durationMinutes);
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | null>(
    existingRoutine?.timeoutMinutes ?? null,
  );
  const [intervalTimeoutDefaultApplied, setIntervalTimeoutDefaultApplied] = useState(Boolean(existingRoutine));
  const [recurrence, setRecurrence] = useState<RecurrenceChoice>(recurrenceFor(schedule, initialAt));
  const [weekdays, setWeekdays] = useState(schedule.type === "daily" ? schedule.weekdays : [new Date(initialAt).getDay()]);
  const [intervalMinutes, setIntervalMinutes] = useState(schedule.type === "interval" ? schedule.everyMinutes : 15);
  const [botIds, setBotIds] = useState(lockedBotId ? [lockedBotId] : existingRoutine ? [existingRoutine.botId] : existingCall?.botIds ?? seed.botIds);
  const [routineTarget, setRoutineTarget] = useState<RoutineTarget>(existingRoutine?.target ?? "bot");
  const [groupId, setGroupId] = useState(existingRoutine?.groupId ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(existingRoutine?.runOn ?? defaultRunOn ?? "maus");
  const [attachments, setAttachments] = useState<Array<RoutineContextAttachment | CalendarCallAttachment>>(
    existingRoutine?.target === "room-goal" ? [] : existingRoutine?.attachments ?? existingCall?.attachments ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [attachmentPendingCount, setAttachmentPendingCount] = useState(0);
  const attachmentPending = attachmentPendingCount > 0;
  const fileInput = useRef<HTMLInputElement>(null);
  const cloudInstance = state.instances.find((instance) => instance.driverKind === "boxAgent");
  const cloudReady = Boolean(state.config?.box.configured && cloudInstance?.snapshot.state === "available");
  const rooms = state.groups.filter(roomCanRunGoal);
  const selectedRoom = rooms.find((group) => group.id === groupId);
  const roomMembers = activeRoomMembers(selectedRoom, state.bots);
  const isRoomGoal = kind === "routine" && routineTarget === "room-goal";
  const at = fromLocalDateAndTime(date, startTime);
  const endAt = at + durationMinutes * 60_000;
  const selectedBots = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const intervalInvalid = recurrence === "interval"
    && (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1_440);

  const selectRecurrence = (choice: RecurrenceChoice) => {
    if (choice === "interval" && recurrence !== "interval" && !existingRoutine) {
      const firstAt = Date.now() + intervalMinutes * 60_000;
      setDate(toLocalDateInput(firstAt));
      setStartTime(toLocalTimeInput(firstAt));
    }
    if (choice === "interval" && !intervalTimeoutDefaultApplied) {
      setTimeoutMinutes((current) => current ?? 30);
      setIntervalTimeoutDefaultApplied(true);
    }
    setRecurrence(choice);
  };

  const selectRoutineTarget = (target: RoutineTarget) => {
    setRoutineTarget(target);
    if (target === "bot") {
      setGroupId("");
      return;
    }
    setRunOn("maus");
    setAttachments([]);
    setAttachmentNotice("");
    const room = selectedRoom ?? rooms[0];
    setGroupId(room?.id ?? "");
    const lead = preferredRoomLead(room, state.bots, botIds[0]);
    setBotIds(lead ? [lead.id] : []);
  };

  const selectRoom = (nextGroupId: string) => {
    const room = rooms.find((candidate) => candidate.id === nextGroupId);
    setGroupId(nextGroupId);
    const lead = preferredRoomLead(room, state.bots, botIds[0]);
    setBotIds(lead ? [lead.id] : []);
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length || isRoomGoal) return;
    setAttachmentPendingCount((count) => count + 1);
    try {
      const result = await intakeFiles(Array.from(files), {
        allowImages: true,
        getPath: pathForFile,
        uploadImage: imageAttachmentFromFile,
      });
      const added = toContextAttachments(result.attachments);
      if (added.length) {
        setAttachments((current) => [...current, ...added].slice(0, 20));
        if (runOn === "cloud") setRunOn("maus");
      }
      if (result.notice) setAttachmentNotice(result.notice);
    } finally {
      setAttachmentPendingCount((count) => Math.max(0, count - 1));
    }
  };

  const save = async () => {
    if (attachmentPending) return;
    setSaving(true);
    setError("");
    try {
      if (kind === "routine" || routinesOnly) {
        const nextSchedule = makeRoutineSchedule(recurrence, at, weekdays, intervalMinutes);
        const input: RoutineInput = {
          name,
          prompt: description,
          target: routineTarget,
          botId: lockedBotId ?? botIds[0] ?? "",
          groupId: routineTarget === "room-goal" ? groupId : null,
          runOn: routineTarget === "room-goal" ? "maus" : runOn,
          enabled: existingRoutine ? undefined : true,
          schedule: nextSchedule,
          durationMinutes,
          timeoutMinutes,
          attachments: routineTarget === "room-goal" ? [] : attachments as RoutineContextAttachment[],
        };
        const response = await api(existingRoutine ? `/api/routines/${existingRoutine.id}` : "/api/routines", {
          method: existingRoutine ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        const nextSchedule = makeCalendarSchedule(recurrence === "interval" ? "none" : recurrence, at, weekdays);
        const input: CalendarCallInput = {
          name,
          description,
          botIds,
          schedule: nextSchedule,
          durationMinutes,
          attachments: attachments as CalendarCallAttachment[],
        };
        const response = await api(existingCall ? `/api/calendar-calls/${existingCall.id}` : "/api/calendar-calls", {
          method: existingCall ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        onSavedCall(response.call);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const valid = Boolean(
    name.trim()
    && (kind === "call" || description.trim())
    && (!lockedBotId || botIds[0] === lockedBotId)
    && (kind === "call"
      ? botIds.length > 0
      : routineTarget === "room-goal"
        ? groupId && botIds[0] && roomMembers.some((bot) => bot.id === botIds[0])
        : botIds.length > 0)
    && !intervalInvalid,
  );
  const canSwitchKind = !routinesOnly && !existingRoutine && !existingCall && !lockedBotId;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute("hidden"));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={existingRoutine || existingCall ? "Edit calendar event" : "Create calendar event"} tabIndex={-1} className="max-h-[94vh] w-full max-w-[760px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-hairline/40 bg-panel/95 px-5 py-3.5 backdrop-blur">
          <div className="text-[15px] font-semibold text-ink">{existingRoutine || existingCall ? "Edit event" : "New event"}</div>
          <button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-8">
          {canSwitchKind && (
            <div className="ml-10 inline-flex rounded-lg bg-inset p-1">
              <button type="button" onClick={() => { setKind("routine"); setBotIds((ids) => ids.slice(0, 1)); }} className={cn("rounded-md px-4 py-1.5 text-[12.5px] font-medium", kind === "routine" ? "bg-raised text-ink shadow" : "text-ink-secondary")}>Routine</button>
              <button type="button" onClick={() => { setKind("call"); if (recurrence === "interval") setRecurrence("none"); }} className={cn("rounded-md px-4 py-1.5 text-[12.5px] font-medium", kind === "call" ? "bg-raised text-ink shadow" : "text-ink-secondary")}>Call</button>
            </div>
          )}

          {kind === "routine" && !lockedBotId && (
            <div className="ml-10">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Routine type</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => selectRoutineTarget("bot")}
                  className={cn("flex items-start gap-3 rounded-xl border p-3 text-left transition", routineTarget === "bot" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}
                >
                  <UserRoundPlus size={17} className={cn("mt-0.5 shrink-0", routineTarget === "bot" ? "text-accent" : "text-ink-secondary")} />
                  <span><span className="block text-[12.5px] font-medium text-ink">Bot task</span><span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">One bot owns and completes each run.</span></span>
                </button>
                <button
                  type="button"
                  onClick={() => selectRoutineTarget("room-goal")}
                  className={cn("flex items-start gap-3 rounded-xl border p-3 text-left transition", routineTarget === "room-goal" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}
                >
                  <Target size={17} className={cn("mt-0.5 shrink-0", routineTarget === "room-goal" ? "text-accent" : "text-ink-secondary")} />
                  <span><span className="block text-[12.5px] font-medium text-ink">Team goal</span><span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">A lead coordinates the room until the goal settles.</span></span>
                </button>
              </div>
            </div>
          )}

          <div className="flex items-start gap-4">
            <span className="mt-3 size-4 shrink-0 rounded bg-accent" />
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "routine" ? "Add title" : "Add call title"} className="min-w-0 flex-1 border-b border-hairline/60 bg-transparent px-1 pb-2 text-[22px] font-medium text-ink outline-none placeholder:text-ink-secondary/55 focus:border-accent" />
          </div>

          <div className="flex items-start gap-4">
            <Clock3 size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1 space-y-3">
              {recurrence !== "interval" && (
                <div className="flex flex-wrap items-center gap-2">
                  {kind === "routine" && recurrence === "none" && <span className="text-[12px] font-medium text-ink-secondary">Starts</span>}
                  {kind === "routine" && recurrence === "weekly" && <span className="text-[12px] font-medium text-ink-secondary">On</span>}
                  {(kind === "call" || recurrence === "none" || recurrence === "weekly") && <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />}
                  <input type="time" step={CALENDAR_SLOT_MINUTES * 60} value={startTime} onChange={(event) => setStartTime(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />
                  {kind === "call" && <>
                    <span className="text-[12px] text-ink-secondary">to</span>
                    <span className="rounded-lg border border-hairline/40 bg-inset/60 px-3 py-2 text-[13px] text-ink">{niceTime(endAt)}</span>
                    <select aria-label="Call duration" value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12px] text-ink outline-none focus:border-accent">
                      {EVENT_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{durationLabel(minutes)}</option>)}
                    </select>
                  </>}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Repeat2 size={14} className="text-ink-secondary" />
                <select value={recurrence} onChange={(event) => selectRecurrence(event.target.value as RecurrenceChoice)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent">
                  <option value="none">Does not repeat</option>
                  {kind === "routine" && <option value="interval">Every X minutes</option>}
                  <option value="daily">Daily</option>
                  <option value="weekdays">Every weekday (Monday to Friday)</option>
                  <option value="weekly">Weekly on {DAY_NAMES[new Date(at).getDay()]}</option>
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {recurrence === "custom" && (
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((label, day) => <button key={label} type="button" onClick={() => setWeekdays((current) => current.includes(day) ? (current.length === 1 ? current : current.filter((value) => value !== day)) : [...current, day].sort())} className={cn("size-8 rounded-full text-[10px] font-semibold", weekdays.includes(day) ? "bg-accent text-white" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink")}>{label[0]}</button>)}
                </div>
              )}
              {recurrence === "interval" && kind === "routine" && (
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink">
                    <span className="font-medium">Runs every</span>
                    <select
                      value={INTERVAL_PRESETS.includes(intervalMinutes) ? String(intervalMinutes) : "custom"}
                      onChange={(event) => setIntervalMinutes(event.target.value === "custom" ? 0 : Number(event.target.value))}
                      aria-label="How often this routine runs"
                      className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] tabular-nums text-ink outline-none focus:border-accent"
                    >
                      {INTERVAL_PRESETS.map((minutes) => <option key={minutes} value={minutes}>{minutes}</option>)}
                      <option value="custom">Custom…</option>
                    </select>
                    {!INTERVAL_PRESETS.includes(intervalMinutes) && (
                      <input
                        type="number"
                        min={5}
                        max={1_440}
                        step={1}
                        value={intervalMinutes || ""}
                        onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                        aria-label="Custom interval in minutes"
                        aria-invalid={intervalInvalid}
                        aria-describedby={intervalInvalid ? "routine-interval-error" : "routine-interval-help"}
                        autoFocus
                        className={cn("w-20 rounded-lg border bg-inset px-3 py-2 text-[12.5px] tabular-nums text-ink outline-none focus:border-accent", intervalInvalid ? "border-danger/70" : "border-hairline/50")}
                      />
                    )}
                    <span>minutes, starting</span>
                    <input aria-label="Interval start date" type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />
                    <span>at</span>
                    <input aria-label="Interval start time" type="time" step={CALENDAR_SLOT_MINUTES * 60} value={startTime} onChange={(event) => setStartTime(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />
                    <span>.</span>
                  </div>
                  <div id="routine-interval-help" className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
                    The cadence continues from this starting point. If a run is still active, the next occurrence is skipped instead of queued.
                  </div>
                  {intervalInvalid && (
                    <div id="routine-interval-error" className="mt-2 text-[11px] text-danger">Choose a whole number from 5 to 1,440 minutes.</div>
                  )}
                </div>
              )}
              {kind === "routine" && (
                <details className="rounded-xl border border-hairline/40 bg-inset/40 px-3 py-2.5">
                  <summary className="cursor-pointer select-none text-[11.5px] font-medium text-ink-secondary hover:text-ink">
                    Advanced · {timeoutMinutes == null ? "no run limit" : `${durationLabel(timeoutMinutes)} run limit`}
                  </summary>
                  <div className="mt-3 border-t border-hairline/35 pt-3">
                    <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                      <span>Stop if still running after</span>
                      <select aria-label="Routine safety limit" value={timeoutMinutes ?? ""} onChange={(event) => setTimeoutMinutes(event.target.value ? Number(event.target.value) : null)} className="rounded-lg border border-hairline/50 bg-panel px-3 py-2 text-[12px] text-ink outline-none focus:border-accent">
                        <option value="">No limit</option>
                        {EVENT_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{durationLabel(minutes)}</option>)}
                      </select>
                    </label>
                    <div className="mt-1.5 text-[10.5px] leading-relaxed text-ink-secondary">Optional. The clock starts when work actually begins and does not control how often the routine starts.</div>
                  </div>
                </details>
              )}
            </div>
          </div>

          <div className="flex items-start gap-4">
            {isRoomGoal ? <UsersRound size={18} className="mt-2.5 shrink-0 text-ink-secondary" /> : <UserRoundPlus size={18} className="mt-2.5 shrink-0 text-ink-secondary" />}
            <div className="min-w-0 flex-1">
              {isRoomGoal ? (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="routine-goal-room" className="mb-2 block text-[12.5px] font-medium text-ink">Choose a room</label>
                    {rooms.length > 0 ? (
                      <select id="routine-goal-room" value={groupId} onChange={(event) => selectRoom(event.target.value)} className="w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[12.5px] text-ink outline-none focus:border-accent">
                        <option value="">Select a room</option>
                        {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                      </select>
                    ) : (
                      <div className="rounded-xl border border-dashed border-hairline/60 bg-inset px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-secondary">Create a room from the sidebar first, then come back to schedule its goal.</div>
                    )}
                  </div>
                  {selectedRoom && (
                    <div>
                      <div className="mb-2 text-[12.5px] font-medium text-ink">Choose the lead</div>
                      {roomMembers.length > 0 ? (
                        <>
                          <BotPicker bots={roomMembers} selected={botIds} multiple={false} onChange={setBotIds} />
                          <div className="mt-2 text-[11.5px] text-ink-secondary">The lead coordinates {selectedRoom.name} and assigns work to its active members.</div>
                        </>
                      ) : (
                        <div className="rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[11.5px] text-warning">This room has no active members. Add or restore a bot before scheduling the goal.</div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="mb-2 text-[12.5px] font-medium text-ink">{kind === "routine" ? "Assign a bot" : "Add guests"}</div>
                  {bots.length > 0 ? (
                <>
                  <BotPicker bots={bots} selected={botIds} multiple={kind === "call"} locked={Boolean(lockedBotId)} onChange={setBotIds} />
                  <div className="mt-2 text-[11.5px] text-ink-secondary">{kind === "routine" ? "This bot owns each scheduled run." : `${selectedBots.length || "No"} bot${selectedBots.length === 1 ? "" : "s"} invited to the call.`}</div>
                </>
              ) : (
                <button type="button" onClick={() => { dispatch({ type: "newBot" }); onClose(); }} className="w-full rounded-xl border border-dashed border-accent/45 bg-accent/[0.06] px-4 py-4 text-left hover:bg-accent/10">
                  <div className="text-[12.5px] font-medium text-accent">Create your first bot</div>
                  <div className="mt-1 text-[11.5px] text-ink-secondary">A calendar event needs at least one bot.</div>
                </button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-start gap-4">
            <FileText size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} placeholder={isRoomGoal ? "What should the team accomplish?" : kind === "routine" ? "Add instructions for the bot" : "Add description or agenda"} className="min-w-0 flex-1 resize-y rounded-xl border border-hairline/50 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/55 focus:border-accent" />
          </div>

          <div className="flex items-start gap-4">
            <Paperclip size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            {isRoomGoal ? (
              <div className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-3.5 py-3">
                <div className="text-[12.5px] font-medium text-ink">Use the room’s shared context</div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">Team goals cannot carry routine attachments. Put shared context in the goal instructions or the room bulletin.</div>
              </div>
            ) : <div className="min-w-0 flex-1 space-y-2">
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => { void pickFiles(event.target.files); event.target.value = ""; }} />
              <button type="button" onClick={() => fileInput.current?.click()} className="rounded-lg border border-hairline/50 px-3 py-2 text-[12.5px] font-medium text-ink hover:bg-raised">Add attachment</button>
              <AttachmentChips attachments={attachments} onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))} />
              <div className="text-[11px] leading-relaxed text-ink-secondary">
                {kind === "routine"
                  ? "Attachments are passed to each local routine run and excluded from shared team files."
                  : selectedBots.length > 1
                    ? "References will be shared in the room when the event starts."
                    : "References stay with the event and are available when you join the room."}
              </div>
              {attachmentNotice && <div className="text-[11.5px] text-warning">{attachmentNotice}</div>}
            </div>}
          </div>

          {kind === "routine" && (
            <div className="flex items-start gap-4">
              {isRoomGoal ? <Target size={18} className="mt-2.5 shrink-0 text-ink-secondary" /> : runOn === "cloud" ? <Cloud size={18} className="mt-2.5 shrink-0 text-ink-secondary" /> : <Laptop size={18} className="mt-2.5 shrink-0 text-ink-secondary" />}
              <div className="min-w-0 flex-1">
                {isRoomGoal ? (
                  <div className="rounded-xl border border-accent/35 bg-accent/[0.07] p-3">
                    <div className="text-[12.5px] font-medium text-ink">Runs on this computer</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">OpenMausBot keeps the room and its member hand-offs together for the full goal.</div>
                  </div>
                ) : <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRunOn("maus")} className={cn("rounded-xl border p-3 text-left", runOn === "maus" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}><div className="text-[12.5px] font-medium text-ink">This computer</div><div className="mt-1 text-[11px] text-ink-secondary">Uses the bot’s current model and tools.</div></button>
                  <button type="button" disabled={!cloudReady || attachments.length > 0} onClick={() => setRunOn("cloud")} className={cn("rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}><div className="text-[12.5px] font-medium text-ink">Cloud VM</div><div className="mt-1 text-[11px] text-ink-secondary">Uses your connected cloud VM; OpenMausBot must stay running to launch it.</div></button>
                </div>}
              </div>
            </div>
          )}

          {error && <div className="ml-10 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12.5px] text-danger"><CircleAlert size={15} className="mt-0.5 shrink-0" />{error}</div>}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-hairline/40 bg-panel/95 px-5 py-3.5 backdrop-blur">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button>
          <button onClick={save} disabled={saving || attachmentPending || !valid} className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{(saving || attachmentPending) && <Loader2 size={14} className="animate-spin" />}{attachmentPending ? "Attaching…" : existingRoutine || existingCall ? "Save" : kind === "call" ? "Schedule call" : isRoomGoal ? "Schedule team goal" : "Schedule routine"}</button>
        </div>
      </div>
    </div>
  );
}

function QuickComposer({
  seed,
  bots,
  routinesOnly = false,
  onClose,
  onMore,
  onSavedRoutine,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  routinesOnly?: boolean;
  onClose: () => void;
  onMore: (seed: EventSeed) => void;
  onSavedRoutine: (routine: Routine) => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { dispatch } = useStore();
  const [kind, setKind] = useState<EventKind>(routinesOnly ? "routine" : seed.kind);
  const [name, setName] = useState(seed.name ?? "");
  const [description, setDescription] = useState(seed.description ?? "");
  const [botIds, setBotIds] = useState(seed.botIds.length ? seed.botIds : bots[0] ? [bots[0].id] : []);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogPosition, setDialogPosition] = useState<{ left: number; top: number } | null>(null);
  const durationMinutes = kind === "routine" ? 30 : seed.durationMinutes;

  useLayoutEffect(() => {
    if (!seed.anchor) {
      setDialogPosition(null);
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    const place = () => {
      const gap = 12;
      const rect = dialog.getBoundingClientRect();
      let left = seed.anchor!.x + gap;
      let top = seed.anchor!.y + gap;
      if (left + rect.width > window.innerWidth - gap) left = seed.anchor!.x - rect.width - gap;
      if (top + rect.height > window.innerHeight - gap) top = seed.anchor!.y - rect.height - gap;
      setDialogPosition({
        left: Math.max(gap, Math.min(left, window.innerWidth - rect.width - gap)),
        top: Math.max(gap, Math.min(top, window.innerHeight - rect.height - gap)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [kind, seed.anchor]);

  const save = async () => {
    setWorking(true);
    setError("");
    try {
      if (kind === "routine" || routinesOnly) {
        const response = await api("/api/routines", {
          method: "POST",
          body: JSON.stringify({
            name,
            prompt: description,
            botId: botIds[0],
            runOn: "maus",
            enabled: true,
            schedule: { type: "once", at: seed.at },
            durationMinutes,
            attachments: [],
          } satisfies RoutineInput),
        });
        onSavedRoutine(response.routine);
      } else {
        const response = await api("/api/calendar-calls", {
          method: "POST",
          body: JSON.stringify({
            name,
            description,
            botIds,
            schedule: { type: "once", at: seed.at },
            durationMinutes,
          } satisfies CalendarCallInput),
        });
        onSavedCall(response.call);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const valid = Boolean(name.trim() && botIds.length && (kind === "call" || description.trim()));
  return (
    <div ref={dialogRef} role="dialog" aria-label="Quick create" style={dialogPosition ?? undefined} className={cn("fixed z-50 max-h-[calc(100vh-24px)] w-[min(430px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl", !dialogPosition && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2")}>
      <div className="flex items-center justify-between bg-raised/70 px-4 py-2.5">
        <div className="text-[12px] font-medium text-ink-secondary">New calendar event</div>
        <button onClick={onClose} className="rounded-full p-1.5 text-ink-secondary hover:bg-inset hover:text-ink" aria-label="Close"><X size={16} /></button>
      </div>
      <div className="space-y-3 p-4">
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Add title" onKeyDown={(event) => { if (event.key === "Enter" && valid) void save(); }} className="w-full border-b border-hairline/60 bg-transparent pb-2 text-[18px] font-medium text-ink outline-none placeholder:text-ink-secondary/55 focus:border-accent" />
        {!routinesOnly && (
          <div className="flex items-center gap-1 border-b border-hairline/35 pb-2">
            <button type="button" onClick={() => { setKind("routine"); setBotIds((ids) => ids.slice(0, 1)); }} className={cn("rounded-lg px-3 py-1.5 text-[12px] font-medium", kind === "routine" ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>Routine</button>
            <button type="button" onClick={() => setKind("call")} className={cn("rounded-lg px-3 py-1.5 text-[12px] font-medium", kind === "call" ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>Call</button>
          </div>
        )}
        <div className="flex items-start gap-3 text-[12.5px] text-ink">
          <Clock3 size={16} className="mt-0.5 shrink-0 text-ink-secondary" />
          <div><div>{niceDate(seed.at)}</div><div className="mt-0.5 text-ink-secondary">{niceTime(seed.at)}{kind === "call" ? ` – ${niceTime(seed.at + durationMinutes * 60_000)}` : ""}</div></div>
        </div>
        <div className="flex items-start gap-3">
          <UserRoundPlus size={16} className="mt-2.5 shrink-0 text-ink-secondary" />
          {bots.length === 0 ? (
            <button type="button" onClick={() => { dispatch({ type: "newBot" }); onClose(); }} className="min-w-0 flex-1 rounded-xl border border-dashed border-accent/45 bg-accent/[0.06] px-3 py-3 text-left hover:bg-accent/10">
              <div className="text-[12px] font-medium text-accent">Create your first bot</div>
              <div className="mt-0.5 text-[10.5px] text-ink-secondary">Then come back to schedule it.</div>
            </button>
          ) : kind === "routine" ? (
            <select value={botIds[0] ?? ""} onChange={(event) => setBotIds([event.target.value])} className="min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent">
              <option value="">Assign a bot</option>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          ) : (
            <div className="min-w-0 flex-1"><BotPicker bots={bots} selected={botIds} multiple onChange={setBotIds} /></div>
          )}
        </div>
        <div className="flex items-start gap-3">
          <FileText size={16} className="mt-2.5 shrink-0 text-ink-secondary" />
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder={kind === "routine" ? "What should the bot do?" : "Add a description (optional)"} className="min-w-0 flex-1 resize-none rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/55 focus:border-accent" />
        </div>
        {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</div>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-hairline/40 px-4 py-3">
        <button onClick={() => onMore({ ...seed, kind, botIds, name, description, durationMinutes })} className="rounded-lg px-3 py-2 text-[12px] font-medium text-accent hover:bg-accent/10">More options</button>
        <button onClick={save} disabled={!valid || working} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{working && <Loader2 size={13} className="animate-spin" />}Save</button>
      </div>
    </div>
  );
}

function CalendarEventCard({
  item,
  bots,
  groups,
  compact,
  layout,
  onOpen,
  onResize,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  groups: Group[];
  compact: boolean;
  layout: { column: number; columns: number };
  onOpen: () => void;
  onResize: (minutes: number) => void;
}) {
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = item.kind === "routine" ? item.run : null;
  const isRoomGoal = !isCall && (run?.target ?? routine?.target) === "room-goal";
  const room = isRoomGoal
    ? groups.find((candidate) => candidate.id === (run?.groupId ?? routine?.groupId))
    : undefined;
  const ownerIds = isCall ? item.call.botIds : [run?.botId ?? routine?.botId ?? ""];
  const ownerBots = ownerIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = ownerBots[0];
  const name = isCall ? item.call.name : run?.routineName ?? routine?.name ?? "Routine";
  const color = isCall ? "#6d7cff" : primary ? MAUS_COLORS[primary.color] : "#666";
  const [previewDuration, setPreviewDuration] = useState(item.durationMinutes);
  useEffect(() => setPreviewDuration(item.durationMinutes), [item.durationMinutes]);
  const status = run?.status;
  const statusLabel = run?.goalStatus ? goalStatusLabel(run.goalStatus) : status?.replace("waiting", "needs you");
  const canMove = isCall || Boolean(routine && !run);
  const schedule = isCall ? item.call.schedule : routine?.schedule;
  const recurring = Boolean(schedule && schedule.type !== "once");
  const intervalCadence = schedule?.type === "interval" ? intervalLabel(schedule.everyMinutes) : null;

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

  return (
    <button
      data-event-card
      type="button"
      draggable={canMove}
      onDragStart={(event) => {
        if (!canMove) return event.preventDefault();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(EVENT_DRAG_TYPE, JSON.stringify({ kind: item.kind, id: isCall ? item.call.id : routine!.id, at: item.at }));
      }}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
      className={cn("group absolute z-10 overflow-hidden rounded-md border text-left shadow-sm transition hover:z-20 hover:brightness-110 focus:z-20 focus:outline-none focus:ring-2 focus:ring-accent", previewDuration < 30 ? "px-1.5 py-0" : "px-2 py-1.5", status === "cancelled" && "opacity-55", (status === "failed" || status === "missed") && "border-danger/60")}
      style={{
        left: `calc(${(layout.column / layout.columns) * 100}% + 2px)`,
        width: `calc(${100 / layout.columns}% - 4px)`,
        top: `${((new Date(item.at).getHours() * 60 + new Date(item.at).getMinutes()) / 60) * HOUR_HEIGHT}px`,
        height: `${Math.max(16, (previewDuration / 60) * HOUR_HEIGHT)}px`,
        background: `linear-gradient(110deg, color-mix(in srgb, ${color} 58%, #242424), color-mix(in srgb, ${color} 28%, #181818))`,
        borderColor: `color-mix(in srgb, ${color} 70%, transparent)`,
      }}
    >
      <div className="flex min-w-0 items-start gap-1.5 text-white">
        {previewDuration >= 30 && (isCall ? <Video size={compact ? 11 : 13} className="mt-0.5 shrink-0" /> : primary ? <BotAvatar bot={primary} state={status ? statusState(status) : "idle"} size={compact ? 22 : 26} animated={status === "running" || status === "waiting"} /> : null)}
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-[11px] font-semibold", previewDuration < 30 ? "leading-none" : "leading-tight")}>{name}</div>
          {previewDuration >= 30 && <div className="mt-0.5 truncate text-[9.5px] text-white/75">{niceTime(item.at)} · {intervalCadence ?? (isCall ? `${ownerBots.length} bot${ownerBots.length === 1 ? "" : "s"}` : isRoomGoal ? `Team goal · ${room?.name ?? "Room"}${statusLabel ? ` · ${statusLabel}` : ""}` : statusLabel ?? primary?.name)}</div>}
        </div>
        {previewDuration >= 30 && ownerBots.length > 1 && <span className="rounded bg-black/20 px-1 py-0.5 text-[8px]">+{ownerBots.length - 1}</span>}
      </div>
      {isCall && <div onPointerDown={beginResize} className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize rounded-full opacity-0 transition group-hover:opacity-100" aria-label="Resize event"><div className="mx-auto mt-0.5 h-0.5 w-5 rounded-full bg-white/55" /></div>}
    </button>
  );
}

function CalendarGrid({
  anchor,
  days,
  items,
  bots,
  groups,
  onOpen,
  onCreate,
  onMove,
  onResize,
}: {
  anchor: number;
  days: number;
  items: CalendarEventItem[];
  bots: Bot[];
  groups: Group[];
  onOpen: (item: CalendarEventItem) => void;
  onCreate: (seed: EventSeed) => void;
  onMove: (item: { kind: EventKind; id: string; at: number }, nextAt: number) => void;
  onResize: (item: CalendarEventItem, duration: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ day: number; start: number; end: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ day: number; at: number } | null>(null);
  const today = startOfDay(Date.now());
  const starts = Array.from({ length: days }, (_, index) => addDays(anchor, index));
  const minDayWidth = days === 7 ? 88 : days === 3 ? 180 : 340;
  const gridTemplateColumns = `64px repeat(${days}, minmax(${minDayWidth}px, 1fr))`;
  const minWidth = 64 + days * minDayWidth;

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const now = new Date();
    const hour = starts.includes(today) ? Math.max(0, now.getHours() - 2) : 7;
    viewport.scrollTo({ top: hour * HOUR_HEIGHT });
  }, [days]);

  const beginSelection = (event: ReactPointerEvent<HTMLDivElement>, day: number) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-event-card]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    let end = start + 30 * 60_000;
    setSelection({ day, start, end });
    const move = (pointer: PointerEvent) => {
      const current = slotAt(day, pointer.clientY, rect.top, HOUR_HEIGHT);
      end = Math.max(start + CALENDAR_SLOT_MINUTES * 60_000, current + CALENDAR_SLOT_MINUTES * 60_000);
      setSelection({ day, start, end });
    };
    const up = (pointer: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setSelection(null);
      onCreate({ kind: "routine", at: start, durationMinutes: Math.max(CALENDAR_SLOT_MINUTES, Math.round((end - start) / 60_000)), botIds: [], anchor: { x: pointer.clientX, y: pointer.clientY } });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  const drop = (event: ReactDragEvent<HTMLDivElement>, day: number) => {
    event.preventDefault();
    setDragPreview(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const at = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    const botId = event.dataTransfer.getData(BOT_DRAG_TYPE);
    if (botId) return onCreate({ kind: "routine", at, durationMinutes: 30, botIds: [botId], anchor: { x: event.clientX, y: event.clientY } });
    const raw = event.dataTransfer.getData(EVENT_DRAG_TYPE);
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: EventKind; id: string; at: number };
      onMove(item, at);
    } catch {
      // Ignore drags from another application.
    }
  };

  const previewDrop = (event: ReactDragEvent<HTMLDivElement>, day: number) => {
    if (!event.dataTransfer.types.includes(BOT_DRAG_TYPE) && !event.dataTransfer.types.includes(EVENT_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(EVENT_DRAG_TYPE) ? "move" : "copy";
    const rect = event.currentTarget.getBoundingClientRect();
    const at = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    setDragPreview((current) => current?.day === day && current.at === at ? current : { day, at });
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-l border-t border-hairline/40 bg-app">
      <div className="sticky top-0 z-30 grid bg-app/95 backdrop-blur" style={{ gridTemplateColumns, minWidth }}>
        <div className="border-b border-r border-hairline/40 px-2 py-3 text-center text-[9px] uppercase tracking-wider text-ink-secondary">{formatGmtOffset(-new Date(anchor).getTimezoneOffset())}</div>
        {starts.map((start) => {
          const date = new Date(start);
          const isToday = start === today;
          return <div key={start} role="columnheader" className={cn("border-b border-r border-hairline/40 px-2 py-2 text-center last:border-r-0", isToday && "bg-accent/[0.035]")}><div className={cn("text-[10px] font-medium uppercase tracking-[0.14em]", isToday ? "text-accent" : "text-ink-secondary")}>{DAY_NAMES[date.getDay()]}</div><div className={cn("mx-auto mt-1 flex size-8 items-center justify-center rounded-full text-[15px] font-medium", isToday ? "bg-accent text-white" : "text-ink")}>{date.getDate()}</div></div>;
        })}
      </div>
      <div role="grid" aria-label="Routine and call calendar" onDragEnd={() => setDragPreview(null)} className="relative grid" style={{ height: HOUR_HEIGHT * 24, gridTemplateColumns, minWidth }}>
        <div className="relative border-r border-hairline/40">
          {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="absolute right-2 -translate-y-1/2 text-[9.5px] tabular-nums text-ink-secondary/70" style={{ top: hour * HOUR_HEIGHT }}>{hour === 0 ? "" : new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</div>)}
        </div>
        {starts.map((start) => {
          const now = new Date();
          const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;
          const dayItems = items.filter((item) => startOfDay(item.at) === start);
          const collisionLayouts = packCalendarCollisions(dayItems);
          const selected = selection?.day === start ? selection : null;
          const preview = dragPreview?.day === start ? dragPreview : null;
          return (
            <div key={start} role="gridcell" aria-label={`${niceDate(start)} calendar`} onPointerDown={(event) => beginSelection(event, start)} onDragOver={(event) => previewDrop(event, start)} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragPreview(null); }} onDrop={(event) => drop(event, start)} className={cn("relative border-r border-hairline/40 last:border-r-0", start === today && "bg-accent/[0.025]")}>
              {Array.from({ length: 48 }, (_, half) => <div key={half} className={cn("pointer-events-none absolute inset-x-0 border-t", half % 2 === 0 ? "border-hairline/30" : "border-hairline/10")} style={{ top: (half / 2) * HOUR_HEIGHT }} />)}
              {start === today && <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop }}><span className="-ml-1 size-2 rounded-full bg-danger" /><span className="h-px flex-1 bg-danger/80" /></div>}
              {selected && <div className="pointer-events-none absolute inset-x-1 z-10 rounded-md border border-accent/70 bg-accent/20" style={{ top: ((new Date(selected.start).getHours() * 60 + new Date(selected.start).getMinutes()) / 60) * HOUR_HEIGHT, height: Math.max(16, ((selected.end - selected.start) / 3_600_000) * HOUR_HEIGHT) }} />}
              {preview && <div className="pointer-events-none absolute inset-x-1 z-20 rounded-md border border-accent/80 bg-accent/25 shadow-sm" style={{ top: ((new Date(preview.at).getHours() * 60 + new Date(preview.at).getMinutes()) / 60) * HOUR_HEIGHT, height: HOUR_HEIGHT / 2 }}><div className="px-2 py-1 text-[9.5px] font-medium text-accent">{niceTime(preview.at)}</div></div>}
              {dayItems.map((item) => <CalendarEventCard key={item.id} item={item} bots={bots} groups={groups} compact={days === 7} layout={collisionLayouts.get(item.id) ?? { column: 0, columns: 1 }} onOpen={() => onOpen(item)} onResize={(minutes) => onResize(item, minutes)} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventDetails({
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
  const [error, setError] = useState("");
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = item.kind === "routine" ? item.run : null;
  const call = item.kind === "call" ? item.call : null;
  const isRoomGoal = !isCall && (run?.target ?? routine?.target) === "room-goal";
  const goalGroupId = isRoomGoal ? run?.groupId ?? routine?.groupId : undefined;
  const goalGroup = state.groups.find((group) => group.id === goalGroupId);
  const executionThreadId = run?.executionThreadId ?? run?.threadId;
  const botIds = call?.botIds ?? [run?.botId ?? routine?.botId ?? ""];
  const invited = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = invited[0];
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

  const invoke = async (path: string, method = "POST") => {
    setWorking(true);
    setError("");
    try {
      const response = await api(path, { method });
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
    setWorking(true);
    setError("");
    // The store flushes pending model and approval-level changes before it
    // starts the run. Keep this button pending through that barrier and the
    // POST so a double-click cannot create two routine runs.
    dispatch({
      type: "runRoutine",
      routineId: routine.id,
      onSettled: () => {
        runNowPending.current = false;
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
    if (!window.confirm(`Delete “${title}”?`)) return;
    if (call) {
      await api(`/api/calendar-calls/${call.id}`, { method: "DELETE" });
      onCallChanged(call.id);
    } else if (routine) {
      dispatch({ type: "deleteRoutine", routineId: routine.id });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-[2px]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Calendar event details" className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-start gap-4 border-b border-hairline/40 px-5 py-4">
          <span className={cn("mt-1 size-4 shrink-0 rounded", isCall ? "bg-[#6d7cff]" : "bg-accent")} />
          <div className="min-w-0 flex-1">
            <div className="text-[19px] font-semibold text-ink">{title}</div>
            <div className="mt-1 text-[12.5px] text-ink-secondary">
              {niceDate(item.at)} · {niceTime(item.at)}{isCall ? ` – ${niceTime(item.at + item.durationMinutes * 60_000)}` : ""}
            </div>
            {(routine || call) && <div className="mt-1 text-[11.5px] text-ink-secondary">{scheduleLabel((routine ?? call)!.schedule)}</div>}
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Close"><X size={17} /></button>
        </div>

        <div className="max-h-[58vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-start gap-3">
            {isRoomGoal ? <Target size={17} className="mt-1 shrink-0 text-ink-secondary" /> : <UserRoundPlus size={17} className="mt-1 shrink-0 text-ink-secondary" />}
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{isCall ? "Bots invited" : isRoomGoal ? "Lead coordinator" : "Assigned bot"}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {invited.map((bot) => <div key={bot.id} className="flex items-center gap-2 rounded-full border border-hairline/50 bg-inset py-1 pl-1 pr-2.5"><BotAvatar bot={bot} state="idle" size={26} animated={false} /><span className="text-[11.5px] text-ink">{bot.name}</span></div>)}
              </div>
            </div>
          </div>
          {isRoomGoal && (
            <div className="flex items-start gap-3">
              <UsersRound size={17} className="mt-1 shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Team goal room</div>
                <div className="mt-1 text-[12.5px] text-ink">{goalGroup?.name ?? "Room unavailable"}</div>
              </div>
            </div>
          )}
          {description && <div className="flex items-start gap-3"><FileText size={17} className="mt-1 shrink-0 text-ink-secondary" /><div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{description}</div></div>}
          {attachments.length > 0 && <div className="flex items-start gap-3"><Paperclip size={17} className="mt-1 shrink-0 text-ink-secondary" /><div className="min-w-0 flex-1 space-y-2"><AttachmentChips attachments={attachments} />{call && <div className="text-[11px] leading-relaxed text-ink-secondary">{call.botIds.length > 1 ? "These references will be shared in the room when the event starts." : "These references stay with the event and are available when you join the room."}</div>}</div></div>}
          {!isCall && <div className="flex items-start gap-3"><Clock3 size={17} className="mt-1 shrink-0 text-ink-secondary" /><div><div className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Run limit</div><div className="mt-1 text-[12.5px] text-ink">{safetyLimit == null ? "No time limit" : `Stops if still running after ${durationLabel(safetyLimit)}`}</div></div></div>}
          {run && <div className="rounded-xl border border-hairline/40 bg-inset p-3"><div className="flex items-center gap-2 text-[12px] font-medium capitalize text-ink">{run.status === "running" && <Loader2 size={13} className="animate-spin text-accent" />}{run.goalStatus ? goalStatusLabel(run.goalStatus) : run.status.replace("waiting", "needs you")}</div>{run.output && <div className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-secondary">{run.output}</div>}{run.error && <div className="mt-2 text-[11.5px] text-danger">{run.error}</div>}</div>}
          {run?.attention && <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-warning"><CircleAlert size={15} className="mt-0.5 shrink-0" /><div className="min-w-0"><div className="text-[11.5px] font-semibold">Needs your attention</div><div className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed">{run.attention}</div></div></div>}
          {run?.status === "waiting" && !run.attention && <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-[11.5px] text-warning">{isRoomGoal ? "This team goal needs your answer. Open its room task to continue the run." : "This bot needs your answer. Open its task to continue the run."}</div>}
          {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</div>}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-hairline/40 px-4 py-3">
          {roomId && <button onClick={() => onOpenRoom(roomId)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110"><ExternalLink size={13} />Join room</button>}
          {call && call.botIds.length > 1 && <button onClick={joinRoom} disabled={working} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"><ExternalLink size={13} />Join room</button>}
          {isRoomGoal && goalGroup && !executionThreadId && <button onClick={() => { onOpenRoom(goalGroup.id); onClose(); }} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110"><ExternalLink size={13} />Open room</button>}
          {routine && <button onClick={runRoutineNow} disabled={working} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"><Play size={13} />Run now</button>}
          {executionThreadId && (isRoomGoal ? goalGroup : primary) && <button onClick={openRunTask} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><ExternalLink size={13} />{isRoomGoal ? "Open room task" : "Open task"}</button>}
          {run && ["queued", "running", "waiting"].includes(run.status) && <button onClick={() => void invoke(`/api/routine-runs/${run.id}/cancel`)} disabled={working} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"><X size={13} />Cancel run</button>}
          {routine && <button onClick={() => void invoke(`/api/routines/${routine.id}`, "PATCH")} className="hidden" aria-hidden />}
          <div className="ml-auto flex items-center gap-1">
            {(routine || call) && <button onClick={onEdit} className="rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">Edit</button>}
            {routine && <button onClick={async () => { const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !routine.enabled }) }); dispatch({ type: "routinePatched", routine: response.routine }); }} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" title={routine.enabled ? "Pause routine" : "Resume routine"}>{routine.enabled ? <Pause size={15} /> : <Play size={15} />}</button>}
            {(routine || call) && <button onClick={() => void deleteEvent()} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger" title="Delete"><Trash2 size={15} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function PausedList({
  routines,
  bots,
  groups,
  onClose,
  onEdit,
  onOpenRoom,
}: {
  routines: Routine[];
  bots: Bot[];
  groups: Group[];
  onClose: () => void;
  onEdit: (routine: Routine) => void;
  onOpenRoom: (id: string) => void;
}) {
  const { dispatch } = useStore();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Paused routines" className="w-full max-w-[520px] rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4"><div><div className="text-[16px] font-semibold text-ink">Paused routines</div><div className="mt-0.5 text-[11.5px] text-ink-secondary">History is kept; no new tasks will run.</div></div><button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised"><X size={17} /></button></div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto p-3">
          {routines.map((routine) => {
            const bot = bots.find((candidate) => candidate.id === routine.botId);
            const room = routine.target === "room-goal"
              ? groups.find((candidate) => candidate.id === routine.groupId)
              : undefined;
            return (
              <div key={routine.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-raised/60">
                {room ? <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent"><UsersRound size={17} /></span> : bot && <BotAvatar bot={bot} state="sleeping" size={36} animated={false} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-ink">{routine.name}</div>
                  <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">{room ? `Team goal · ${room.name} · ` : ""}{scheduleLabel(routine.schedule)}</div>
                </div>
                {room && <button onClick={() => { onOpenRoom(room.id); onClose(); }} className="rounded-lg px-2 py-1.5 text-[11px] text-ink-secondary hover:bg-inset">Room</button>}
                <button onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: true } })} className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-[11px] font-medium text-accent">Resume</button>
                <button onClick={() => onEdit(routine)} className="rounded-lg px-2 py-1.5 text-[11px] text-ink-secondary hover:bg-inset">Edit</button>
              </div>
            );
          })}
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
  const at = routine?.schedule.type === "once"
    ? routine.schedule.at
    : routine?.schedule.type === "daily"
      ? atLocalTime(Date.now(), routine.schedule.time)
      : routine?.schedule.type === "interval"
        ? routine.schedule.anchorAt
      : nextHour();
  return <EventEditor seed={{ kind: "routine", at, durationMinutes: routine?.durationMinutes ?? 30, botIds: lockedBotId ? [lockedBotId] : routine ? [routine.botId] : [], routine }} bots={bots} lockedBotId={lockedBotId} defaultRunOn={defaultRunOn} onClose={onClose} onSavedCall={() => {}} />;
}

export function RoutinesPage({ onBack, onOpenRoom }: { onBack: () => void; onOpenRoom: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const routinesOnly = window.ogb?.remoteClient?.active === true;
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const newMenuRef = useRef<HTMLDetailsElement>(null);
  const [section, setSection] = useState<"calendar" | "webhooks">("calendar");
  const [viewDays, setViewDays] = useState<1 | 3 | 7>(7);
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [botFilter, setBotFilter] = useState("all");
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
      if (event.key === "Escape") { newMenuRef.current?.removeAttribute("open"); setQuick(null); setEditor(null); setSelected(null); return; }
      if (section !== "calendar" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "c") { event.preventDefault(); openCreate(); }
      if (event.key.toLowerCase() === "t") goToday();
      if (event.key === "1") setView(1);
      if (event.key === "3") setView(3);
      if (event.key.toLowerCase() === "w") setView(7);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, openCreate, goToday, anchor]);

  const upsertCall = (call: CalendarCall) => setCalls((current) => current.some((candidate) => candidate.id === call.id) ? current.map((candidate) => candidate.id === call.id ? call : candidate) : [call, ...current]);
  const moveEvent = async (dragged: { kind: EventKind; id: string; at: number }, nextAt: number) => {
    if (nextAt === dragged.at) return;
    try {
      if (dragged.kind === "routine") {
        const routine = state.routines.find((candidate) => candidate.id === dragged.id);
        if (!routine) return;
        if (routine.schedule.type !== "once" && !window.confirm("Move this entire recurring series?")) return;
        const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(routine.schedule, dragged.at, nextAt) }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        const call = calls.find((candidate) => candidate.id === dragged.id);
        if (!call) return;
        if (call.schedule.type === "daily" && !window.confirm("Move this entire recurring series?")) return;
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
            aria-label="Back"
            title="Back"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
            style={windowNoDragStyle}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="mr-2 flex items-center gap-2"><CalendarDays size={21} className="text-accent" /><h1 className="text-[18px] font-semibold tracking-tight text-ink">Automations</h1></div>
          <div className="flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5" style={windowNoDragStyle} aria-label="Automation type">
            <button type="button" aria-pressed={section === "calendar"} onClick={() => setSection("calendar")} className={cn("rounded-md px-3 py-1.5 text-[11.5px] font-medium", section === "calendar" ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>{routinesOnly ? "Scheduled routines" : "Schedule"}</button>
            {!routinesOnly && <button type="button" aria-pressed={section === "webhooks"} onClick={() => setSection("webhooks")} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-medium", section === "webhooks" ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}><Webhook size={12} />Webhooks{state.webhooks.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[9px] text-accent">{state.webhooks.length}</span>}</button>}
          </div>
          <details ref={newMenuRef} className="group relative ml-auto" style={windowNoDragStyle}>
            <summary aria-label="Create an automation" className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12px] font-semibold text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              <Plus size={15} aria-hidden="true" />New
            </summary>
            <div role="group" aria-label="New automation" className="absolute right-0 top-full z-40 mt-1.5 w-[280px] rounded-xl border border-hairline/60 bg-card p-1.5 shadow-2xl">
              <button type="button" aria-label="Create a scheduled task" onClick={() => { newMenuRef.current?.removeAttribute("open"); setSection("calendar"); openCreate({ kind: "routine" }); }} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised">
                <Clock3 size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span><span className="block text-[12.5px] font-medium text-ink">Scheduled task</span><span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-secondary">Ask a bot to do something later.</span></span>
              </button>
              {!routinesOnly && <button type="button" aria-label="Create a scheduled call" onClick={() => { newMenuRef.current?.removeAttribute("open"); setSection("calendar"); openCreate({ kind: "call" }); }} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised">
                <Video size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span><span className="block text-[12.5px] font-medium text-ink">Scheduled call</span><span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-secondary">Bring bots together at a set time.</span></span>
              </button>}
              {!routinesOnly && <button type="button" aria-label="Create a webhook" disabled={visibleBots.length === 0} onClick={() => { newMenuRef.current?.removeAttribute("open"); setSection("webhooks"); setWebhookCreateRequest((request) => request + 1); }} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40">
                <Webhook size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span><span className="block text-[12.5px] font-medium text-ink">Webhook</span><span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-secondary">Start a task when another app sends an event.</span></span>
              </button>}
            </div>
          </details>
        </div>
        {section === "calendar" && <div className="mt-2 flex flex-wrap items-center gap-2" style={windowNoDragStyle}>
          <div className="flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5">
            <button onClick={() => setAnchor((current) => addDays(current, -viewDays))} className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Previous dates"><ChevronLeft size={16} /></button>
            <button onClick={goToday} className="rounded-md px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised">Today</button>
            <button onClick={() => setAnchor((current) => addDays(current, viewDays))} className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Next dates"><ChevronRight size={16} /></button>
          </div>
          <div className="min-w-[220px] px-2 text-[15px] font-medium text-ink">{calendarRangeLabel(rangeStart, viewDays)}</div>
          <div className="ml-auto flex items-center gap-2">
            {running > 0 && <span className="hidden items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1.5 text-[10.5px] text-accent sm:flex"><Loader2 size={11} className="animate-spin" />{running} active</span>}
            {unseenFailures > 0 && <span className="hidden items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1.5 text-[10.5px] text-danger sm:flex"><CircleAlert size={11} />{unseenFailures}</span>}
            {paused.length > 0 && <button onClick={() => setPausedOpen(true)} className="hidden items-center gap-1.5 rounded-full border border-hairline/50 px-2.5 py-1.5 text-[10.5px] text-ink-secondary hover:bg-raised sm:flex"><Pause size={11} />{paused.length}</button>}
            <select aria-label="Filter schedule by bot" value={botFilter} onChange={(event) => setBotFilter(event.target.value)} className="hidden rounded-lg border border-hairline/50 bg-panel px-2.5 py-2 text-[11.5px] text-ink outline-none focus:border-accent sm:block"><option value="all">All bots</option>{visibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
            <select aria-label="Schedule range" value={viewDays} onChange={(event) => setView(Number(event.target.value) as 1 | 3 | 7)} className="rounded-lg border border-hairline/50 bg-panel px-2.5 py-2 text-[11.5px] text-ink outline-none focus:border-accent"><option value={1}>Day</option><option value={3}>3 days</option><option value={7}>Week</option></select>
          </div>
          {error && <button onClick={() => setError("")} className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[10.5px] text-danger"><CircleAlert size={11} />{error}<X size={11} /></button>}
        </div>}
      </header>

      {section === "webhooks" ? <WebhooksPanel bots={visibleBots} createRequest={webhookCreateRequest} onCreateHandled={handleWebhookCreateHandled} /> : (
        <div className="flex min-h-0 flex-1">
          <div className="hidden shrink-0 lg:block"><CalendarSidebar bots={visibleBots} anchor={anchor} onSelectDate={(at) => setAnchor(startOfDay(at))} /></div>
          <CalendarGrid anchor={rangeStart} days={viewDays} items={items} bots={state.bots} groups={state.groups} onOpen={(item) => { setSelected(item); if (item.kind === "routine" && item.run && ["failed", "missed"].includes(item.run.status) && !item.run.seenAt) dispatch({ type: "markRoutineRunSeen", runId: item.run.id }); }} onCreate={openCreate} onMove={(item, at) => void moveEvent(item, at)} onResize={(item, duration) => void resizeEvent(item, duration)} />
        </div>
      )}

      {quick && <><div className="fixed inset-0 z-40 bg-black/25" onMouseDown={() => setQuick(null)} /><QuickComposer seed={quick} bots={visibleBots} routinesOnly={routinesOnly} onClose={() => setQuick(null)} onMore={(seed) => { setQuick(null); setEditor(seed); }} onSavedRoutine={(routine) => dispatch({ type: "routinePatched", routine })} onSavedCall={upsertCall} /></>}
      {editor && <EventEditor seed={editor} bots={visibleBots} routinesOnly={routinesOnly} onClose={() => setEditor(null)} onSavedCall={upsertCall} />}
      {liveSelected && <EventDetails item={liveSelected} bots={state.bots} onClose={() => setSelected(null)} onEdit={() => { const seed: EventSeed = liveSelected.kind === "call" ? { kind: "call", at: liveSelected.at, durationMinutes: liveSelected.call.durationMinutes, botIds: liveSelected.call.botIds, call: liveSelected.call } : { kind: "routine", at: liveSelected.at, durationMinutes: liveSelected.routine?.durationMinutes ?? liveSelected.run?.durationMinutes ?? 30, botIds: [liveSelected.routine?.botId ?? liveSelected.run?.botId ?? ""].filter(Boolean), routine: liveSelected.routine ?? undefined }; setSelected(null); setEditor(seed); }} onCallChanged={(id) => { if (id) setCalls((current) => current.filter((call) => call.id !== id)); else void loadCalls(); }} onOpenRoom={onOpenRoom} />}
      {pausedOpen && <PausedList routines={paused} bots={state.bots} groups={state.groups} onClose={() => setPausedOpen(false)} onEdit={(routine) => { setPausedOpen(false); const at = routine.schedule.type === "once" ? routine.schedule.at : routine.schedule.type === "interval" ? routine.schedule.anchorAt : atLocalTime(Date.now(), routine.schedule.time); setEditor({ kind: "routine", at, durationMinutes: routine.durationMinutes, botIds: [routine.botId], routine }); }} onOpenRoom={onOpenRoom} />}
    </main>
  );
}
