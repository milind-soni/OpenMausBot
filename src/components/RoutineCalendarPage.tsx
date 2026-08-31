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
  Trash2,
  UserRoundPlus,
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
import type {
  Routine,
  RoutineContextAttachment,
  RoutineInput,
  RoutineRunOn,
  RoutineRunStatus,
  RoutineSchedule,
} from "@/lib/routines";
import { api, useStore, type Bot } from "@/state/store";

const HOUR_HEIGHT = 64;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const BOT_DRAG_TYPE = "application/x-openmaus-bot";
const EVENT_DRAG_TYPE = "application/x-openmaus-calendar-event";

type EventKind = "routine" | "call";
type RecurrenceChoice = "none" | "daily" | "weekdays" | "weekly" | "custom";

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

function nextHour(): number {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function niceTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function niceDate(at: number): string {
  return new Date(at).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function scheduleLabel(schedule: RoutineSchedule | CalendarCall["schedule"]): string {
  if (schedule.type === "once") return `${niceDate(schedule.at)}, ${niceTime(schedule.at)}`;
  const days = schedule.weekdays;
  const label = days.length === 7
    ? "Every day"
    : days.join(",") === "1,2,3,4,5"
      ? "Every weekday"
      : days.length === 1
        ? `Weekly on ${DAY_NAMES[days[0]!]}`
        : days.map((day) => DAY_NAMES[day]).join(", ");
  return `${label} at ${niceTime(atLocalTime(Date.now(), schedule.time))}`;
}

function recurrenceFor(schedule: RoutineSchedule | CalendarCall["schedule"], at: number): RecurrenceChoice {
  if (schedule.type === "once") return "none";
  if (schedule.weekdays.length === 7) return "daily";
  if (schedule.weekdays.join(",") === "1,2,3,4,5") return "weekdays";
  if (schedule.weekdays.length === 1 && schedule.weekdays[0] === new Date(at).getDay()) return "weekly";
  return "custom";
}

function makeSchedule(choice: RecurrenceChoice, at: number, weekdays: number[]): RoutineSchedule {
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
  onClose,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  onClose: () => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { state, dispatch } = useStore();
  const existingRoutine = seed.routine;
  const existingCall = seed.call;
  const [kind, setKind] = useState<EventKind>(seed.kind);
  const [name, setName] = useState(existingRoutine?.name ?? existingCall?.name ?? seed.name ?? "");
  const [description, setDescription] = useState(existingRoutine?.prompt ?? existingCall?.description ?? seed.description ?? "");
  const initialAt = existingRoutine?.schedule.type === "once"
    ? existingRoutine.schedule.at
    : existingRoutine?.schedule.type === "daily"
      ? atLocalTime(seed.at, existingRoutine.schedule.time)
      : existingCall?.schedule.type === "once"
        ? existingCall.schedule.at
        : existingCall?.schedule.type === "daily"
          ? atLocalTime(seed.at, existingCall.schedule.time)
          : seed.at;
  const schedule = existingRoutine?.schedule ?? existingCall?.schedule ?? { type: "once" as const, at: initialAt };
  const [date, setDate] = useState(toLocalDateInput(initialAt));
  const [startTime, setStartTime] = useState(toLocalTimeInput(initialAt));
  const [durationMinutes, setDurationMinutes] = useState(existingRoutine?.durationMinutes ?? existingCall?.durationMinutes ?? seed.durationMinutes);
  const [recurrence, setRecurrence] = useState<RecurrenceChoice>(recurrenceFor(schedule, initialAt));
  const [weekdays, setWeekdays] = useState(schedule.type === "daily" ? schedule.weekdays : [new Date(initialAt).getDay()]);
  const [botIds, setBotIds] = useState(lockedBotId ? [lockedBotId] : existingRoutine ? [existingRoutine.botId] : existingCall?.botIds ?? seed.botIds);
  const [runOn, setRunOn] = useState<RoutineRunOn>(existingRoutine?.runOn ?? defaultRunOn ?? "maus");
  const [attachments, setAttachments] = useState<Array<RoutineContextAttachment | CalendarCallAttachment>>(existingRoutine?.attachments ?? existingCall?.attachments ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const cloudInstance = state.instances.find((instance) => instance.driverKind === "boxAgent");
  const cloudReady = Boolean(state.config?.box.configured && cloudInstance?.snapshot.state === "available");
  const at = fromLocalDateAndTime(date, startTime);
  const endAt = at + durationMinutes * 60_000;
  const selectedBots = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
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
  };

  const save = async () => {
    const nextSchedule = makeSchedule(recurrence, at, weekdays);
    setSaving(true);
    setError("");
    try {
      if (kind === "routine") {
        const input: RoutineInput = {
          name,
          prompt: description,
          botId: botIds[0] ?? "",
          runOn,
          enabled: existingRoutine ? undefined : true,
          schedule: nextSchedule,
          durationMinutes,
          attachments: attachments as RoutineContextAttachment[],
        };
        const response = await api(existingRoutine ? `/api/routines/${existingRoutine.id}` : "/api/routines", {
          method: existingRoutine ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
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

  const valid = name.trim() && botIds.length > 0 && (kind === "call" || description.trim());
  const canSwitchKind = !existingRoutine && !existingCall && !lockedBotId;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={existingRoutine || existingCall ? "Edit calendar event" : "Create calendar event"} className="max-h-[94vh] w-full max-w-[760px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-hairline/40 bg-panel/95 px-5 py-3.5 backdrop-blur">
          <div className="text-[15px] font-semibold text-ink">{existingRoutine || existingCall ? "Edit event" : "New event"}</div>
          <button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-8">
          {canSwitchKind && (
            <div className="ml-10 inline-flex rounded-lg bg-inset p-1">
              <button type="button" onClick={() => { setKind("routine"); setBotIds((ids) => ids.slice(0, 1)); }} className={cn("rounded-md px-4 py-1.5 text-[12.5px] font-medium", kind === "routine" ? "bg-raised text-ink shadow" : "text-ink-secondary")}>Routine</button>
              <button type="button" onClick={() => setKind("call")} className={cn("rounded-md px-4 py-1.5 text-[12.5px] font-medium", kind === "call" ? "bg-raised text-ink shadow" : "text-ink-secondary")}>Call</button>
            </div>
          )}

          <div className="flex items-start gap-4">
            <span className="mt-3 size-4 shrink-0 rounded bg-accent" />
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "routine" ? "Add title" : "Add call title"} className="min-w-0 flex-1 border-b border-hairline/60 bg-transparent px-1 pb-2 text-[22px] font-medium text-ink outline-none placeholder:text-ink-secondary/55 focus:border-accent" />
          </div>

          <div className="flex items-start gap-4">
            <Clock3 size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />
                <input type="time" step={900} value={startTime} onChange={(event) => setStartTime(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />
                <span className="text-[12px] text-ink-secondary">to</span>
                <span className="rounded-lg border border-hairline/40 bg-inset/60 px-3 py-2 text-[13px] text-ink">{niceTime(endAt)}</span>
                <select value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12px] text-ink outline-none focus:border-accent">
                  {[15, 30, 45, 60, 90, 120, 180, 240].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} min` : `${minutes / 60} hr`}</option>)}
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Repeat2 size={14} className="text-ink-secondary" />
                <select value={recurrence} onChange={(event) => setRecurrence(event.target.value as RecurrenceChoice)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent">
                  <option value="none">Does not repeat</option>
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
            </div>
          </div>

          <div className="flex items-start gap-4">
            <UserRoundPlus size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1">
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
            </div>
          </div>

          <div className="flex items-start gap-4">
            <FileText size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} placeholder={kind === "routine" ? "Add instructions for the bot" : "Add description or agenda"} className="min-w-0 flex-1 resize-y rounded-xl border border-hairline/50 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/55 focus:border-accent" />
          </div>

          <div className="flex items-start gap-4">
            <Paperclip size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1 space-y-2">
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
            </div>
          </div>

          {kind === "routine" && (
            <div className="flex items-start gap-4">
              {runOn === "cloud" ? <Cloud size={18} className="mt-2.5 shrink-0 text-ink-secondary" /> : <Laptop size={18} className="mt-2.5 shrink-0 text-ink-secondary" />}
              <div className="min-w-0 flex-1">
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRunOn("maus")} className={cn("rounded-xl border p-3 text-left", runOn === "maus" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}><div className="text-[12.5px] font-medium text-ink">This computer</div><div className="mt-1 text-[11px] text-ink-secondary">Uses the bot’s current model and tools.</div></button>
                  <button type="button" disabled={!cloudReady || attachments.length > 0} onClick={() => setRunOn("cloud")} className={cn("rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}><div className="text-[12.5px] font-medium text-ink">Cloud VM</div><div className="mt-1 text-[11px] text-ink-secondary">Uses your connected cloud VM; OpenMausBot must stay running to launch it.</div></button>
                </div>
              </div>
            </div>
          )}

          {error && <div className="ml-10 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12.5px] text-danger"><CircleAlert size={15} className="mt-0.5 shrink-0" />{error}</div>}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-hairline/40 bg-panel/95 px-5 py-3.5 backdrop-blur">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button>
          <button onClick={save} disabled={saving || !valid} className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{saving && <Loader2 size={14} className="animate-spin" />}{existingRoutine || existingCall ? "Save" : kind === "call" ? "Schedule call" : "Schedule routine"}</button>
        </div>
      </div>
    </div>
  );
}

function QuickComposer({
  seed,
  bots,
  onClose,
  onMore,
  onSavedRoutine,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  onClose: () => void;
  onMore: (seed: EventSeed) => void;
  onSavedRoutine: (routine: Routine) => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { dispatch } = useStore();
  const [kind, setKind] = useState<EventKind>(seed.kind);
  const [name, setName] = useState(seed.name ?? "");
  const [description, setDescription] = useState(seed.description ?? "");
  const [botIds, setBotIds] = useState(seed.botIds.length ? seed.botIds : bots[0] ? [bots[0].id] : []);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogPosition, setDialogPosition] = useState<{ left: number; top: number } | null>(null);

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
      if (kind === "routine") {
        const response = await api("/api/routines", {
          method: "POST",
          body: JSON.stringify({
            name,
            prompt: description,
            botId: botIds[0],
            runOn: "maus",
            enabled: true,
            schedule: { type: "once", at: seed.at },
            durationMinutes: seed.durationMinutes,
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
            durationMinutes: seed.durationMinutes,
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
        <div className="flex items-center gap-1 border-b border-hairline/35 pb-2">
          <button type="button" onClick={() => { setKind("routine"); setBotIds((ids) => ids.slice(0, 1)); }} className={cn("rounded-lg px-3 py-1.5 text-[12px] font-medium", kind === "routine" ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>Routine</button>
          <button type="button" onClick={() => setKind("call")} className={cn("rounded-lg px-3 py-1.5 text-[12px] font-medium", kind === "call" ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>Call</button>
        </div>
        <div className="flex items-start gap-3 text-[12.5px] text-ink">
          <Clock3 size={16} className="mt-0.5 shrink-0 text-ink-secondary" />
          <div><div>{niceDate(seed.at)}</div><div className="mt-0.5 text-ink-secondary">{niceTime(seed.at)} – {niceTime(seed.at + seed.durationMinutes * 60_000)}</div></div>
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
        <button onClick={() => onMore({ ...seed, kind, botIds, name, description })} className="rounded-lg px-3 py-2 text-[12px] font-medium text-accent hover:bg-accent/10">More options</button>
        <button onClick={save} disabled={!valid || working} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{working && <Loader2 size={13} className="animate-spin" />}Save</button>
      </div>
    </div>
  );
}

function CalendarEventCard({
  item,
  bots,
  compact,
  layout,
  onOpen,
  onResize,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  compact: boolean;
  layout: { column: number; columns: number };
  onOpen: () => void;
  onResize: (minutes: number) => void;
}) {
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = item.kind === "routine" ? item.run : null;
  const ownerIds = isCall ? item.call.botIds : [routine?.botId ?? run?.botId ?? ""];
  const ownerBots = ownerIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = ownerBots[0];
  const name = isCall ? item.call.name : routine?.name ?? run?.routineName ?? "Routine";
  const color = isCall ? "#6d7cff" : primary ? MAUS_COLORS[primary.color] : "#666";
  const [previewDuration, setPreviewDuration] = useState(item.durationMinutes);
  useEffect(() => setPreviewDuration(item.durationMinutes), [item.durationMinutes]);
  const status = run?.status;
  const canMove = isCall || Boolean(routine && !run);
  const recurring = (isCall ? item.call.schedule : routine?.schedule)?.type === "daily";

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startDuration = previewDuration;
    let next = startDuration;
    const move = (pointer: PointerEvent) => {
      next = Math.max(15, Math.min(240, Math.round((startDuration + ((pointer.clientY - startY) / HOUR_HEIGHT) * 60) / 15) * 15));
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
          {previewDuration >= 30 && <div className="mt-0.5 truncate text-[9.5px] text-white/75">{niceTime(item.at)} · {isCall ? `${ownerBots.length} bot${ownerBots.length === 1 ? "" : "s"}` : status?.replace("waiting", "needs you") ?? primary?.name}</div>}
        </div>
        {previewDuration >= 30 && ownerBots.length > 1 && <span className="rounded bg-black/20 px-1 py-0.5 text-[8px]">+{ownerBots.length - 1}</span>}
      </div>
      {canMove && <div onPointerDown={beginResize} className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize rounded-full opacity-0 transition group-hover:opacity-100" aria-label="Resize event"><div className="mx-auto mt-0.5 h-0.5 w-5 rounded-full bg-white/55" /></div>}
    </button>
  );
}

function CalendarGrid({
  anchor,
  days,
  items,
  bots,
  onOpen,
  onCreate,
  onMove,
  onResize,
}: {
  anchor: number;
  days: number;
  items: CalendarEventItem[];
  bots: Bot[];
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
      end = Math.max(start + 15 * 60_000, current + 15 * 60_000);
      setSelection({ day, start, end });
    };
    const up = (pointer: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setSelection(null);
      onCreate({ kind: "routine", at: start, durationMinutes: Math.max(15, Math.round((end - start) / 60_000)), botIds: [], anchor: { x: pointer.clientX, y: pointer.clientY } });
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
              {dayItems.map((item) => <CalendarEventCard key={item.id} item={item} bots={bots} compact={days === 7} layout={collisionLayouts.get(item.id) ?? { column: 0, columns: 1 }} onOpen={() => onOpen(item)} onResize={(minutes) => onResize(item, minutes)} />)}
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
  const { dispatch } = useStore();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = item.kind === "routine" ? item.run : null;
  const call = item.kind === "call" ? item.call : null;
  const botIds = call?.botIds ?? [routine?.botId ?? run?.botId ?? ""];
  const invited = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = invited[0];
  const title = call?.name ?? routine?.name ?? run?.routineName ?? "Routine";
  const description = call?.description ?? routine?.prompt ?? run?.prompt ?? "";
  const attachments = call?.attachments ?? routine?.attachments ?? run?.attachments ?? [];
  const roomId = call?.botIds.length === 1 ? primary?.id : undefined;

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
            <div className="mt-1 text-[12.5px] text-ink-secondary">{niceDate(item.at)} · {niceTime(item.at)} – {niceTime(item.at + item.durationMinutes * 60_000)}</div>
            {(routine || call) && <div className="mt-1 text-[11.5px] text-ink-secondary">{scheduleLabel((routine ?? call)!.schedule)}</div>}
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Close"><X size={17} /></button>
        </div>

        <div className="max-h-[58vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-start gap-3">
            <UserRoundPlus size={17} className="mt-1 shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{isCall ? "Bots invited" : "Assigned bot"}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {invited.map((bot) => <div key={bot.id} className="flex items-center gap-2 rounded-full border border-hairline/50 bg-inset py-1 pl-1 pr-2.5"><BotAvatar bot={bot} state="idle" size={26} animated={false} /><span className="text-[11.5px] text-ink">{bot.name}</span></div>)}
              </div>
            </div>
          </div>
          {description && <div className="flex items-start gap-3"><FileText size={17} className="mt-1 shrink-0 text-ink-secondary" /><div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{description}</div></div>}
          {attachments.length > 0 && <div className="flex items-start gap-3"><Paperclip size={17} className="mt-1 shrink-0 text-ink-secondary" /><div className="min-w-0 flex-1 space-y-2"><AttachmentChips attachments={attachments} />{call && <div className="text-[11px] leading-relaxed text-ink-secondary">{call.botIds.length > 1 ? "These references will be shared in the room when the event starts." : "These references stay with the event and are available when you join the room."}</div>}</div></div>}
          {run && <div className="rounded-xl border border-hairline/40 bg-inset p-3"><div className="flex items-center gap-2 text-[12px] font-medium capitalize text-ink">{run.status === "running" && <Loader2 size={13} className="animate-spin text-accent" />}{run.status.replace("waiting", "needs you")}</div>{run.output && <div className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-secondary">{run.output}</div>}{run.error && <div className="mt-2 text-[11.5px] text-danger">{run.error}</div>}</div>}
          {run?.attention && <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-warning"><CircleAlert size={15} className="mt-0.5 shrink-0" /><div className="min-w-0"><div className="text-[11.5px] font-semibold">Needs your attention</div><div className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed">{run.attention}</div></div></div>}
          {run?.status === "waiting" && !run.attention && <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-[11.5px] text-warning">This bot needs your answer. Open its task to continue the run.</div>}
          {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</div>}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-hairline/40 px-4 py-3">
          {roomId && <button onClick={() => onOpenRoom(roomId)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110"><ExternalLink size={13} />Join room</button>}
          {call && call.botIds.length > 1 && <button onClick={joinRoom} disabled={working} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"><ExternalLink size={13} />Join room</button>}
          {routine && <button onClick={() => void invoke(`/api/routines/${routine.id}/run`)} disabled={working} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"><Play size={13} />Run now</button>}
          {run?.threadId && primary && <button onClick={() => { dispatch({ type: "select", id: primary.id }); dispatch({ type: "switchTask", botId: primary.id, threadId: run.threadId! }); onClose(); }} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><ExternalLink size={13} />Open task</button>}
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

function PausedList({ routines, bots, onClose, onEdit }: { routines: Routine[]; bots: Bot[]; onClose: () => void; onEdit: (routine: Routine) => void }) {
  const { dispatch } = useStore();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Paused routines" className="w-full max-w-[520px] rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4"><div><div className="text-[16px] font-semibold text-ink">Paused routines</div><div className="mt-0.5 text-[11.5px] text-ink-secondary">History is kept; no new tasks will run.</div></div><button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised"><X size={17} /></button></div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto p-3">
          {routines.map((routine) => { const bot = bots.find((candidate) => candidate.id === routine.botId); return <div key={routine.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-raised/60">{bot && <BotAvatar bot={bot} state="sleeping" size={36} animated={false} />}<div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-medium text-ink">{routine.name}</div><div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">{scheduleLabel(routine.schedule)}</div></div><button onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: true } })} className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-[11px] font-medium text-accent">Resume</button><button onClick={() => onEdit(routine)} className="rounded-lg px-2 py-1.5 text-[11px] text-ink-secondary hover:bg-inset">Edit</button></div>; })}
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
      : nextHour();
  return <EventEditor seed={{ kind: "routine", at, durationMinutes: routine?.durationMinutes ?? 30, botIds: lockedBotId ? [lockedBotId] : routine ? [routine.botId] : [], routine }} bots={bots} lockedBotId={lockedBotId} defaultRunOn={defaultRunOn} onClose={onClose} onSavedCall={() => {}} />;
}

export function RoutinesPage({ onBack, onOpenRoom }: { onBack: () => void; onOpenRoom: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<"calendar" | "webhooks">("calendar");
  const [viewDays, setViewDays] = useState<1 | 3 | 7>(7);
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [botFilter, setBotFilter] = useState("all");
  const [calls, setCalls] = useState<CalendarCall[]>([]);
  const [quick, setQuick] = useState<EventSeed | null>(null);
  const [editor, setEditor] = useState<EventSeed | null>(null);
  const [selected, setSelected] = useState<CalendarEventItem | null>(null);
  const [pausedOpen, setPausedOpen] = useState(false);
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
  useEffect(() => { void loadCalls(); }, [loadCalls]);
  useEffect(() => { backButtonRef.current?.focus({ preventScroll: true }); }, []);

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
  const paused = state.routines.filter((routine) => !routine.enabled && (routine.schedule.type === "daily" || routine.schedule.at > Date.now()));
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
  const openCreate = useCallback((seed?: Partial<EventSeed>) => {
    setSelected(null);
    setQuick({ kind: "routine", at: nextHour(), durationMinutes: 30, botIds: [], ...seed });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "Escape") { setQuick(null); setEditor(null); setSelected(null); return; }
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
        if (routine.schedule.type === "daily" && !window.confirm("Move this entire recurring series?")) return;
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
          <div className="mr-3 flex items-center gap-2"><CalendarDays size={21} className="text-accent" /><h1 className="text-[18px] font-semibold tracking-tight text-ink">Calendar</h1></div>
          <div className="flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5" style={windowNoDragStyle}>
            <button onClick={() => setAnchor((current) => addDays(current, -viewDays))} className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Previous dates"><ChevronLeft size={16} /></button>
            <button onClick={goToday} className="rounded-md px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised">Today</button>
            <button onClick={() => setAnchor((current) => addDays(current, viewDays))} className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Next dates"><ChevronRight size={16} /></button>
          </div>
          <div className="min-w-[220px] px-2 text-[15px] font-medium text-ink">{calendarRangeLabel(rangeStart, viewDays)}</div>
          <div className="ml-auto flex items-center gap-2" style={windowNoDragStyle}>
            {running > 0 && <span className="hidden items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1.5 text-[10.5px] text-accent sm:flex"><Loader2 size={11} className="animate-spin" />{running} active</span>}
            {unseenFailures > 0 && <span className="hidden items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1.5 text-[10.5px] text-danger sm:flex"><CircleAlert size={11} />{unseenFailures}</span>}
            {paused.length > 0 && <button onClick={() => setPausedOpen(true)} className="hidden items-center gap-1.5 rounded-full border border-hairline/50 px-2.5 py-1.5 text-[10.5px] text-ink-secondary hover:bg-raised sm:flex"><Pause size={11} />{paused.length}</button>}
            <select value={botFilter} onChange={(event) => setBotFilter(event.target.value)} className="hidden rounded-lg border border-hairline/50 bg-panel px-2.5 py-2 text-[11.5px] text-ink outline-none focus:border-accent sm:block"><option value="all">All bots</option>{visibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
            <select value={viewDays} onChange={(event) => setView(Number(event.target.value) as 1 | 3 | 7)} className="rounded-lg border border-hairline/50 bg-panel px-2.5 py-2 text-[11.5px] text-ink outline-none focus:border-accent"><option value={1}>Day</option><option value={3}>3 days</option><option value={7}>Week</option></select>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1" style={windowNoDragStyle}>
          <button onClick={() => setSection("calendar")} className={cn("rounded-lg px-3 py-1.5 text-[11.5px] font-medium", section === "calendar" ? "bg-accent/12 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>Routines &amp; calls</button>
          <button onClick={() => setSection("webhooks")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-medium", section === "webhooks" ? "bg-accent/12 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}><Webhook size={12} />Webhooks{state.webhooks.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[9px]">{state.webhooks.length}</span>}</button>
          {error && <button onClick={() => setError("")} className="ml-auto flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[10.5px] text-danger"><CircleAlert size={11} />{error}<X size={11} /></button>}
        </div>
      </header>

      {section === "webhooks" ? <WebhooksPanel bots={visibleBots} /> : (
        <div className="flex min-h-0 flex-1">
          <div className="hidden shrink-0 lg:block"><CalendarSidebar bots={visibleBots} anchor={anchor} onSelectDate={(at) => setAnchor(startOfDay(at))} onCreate={() => openCreate()} /></div>
          <CalendarGrid anchor={rangeStart} days={viewDays} items={items} bots={state.bots} onOpen={(item) => { setSelected(item); if (item.kind === "routine" && item.run && ["failed", "missed"].includes(item.run.status) && !item.run.seenAt) dispatch({ type: "markRoutineRunSeen", runId: item.run.id }); }} onCreate={openCreate} onMove={(item, at) => void moveEvent(item, at)} onResize={(item, duration) => void resizeEvent(item, duration)} />
          <button onClick={() => openCreate()} disabled={!visibleBots.length} className="fixed bottom-5 right-5 z-30 flex size-12 items-center justify-center rounded-2xl bg-accent text-white shadow-xl shadow-black/30 hover:brightness-110 disabled:opacity-40 lg:hidden" aria-label="Create event"><Plus size={20} /></button>
        </div>
      )}

      {quick && <><div className="fixed inset-0 z-40 bg-black/25" onMouseDown={() => setQuick(null)} /><QuickComposer seed={quick} bots={visibleBots} onClose={() => setQuick(null)} onMore={(seed) => { setQuick(null); setEditor(seed); }} onSavedRoutine={(routine) => dispatch({ type: "routinePatched", routine })} onSavedCall={upsertCall} /></>}
      {editor && <EventEditor seed={editor} bots={visibleBots} onClose={() => setEditor(null)} onSavedCall={upsertCall} />}
      {liveSelected && <EventDetails item={liveSelected} bots={state.bots} onClose={() => setSelected(null)} onEdit={() => { const seed: EventSeed = liveSelected.kind === "call" ? { kind: "call", at: liveSelected.at, durationMinutes: liveSelected.call.durationMinutes, botIds: liveSelected.call.botIds, call: liveSelected.call } : { kind: "routine", at: liveSelected.at, durationMinutes: liveSelected.routine?.durationMinutes ?? liveSelected.run?.durationMinutes ?? 30, botIds: [liveSelected.routine?.botId ?? liveSelected.run?.botId ?? ""].filter(Boolean), routine: liveSelected.routine ?? undefined }; setSelected(null); setEditor(seed); }} onCallChanged={(id) => { if (id) setCalls((current) => current.filter((call) => call.id !== id)); else void loadCalls(); }} onOpenRoom={onOpenRoom} />}
      {pausedOpen && <PausedList routines={paused} bots={state.bots} onClose={() => setPausedOpen(false)} onEdit={(routine) => { setPausedOpen(false); const at = routine.schedule.type === "once" ? routine.schedule.at : atLocalTime(Date.now(), routine.schedule.time); setEditor({ kind: "routine", at, durationMinutes: routine.durationMinutes, botIds: [routine.botId], routine }); }} />}
    </main>
  );
}
