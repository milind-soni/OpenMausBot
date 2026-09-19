import { cronChoiceFor, type CronChoice } from "@/components/routines/cron-editor";
import type { CalendarCall } from "@/lib/calendar-calls";
import { type MausState } from "@/lib/mascot";
import { addDays, atLocalTime, CALENDAR_SLOT_MINUTES, startOfDay, toLocalTimeInput, type RoutineCalendarItem } from "@/lib/routine-calendar";
import type { Routine, RoutineRunStatus, RoutineSchedule, RoutineScheduleInput } from "../../../shared/routines";
import { type Bot, type Group } from "@/state/store";

export const HOUR_HEIGHT = 64;
export const DAY_CHIP_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const INTERVAL_PRESETS = [5, 10, 15, 30, 60];
export const EVENT_DURATION_OPTIONS = Array.from({ length: 240 / CALENDAR_SLOT_MINUTES }, (_, index) => (index + 1) * CALENDAR_SLOT_MINUTES);
export const BOT_DRAG_TYPE = "application/x-openmaus-bot";
export const EVENT_DRAG_TYPE = "application/x-openmaus-calendar-event";

export type EventKind = "routine" | "call";
export type CalendarRecurrenceChoice = "none" | "daily" | "weekdays" | "weekly" | "custom";
export type RecurrenceChoice = CalendarRecurrenceChoice | "interval" | CronChoice;
export type IntervalDayChoice = "every-day" | "weekdays" | "custom";
export type IntervalWindowChoice = "all-day" | "custom";
export type IntervalEndChoice = "never" | "on-date";

export type CallOccurrence = {
  id: string;
  at: number;
  durationMinutes: number;
  call: CalendarCall;
};

export type CalendarEventItem =
  | ({ kind: "routine" } & RoutineCalendarItem)
  | ({ kind: "call" } & CallOccurrence);

export type EventSeed = {
  kind: EventKind;
  at: number;
  durationMinutes: number;
  botIds: string[];
  name?: string;
  description?: string;
  resultsThreadId?: string | null;
  anchor?: { x: number; y: number };
  routine?: Routine;
  call?: CalendarCall;
};

export function activeRoomMembers(group: Group | undefined, bots: Bot[]): Bot[] {
  if (!group) return [];
  return group.memberIds.flatMap((id) => {
    const bot = bots.find((candidate) => candidate.id === id);
    return bot && !bot.hidden ? [bot] : [];
  });
}

export function roomCanRunGoal(group: Group): boolean {
  if (group.dm) return false;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
  return !hasSetupMarker ||
    group.setupCompletedAt != null ||
    group.setupSkippedAt != null ||
    (group.messages?.length ?? 0) > 0;
}

export function preferredRoomLead(group: Group | undefined, bots: Bot[], preferredId?: string): Bot | undefined {
  const members = activeRoomMembers(group, bots);
  const explicitLeadId = group?.defaultResponder.kind === "member" ? group.defaultResponder.botId : undefined;
  return members.find((bot) => bot.id === preferredId)
    ?? members.find((bot) => bot.id === explicitLeadId)
    ?? members.find((bot) => bot.chiefOfStaff)
    ?? members[0];
}

export function nextHour(): number {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export function sameDays(left: readonly number[] | undefined, right: readonly number[]): boolean {
  return Boolean(left && left.length === right.length && left.every((day, index) => day === right[index]));
}

export function intervalDayChoice(schedule: RoutineSchedule | CalendarCall["schedule"]): IntervalDayChoice {
  if (schedule.type !== "interval" || !schedule.weekdays || schedule.weekdays.length === 7) return "every-day";
  return sameDays(schedule.weekdays, WEEKDAYS) ? "weekdays" : "custom";
}

export function endOfLocalDate(dateInput: string): number {
  const date = new Date(`${dateInput}T00:00`);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}
export function recurrenceFor(schedule: RoutineSchedule | CalendarCall["schedule"], at: number): RecurrenceChoice {
  if (schedule.type === "once") return "none";
  if (schedule.type === "interval") return "interval";
  if (schedule.type === "cron") return cronChoiceFor(schedule);
  if (schedule.weekdays.length === 7) return "daily";
  if (schedule.weekdays.join(",") === "1,2,3,4,5") return "weekdays";
  if (schedule.weekdays.length === 1 && schedule.weekdays[0] === new Date(at).getDay()) return "weekly";
  return "custom";
}

export function makeCalendarSchedule(choice: CalendarRecurrenceChoice, at: number, weekdays: number[]): CalendarCall["schedule"] {
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

export function makeRoutineSchedule(
  choice: Exclude<RecurrenceChoice, CronChoice>,
  at: number,
  weekdays: number[],
  everyMinutes: number,
  interval: {
    anchorAt: number;
    weekdays: number[] | null;
    window: { start: string; end: string } | null;
    endsAt: number | null;
  },
): RoutineScheduleInput {
  if (choice === "interval") return { type: "interval", everyMinutes, ...interval };
  return makeCalendarSchedule(choice, at, weekdays);
}

export function projectCalls(calls: CalendarCall[], from: number, to: number): CallOccurrence[] {
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

export function statusState(status: RoutineRunStatus): MausState {
  if (status === "running") return "working";
  if (status === "waiting") return "curious";
  if (status === "completed") return "proud";
  if (status === "failed" || status === "missed") return "sad";
  if (status === "cancelled") return "sleeping";
  return "drowsy";
}
