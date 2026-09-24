import { z } from "zod";
import { profilePatchSchema, fitsOnOneLine } from "./bot-profile.ts";
import { EFFORT_LEVELS } from "../shared/wire.ts";
import { isModelVariant } from "./contracts.ts";
import { normalizeCronSchedule } from "../shared/routine-schedule.ts";

const strings = (max: number, length: number) => z.array(z.string().max(length)).max(max);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);

export const botDefaultModelSchema = z.object({
  instanceId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  effort: z.enum(EFFORT_LEVELS).optional(),
  variant: z.string().refine(isModelVariant, "invalid model variant").optional(),
}).strict().refine(value => value.effort === undefined || value.variant === undefined,
  "choose either a model variant or an effort level");

// Preferences only. Consent flags, live grants, bot IDs and execution state
// cannot be stored here and therefore cannot be replayed as permission grants.
export const botDefaultsProfileSchema = profilePatchSchema.extend({
  name: z.string().max(100).refine(fitsOnOneLine, "name must fit on one line").optional(),
  section: z.string().trim().max(60).optional(),
  color: z.enum(["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"]).optional(),
  mascotExpression: z.string().max(60).nullable().optional(),
  modelSelection: botDefaultModelSchema.optional(),
  computer: z.enum(["cloud", "vm", "local", "browser", "off"]).nullable().optional(),
  cloudBackend: z.enum(["box", "vps"]).optional(),
  autoStartVps: z.boolean().optional(),
  cwd: z.string().max(4096).nullable().optional(),
  approvalMode: z.enum(["ask", "auto", "full", "custom"]).optional(),
  alwaysAllow: strings(200, 500).optional(),
  chiefOfStaff: z.boolean().optional(),
  managedSections: strings(100, 60).optional(),
  approvePeerComms: z.boolean().optional(),
  peers: strings(1000, 100).nullable().optional(),
  composio: z.boolean().optional(),
  browser: z.boolean().optional(),
  browserProfile: z.string().max(100).nullable().optional(),
  mcpServers: strings(100, 100).nullable().optional(),
  parkDirectMessages: z.boolean().optional(),
}).strict();

const scheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: timestamp }).strict(),
  z.object({ type: z.literal("daily"), time: clock, weekdays }).strict(),
  z.object({
    type: z.literal("interval"), everyMinutes: z.number().int().min(5).max(1440), anchorAt: timestamp,
    weekdays: weekdays.nullable().optional(),
    window: z.object({ start: clock, end: clock }).strict().nullable().optional(),
    endsAt: timestamp.nullable().optional(),
  }).strict(),
  z.object({ type: z.literal("cron"), expression: z.string().max(256), timeZone: z.string().max(128) }).strict(),
]).superRefine((value, ctx) => {
  if (value.type === "cron") {
    try { normalizeCronSchedule(value); }
    catch (error) { ctx.addIssue({ code: "custom", message: String(error) }); }
  }
  if (value.type === "interval" && value.window) {
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    if (minutes(value.window.end) - minutes(value.window.start) < value.everyMinutes) {
      ctx.addIssue({ code: "custom", message: "The interval must fit inside its time window" });
    }
  }
});

export const botRoutineTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(20_000),
  schedule: scheduleSchema, enabled: z.boolean().optional(),
  runOn: z.enum(["maus", "cloud"]).optional(),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  timeoutMinutes: z.number().min(1).max(1440).nullable().optional(),
  overlap: z.enum(["skip", "queue"]).optional(),
  attachments: z.array(z.object({
    id: z.string().min(1).max(200), kind: z.enum(["file", "image"]),
    name: z.string().min(1).max(255), path: z.string().min(1).max(4096), size: z.number().nonnegative(),
  }).strict()).max(50).optional(),
}).strict();

export const botSkillTemplateSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().max(1024),
  warnings: strings(100, 2000).default([]),
  source: z.string().min(1).max(2000),
  text: z.string().refine(value => Buffer.byteLength(value, "utf8") <= 262_144, "Skill exceeds 256 KiB"),
  enabled: z.boolean(),
}).strict();

export const newBotDefaultsSchema = z.object({
  profile: botDefaultsProfileSchema.default({}),
  memory: z.record(z.string().regex(/^(?:MEMORY\.md|memory\/[a-zA-Z0-9_-]+\.md)$/),
    z.string().refine(value => Buffer.byteLength(value, "utf8") <= 262_144, "Memory file exceeds 256 KiB"))
    .refine(value => Object.keys(value).length <= 100, "At most 100 memory files").default({}),
  skills: z.array(botSkillTemplateSchema).max(100).default([]),
  routines: z.array(botRoutineTemplateSchema).max(100).default([]),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= 900_000,
  "Bot defaults must fit within 900 KB");

export type NewBotDefaults = z.infer<typeof newBotDefaultsSchema>;
export type BotDefaultsProfile = NewBotDefaults["profile"];
export type BotRoutineTemplate = NewBotDefaults["routines"][number];
export type BotSkillTemplate = NewBotDefaults["skills"][number];

/** Explicit values (including empty values) win. A resolved renderer draft
 * opts out so deleted fields and template extras are not restored on POST. */
export function resolveBotCreationDefaults(saved: NewBotDefaults | undefined, body: Record<string, unknown>) {
  if (body.useDefaults !== undefined && typeof body.useDefaults !== "boolean") {
    throw Object.assign(new Error("useDefaults must be true or false"), { status: 400 });
  }
  const template = newBotDefaultsSchema.parse(body.useDefaults === false ? {} : saved ?? {});
  const checked = botDefaultsProfileSchema.safeParse(body.settings === undefined ? {} : body.settings);
  if (!checked.success) throw Object.assign(new Error(checked.error.message), { status: 400 });
  const explicit = checked.data;
  const profile = { ...template.profile, ...explicit };
  for (const key of ["name", "title", "description", "modelSelection", "section"] as const) {
    if (Object.hasOwn(body, key)) Object.assign(profile, { [key]: key === "section" && body[key] === null ? "" : body[key] });
  }
  const resolved = botDefaultsProfileSchema.safeParse(profile);
  if (!resolved.success) throw Object.assign(new Error(resolved.error.message), { status: 400 });
  if (!resolved.data.name?.trim()) delete resolved.data.name;
  return { ...template, profile: resolved.data };
}
