import { z } from "zod";

import { normalizeCronSchedule } from "./routine-schedule.ts";

export const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const MAX_DATE_MS = 8_640_000_000_000_000;
export const ENGINE_ID = /^[\w.:-]{1,128}$/;

export function intervalWindowMinutes(window: { start: string; end: string }): number {
  const [startHour, startMinute] = window.start.split(":").map(Number);
  const [endHour, endMinute] = window.end.split(":").map(Number);
  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
}

export const storedWeekdaysSchema = z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(
  (weekdays) => new Set(weekdays).size === weekdays.length,
  "Stored routine weekdays must be unique",
);
export const storedIntervalWindowSchema = z.object({
  start: z.string().regex(TIME),
  end: z.string().regex(TIME),
}).strict().refine(
  ({ start, end }) => start < end,
  "Stored interval window must end later on the same day",
);
export const storedCronScheduleSchema = z.object({
  type: z.literal("cron"), expression: z.string().max(256), timeZone: z.string().max(128),
}).strict().superRefine((schedule, context) => {
  try {
    normalizeCronSchedule(schedule);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid stored cron schedule" });
  }
});
export const storedLimitResetDefinition = {
  engine: z.string().regex(ENGINE_ID),
  repeat: z.enum(["once", "every_reset"]),
};
export const storedLimitResetAtSchema = z.number().int().positive().max(MAX_DATE_MS).nullable();

export function refineStoredInterval(
  schedule: {
    type: string;
    everyMinutes?: number;
    window?: { start: string; end: string } | null;
    endsAt?: number | null;
    anchorAt?: number;
  },
  context: { addIssue(issue: { code: "custom"; message: string; path: string[] }): void },
): void {
  if (schedule.type !== "interval") return;
  if (schedule.window && schedule.everyMinutes !== undefined && intervalWindowMinutes(schedule.window) < schedule.everyMinutes) {
    context.addIssue({
      code: "custom",
      message: "Stored interval window must be at least as long as the cadence",
      path: ["window"],
    });
  }
  if (
    schedule.endsAt !== undefined &&
    schedule.endsAt !== null &&
    schedule.anchorAt !== undefined &&
    schedule.endsAt < schedule.anchorAt
  ) {
    context.addIssue({
      code: "custom",
      message: "Stored interval end must not be before its anchor",
      path: ["endsAt"],
    });
  }
}
