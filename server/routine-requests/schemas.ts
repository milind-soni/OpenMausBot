// Routine request schemas — the tool-input proposal shapes, the stored card
// payload, and the inferred input types the normalizers consume.

import { z } from "zod";

import { normalizeCronSchedule } from "../../shared/routine-schedule.ts";
import type { JsonValue } from "../schema.ts";

export const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const ROUTINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_DATE_MS = 8_640_000_000_000_000;
export function intervalWindowMinutes(window: { start: string; end: string }): number {
  const [startHour, startMinute] = window.start.split(":").map(Number);
  const [endHour, endMinute] = window.end.split(":").map(Number);
  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
}
export const jsonObjectSchema = z.record(z.string(), z.custom<JsonValue>());
const toolIntervalWindowSchema = z.object({
  start: z.string().max(5),
  end: z.string().max(5),
}).strict();

const routineToolScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), expression: z.string().max(256), timeZone: z.string().max(128) }).strict(),
  z.object({ type: z.literal("once"), at: z.string().max(64) }).strict(),
  z.object({
    type: z.literal("weekly"),
    time: z.string().max(5),
    weekdays: z.array(z.string().max(9)).min(1).max(7),
  }).strict(),
  z.object({
    type: z.literal("interval"),
    everyMinutes: z.number(),
    anchorAt: z.string().max(64).optional(),
    weekdays: z.array(z.string().max(9)).min(1).max(7).nullable().optional(),
    window: toolIntervalWindowSchema.nullable().optional(),
    endsAt: z.string().max(64).nullable().optional(),
  }).strict(),
]);

const routineToolDefinitionSchema = z.object({
  name: z.string().max(80),
  instructions: z.string().max(20_000),
  schedule: routineToolScheduleSchema,
  runOn: z.enum(["maus", "cloud"]).optional(),
  durationMinutes: z.number().optional(),
  timeoutMinutes: z.number().nullable().optional(),
  continuity: z.boolean().optional(),
}).strict();

const routineToolChangesSchema = routineToolDefinitionSchema
  .omit({ timeoutMinutes: true })
  .partial()
  .extend({ timeoutMinutes: z.number().nullable().optional() })
  .strict()
  .refine(
  (changes) => Object.values(changes).some((value) => value !== undefined),
  "Choose at least one routine field to update",
);

/** Resolved and authorized by the harness route (existence + same section)
 * before it reaches this service; re-authorized again at confirm time. */
const targetBotSchema = z.object({
  botId: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
}).strict();
export const routineProposalSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), routine: routineToolDefinitionSchema, forBot: targetBotSchema.optional() }).strict(),
  z.object({ action: z.literal("update"), routineId: z.string().max(128), changes: routineToolChangesSchema }).strict(),
  z.object({ action: z.literal("pause"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("resume"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("run_now"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("delete"), routineId: z.string().max(128) }).strict(),
]);

const storedWeekdaysSchema = z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(
  (weekdays) => new Set(weekdays).size === weekdays.length,
  "Stored routine weekdays must be unique",
);
const storedIntervalWindowSchema = z.object({
  start: z.string().regex(TIME),
  end: z.string().regex(TIME),
}).strict().refine(
  ({ start, end }) => start < end,
  "Stored interval window must end later on the same day",
);
const storedCronScheduleSchema = z.object({
  type: z.literal("cron"), expression: z.string().max(256), timeZone: z.string().max(128),
}).strict().superRefine((schedule, context) => {
  try {
    normalizeCronSchedule(schedule);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid stored cron schedule" });
  }
});
export const storedScheduleSchema = z.discriminatedUnion("type", [
  storedCronScheduleSchema,
  z.object({ type: z.literal("once"), at: z.number().int().nonnegative() }).strict(),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(TIME),
    weekdays: storedWeekdaysSchema,
  }).strict(),
  z.object({
    type: z.literal("interval"),
    everyMinutes: z.number().int().min(5).max(1_440),
    anchorAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
    weekdays: storedWeekdaysSchema.optional(),
    window: storedIntervalWindowSchema.optional(),
    endsAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
  }).strict(),
]).superRefine((schedule, context) => {
  if (schedule.type !== "interval") return;
  if (schedule.window && intervalWindowMinutes(schedule.window) < schedule.everyMinutes) {
    context.addIssue({
      code: "custom",
      message: "Stored interval window must be at least as long as the cadence",
      path: ["window"],
    });
  }
  if (schedule.endsAt !== undefined && schedule.anchorAt !== undefined && schedule.endsAt < schedule.anchorAt) {
    context.addIssue({
      code: "custom",
      message: "Stored interval end must not be before its anchor",
      path: ["endsAt"],
    });
  }
});
const storedScheduleChangesSchema = z.discriminatedUnion("type", [
  storedCronScheduleSchema,
  z.object({ type: z.literal("once"), at: z.number().int().nonnegative() }).strict(),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(TIME),
    weekdays: storedWeekdaysSchema,
  }).strict(),
  z.object({
    type: z.literal("interval"),
    everyMinutes: z.number().int().min(5).max(1_440),
    anchorAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
    weekdays: storedWeekdaysSchema.nullable().optional(),
    window: storedIntervalWindowSchema.nullable().optional(),
    endsAt: z.number().int().nonnegative().max(MAX_DATE_MS).nullable().optional(),
  }).strict(),
]).superRefine((schedule, context) => {
  if (schedule.type !== "interval") return;
  if (schedule.window && intervalWindowMinutes(schedule.window) < schedule.everyMinutes) {
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
});
const storedDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(20_000),
  schedule: storedScheduleSchema,
  runOn: z.enum(["maus", "cloud"]),
  durationMinutes: z.number().int().min(5).max(240),
  timeoutMinutes: z.number().int().min(5).max(240).optional(),
  continuity: z.boolean().optional(),
}).strict();
const storedChangesSchema = storedDefinitionSchema
  .omit({ schedule: true, timeoutMinutes: true })
  .partial()
  .extend({
    schedule: storedScheduleChangesSchema.optional(),
    timeoutMinutes: z.number().int().min(5).max(240).nullable().optional(),
  })
  .strict()
  .refine(
  (changes) => Object.values(changes).some((value) => value !== undefined),
  "Stored routine update must change at least one field",
);
const storedManageBase = {
  routineId: z.string().regex(ROUTINE_ID),
  expectedUpdatedAt: z.number().int().nonnegative(),
};
const storedOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), routine: storedDefinitionSchema, forBot: targetBotSchema.optional() }).strict(),
  z.object({ action: z.literal("update"), ...storedManageBase, changes: storedChangesSchema }).strict(),
  z.object({ action: z.literal("pause"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("resume"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("run_now"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("delete"), ...storedManageBase }).strict(),
]);
export const routineRequestCardDataSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128),
  createdAt: z.number().int().nonnegative(),
  operation: storedOperationSchema,
  appliedAt: z.number().int().nonnegative().optional(),
  resultId: z.string().min(1).max(128).optional(),
}).strict();

export type RoutineToolScheduleInput = z.infer<typeof routineToolScheduleSchema>;
export type RoutineToolDefinitionInput = z.infer<typeof routineToolDefinitionSchema>;
export type RoutineToolChangesInput = z.infer<typeof routineToolChangesSchema>;
export type RoutineProposalInput = z.input<typeof routineProposalSchema>;
export type ParsedRoutineProposal = z.output<typeof routineProposalSchema>;
