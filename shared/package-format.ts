// The OpenMausBot package file ("openmaus.package"): one team, or a library
// of skills and preset bots, as a single portable document.
//
// This module is the single validation gate for that file. The server, the
// renderer's import preview and the Admin upload (through the pinned
// runtime) all parse with exactly this code, so it may only import zod, yaml,
// croner (via routine-schedule) and the other pure modules in shared/. No
// Buffer, no node:fs, no node:crypto: TextEncoder and atob only.
//
// Two versions exist. v1 is the original team package (JSON or the BotMRR
// Markdown playbook). v2 adds the team brief, pictures, starter notes,
// connection slots, presets, room goals and library-only packages. Every
// reader here accepts both and always returns v2.
//
// What never travels is excluded by construction: the schema has no field
// for chat history, secrets, model choices, computers, visibility or
// personal settings, and unknown fields are stripped. Secrets written INSIDE
// free text are a separate problem, handled by redactPackageSecrets (export)
// and packageSecretFindings (Admin upload).
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { BOT_PROFILE_LIMITS, fitsOnOneLine } from "./bot-profile.ts";
import { redactSecretsInText } from "./redact.ts";
import { normalizeCronSchedule } from "./routine-schedule.ts";
import { isSkillName, parseSkillMd, scanSkillText, SKILL_FILE_MAX_BYTES } from "./skill-md.ts";

export const PACKAGE_FORMAT = "openmaus.package";
/** The newest version this module reads and writes. */
export const PACKAGE_VERSION = 2;
/** Canonical UTF-8 bytes of the whole document. */
export const PACKAGE_MAX_BYTES = 4 * 1024 * 1024;
export const PACKAGE_MAX_SKILLS = 60, AGENT_MAX_SKILLS = 30, PACKAGE_MAX_PRESETS = 20, PACKAGE_MAX_CONNECTIONS = 20;
/** Decoded picture bytes. */
export const AVATAR_MAX_BYTES = 64 * 1024;
export const SEED_FILE_MAX_BYTES = 256 * 1024, SEED_MAX_FILES = 100, SEED_MAX_BYTES = 1024 * 1024;
export const TEAM_BRIEF_MAX_BYTES = 24_000, RELEASE_NOTES_MAX = 4_000;

/** v1 limits, kept exactly as the v1 reader always enforced them. */
export const PACKAGE_V1_VERSION = 1;
export const PACKAGE_V1_MAX_SKILLS = 20;
export const BOTMRR_MARKDOWN_VERSION = 1;
const BOTMRR_MARKDOWN_MAX_BYTES = 1_000_000;

export const NEWER_PACKAGE_MESSAGE = "This file was made by a newer OpenMausBot. Update the app, then import it again.";

export type PackageTrust = "file" | "org";
export type PackageFormatErrorCode = "not_a_package" | "unsupported_version" | "newer_version" | "invalid" | "too_large";

export class PackageFormatError extends Error {
  readonly code: PackageFormatErrorCode;
  constructor(code: PackageFormatErrorCode, message: string) {
    super(message);
    this.name = "PackageFormatError";
    this.code = code;
  }
}

const COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"] as const;
const AVATAR_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
const AVATAR_CROPS = ["circle", "rounded", "square"] as const;

const encoder = new TextEncoder();
/** UTF-8 byte length, the unit every byte cap here is written in. */
export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

// ── shared field helpers (identical to the v1 reader) ─────────────────────

const requiredText = (max: number) =>
  z.string({ error: "must be text" }).trim().min(1, { message: "is required" }).max(max, { message: "is too long" });

const optionalText = (max: number) =>
  z
    .union([z.string({ error: "must be text" }), z.null(), z.undefined()])
    .transform((value) => value?.trim() || undefined)
    .refine((value) => value === undefined || value.length <= max, { message: "is too long" })
    .optional();

const oneLine = (max: number) => requiredText(max).refine(fitsOnOneLine, { message: "must fit on one line" });
const optionalLine = (max: number) =>
  optionalText(max).refine((value) => value === undefined || fitsOnOneLine(value), { message: "must fit on one line" });

const key = requiredText(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
  message: "may only contain lowercase letters, numbers, - and _",
});
const MAX_DATE_MS = 8_640_000_000_000_000;
const skillName = requiredText(64).refine(isSkillName, { message: "must be a lowercase skill name" });
const portableSource = optionalText(2_000).refine(
  (value) => value === undefined || !/^(?:[a-z]:[\\/]|[\\/]|\\\\|file:)/i.test(value),
  { message: "must not be an absolute path" },
);
const skillInstructions = z
  .string({ error: "must be text" })
  .min(1, { message: "is required" })
  .max(SKILL_FILE_MAX_BYTES, { message: "is too long" })
  .refine((value) => utf8Bytes(value) <= SKILL_FILE_MAX_BYTES, { message: "is too large" })
  .refine((value) => /^---\r?\n/.test(value), { message: "must start with SKILL.md frontmatter" });
const portableSkillSchema = z.object({
  name: skillName,
  description: requiredText(1_024),
  source: portableSource,
  license: optionalText(200),
  compatibility: optionalText(200),
  instructions: skillInstructions,
});
const soulSchema = z.string().refine((value) => utf8Bytes(value) <= BOT_PROFILE_LIMITS.soul, {
  error: "standing instructions must be at most 24000 bytes",
});
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const intervalWeekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(
  (weekdays) => new Set(weekdays).size === weekdays.length,
  "must contain unique weekdays",
);
const intervalWindow = z.object({
  start: z.string().regex(CLOCK_TIME, { message: "must use HH:MM" }),
  end: z.string().regex(CLOCK_TIME, { message: "must use HH:MM" }),
}).strict().refine(({ start, end }) => start < end, {
  message: "must end later on the same day",
});
/** Unchanged from v1: once, daily, interval and cron. */
export const packageRoutineScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), expression: requiredText(256), timeZone: requiredText(100) }).strict(),
  z.object({ type: z.literal("once"), at: z.number().int() }),
  z.object({
    type: z.literal("daily"),
    time: requiredText(5).regex(CLOCK_TIME, { message: "must use HH:MM" }),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
  z.object({
    type: z.literal("interval"),
    everyMinutes: z.number().int().min(5).max(1_440),
    anchorAt: z.number().int().nonnegative().max(MAX_DATE_MS),
    weekdays: intervalWeekdays.optional(),
    window: intervalWindow.optional(),
    endsAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
  }),
]).superRefine((schedule, context) => {
  if (schedule.type === "cron") {
    try { normalizeCronSchedule(schedule); }
    catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid cron schedule" }); }
    return;
  }
  if (schedule.type !== "interval") return;
  if (schedule.window) {
    const [startHour, startMinute] = schedule.window.start.split(":").map(Number);
    const [endHour, endMinute] = schedule.window.end.split(":").map(Number);
    const windowMinutes = endHour! * 60 + endMinute! - (startHour! * 60 + startMinute!);
    if (windowMinutes < schedule.everyMinutes) {
      context.addIssue({
        code: "custom",
        message: "must be at least as long as the interval cadence",
        path: ["window"],
      });
    }
  }
  if (schedule.endsAt !== undefined && schedule.endsAt < schedule.anchorAt) {
    context.addIssue({
      code: "custom",
      message: "must not be before the interval anchor",
      path: ["endsAt"],
    });
  }
});
const playbookSchema = z.object({
  key,
  name: requiredText(100),
  summary: requiredText(300),
  triggers: z.array(requiredText(100)).min(1).max(30),
  instructions: requiredText(24_000),
});
const requirementsSchema = z.object({
  apps: z.array(z.object({
    slug: key,
    label: requiredText(100),
    reason: requiredText(240),
    optional: z.boolean().optional(),
  })).max(30),
  capabilities: z.array(requiredText(80)).max(20),
  platforms: z.array(requiredText(80)).max(10).optional(),
});
const roomSchema = z.object({
  key,
  name: requiredText(100),
  members: z.array(key).min(1).max(200),
  bulletin: optionalText(12_000),
  defaultResponder: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), agent: key }),
    z.object({ kind: z.literal("everyone") }),
    z.object({ kind: z.literal("mentions") }),
  ]),
});
const exampleSchema = z.object({
  title: requiredText(120),
  input: requiredText(4_000),
  output: requiredText(8_000),
});

// ── v1 (read only; upgraded on the way in, produced only by downgradeToV1) ─

const packageDocumentV1Schema = z.object({
  format: z.literal(PACKAGE_FORMAT, { error: "This is not an OpenMaus package" }),
  version: z.literal(PACKAGE_V1_VERSION, { error: "Package version is not supported" }),
  package: z.object({
    id: requiredText(80).regex(/^[a-z0-9][a-z0-9-]*$/, { message: "must be a lowercase slug" }),
    release: requiredText(30).regex(/^\d+\.\d+\.\d+$/, { message: "must be semantic versioning" }),
    name: requiredText(100),
    tagline: requiredText(160),
    summary: requiredText(2_000),
    category: requiredText(80),
    author: z.object({ name: requiredText(100), url: optionalText(500) }),
    license: requiredText(80),
    featured: z.boolean().optional(),
    tags: z.array(requiredText(80)).max(30).optional(),
    outcomes: z.array(requiredText(240)).min(1).max(12),
    setupMinutes: z.number().int().min(1).max(240),
    requirements: requirementsSchema,
    agents: z.array(z.object({
      key,
      name: requiredText(100),
      title: optionalText(200),
      description: optionalText(4_000),
      soul: soulSchema.optional(),
      appearance: z.object({
        color: z.enum(COLORS, { error: "is not supported" }),
        mascotExpression: optionalText(80),
        mascotBody: optionalText(40),
      }),
      playbooks: z.array(key).max(40).optional(),
      skills: z.array(skillName).max(PACKAGE_V1_MAX_SKILLS).optional(),
    })).min(1).max(200),
    chiefOfStaff: key.optional(),
    rooms: z.array(roomSchema).max(30).optional(),
    routines: z.array(z.object({
      key,
      name: requiredText(80),
      agent: key,
      prompt: requiredText(20_000),
      runOn: z.enum(["maus", "cloud"]),
      schedule: packageRoutineScheduleSchema,
      durationMinutes: z.number().int().min(5).max(240),
      timeoutMinutes: z.number().int().min(5).max(240).optional(),
      overlap: z.enum(["skip", "queue"]).optional(),
      enabledAfterInstall: z.literal(false),
    })).max(50).optional(),
    playbooks: z.array(playbookSchema).max(80).optional(),
    skills: z.object({
      version: z.literal(1),
      entries: z.array(portableSkillSchema).min(1).max(PACKAGE_V1_MAX_SKILLS),
    }).optional(),
    examples: z.array(exampleSchema).max(12).optional(),
  }),
});

export type PackageDocumentV1 = z.output<typeof packageDocumentV1Schema>;

// ── v2 ─────────────────────────────────────────────────────────────────────

const semver = z.string({ error: "must be text" }).regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/, {
  message: "must be a version like 1.2.3",
});
const slug = requiredText(80).regex(/^[a-z0-9][a-z0-9-]*$/, { message: "must be a lowercase slug" });
const orgSlug = z.string({ error: "must be text" }).regex(/^[a-z][a-z0-9-]{1,30}$/, { message: "must be an organization's short name" });
/** The MCP server name rule, with room left for a "-NN" suffix on import. */
const connKey = z.string({ error: "must be text" }).regex(/^[a-z][a-z0-9_-]{0,27}$/, {
  message: "must be 1-28 lowercase letters, numbers, - or _, starting with a letter",
});
const headerName = z.string({ error: "must be text" }).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/, {
  message: "must be a valid header name",
});

/** atob + bytes, or null when the text is not base64. */
export function decodeBase64(value: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The image really is the type it claims: no SVG or HTML behind an image mime. */
export function pictureMatchesMime(bytes: Uint8Array, mime: string): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mime === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (mime === "image/webp") {
    return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return false;
}

const avatarSchema = z.object({
  mime: z.enum(AVATAR_MIMES, { error: "must be a PNG, JPEG or WebP picture" }),
  // base64 of at most AVATAR_MAX_BYTES
  data: z.string({ error: "must be text" }).max(87_384, { message: "is larger than 64 KB" }).regex(/^[A-Za-z0-9+/]+={0,2}$/, {
    message: "must be base64",
  }),
  crop: z.enum(AVATAR_CROPS, { error: "must be circle, rounded or square" }),
}).superRefine((avatar, context) => {
  const bytes = decodeBase64(avatar.data);
  if (!bytes) {
    context.addIssue({ code: "custom", path: ["data"], message: "must be base64" });
  } else if (bytes.length > AVATAR_MAX_BYTES) {
    context.addIssue({ code: "custom", path: ["data"], message: "is larger than 64 KB" });
  } else if (!pictureMatchesMime(bytes, avatar.mime)) {
    context.addIssue({ code: "custom", path: ["data"], message: `is not a ${avatar.mime.slice(6).toUpperCase()} picture` });
  }
});

const appearanceSchema = z.object({
  color: z.enum(COLORS, { error: "is not supported" }),
  mascotExpression: optionalText(80),
  mascotBody: optionalText(40),
  avatar: avatarSchema.optional(),
});

/** Starter notes travel as MEMORY.md plus topic files. Daily logs never do. */
export function isSeedPath(path: string): boolean {
  return path === "MEMORY.md" || (path.startsWith("memory/") && /^[\w][\w .-]{0,199}\.md$/.test(path.slice(7)));
}

const seedSchema = z.object({
  memory: z.record(z.string(), z.string({ error: "must be text" })),
}).superRefine((seed, context) => {
  const entries = Object.entries(seed.memory);
  let total = 0;
  for (const [path, text] of entries) {
    if (!isSeedPath(path)) {
      context.addIssue({ code: "custom", path: ["memory", path], message: "must be MEMORY.md or memory/<topic>.md; daily logs never travel" });
      continue;
    }
    const bytes = utf8Bytes(text);
    total += bytes;
    if (bytes > SEED_FILE_MAX_BYTES) context.addIssue({ code: "custom", path: ["memory", path], message: "is larger than 256 KB" });
  }
  if (entries.length > SEED_MAX_FILES) context.addIssue({ code: "custom", path: ["memory"], message: `has more than ${SEED_MAX_FILES} files` });
  if (total > SEED_MAX_BYTES) context.addIssue({ code: "custom", path: ["memory"], message: "is larger than 1 MB in total" });
});

const agentSchema = z.object({
  key,
  name: oneLine(100),
  title: optionalLine(200),
  description: optionalText(4_000),
  soul: soulSchema.optional(),
  appearance: appearanceSchema,
  /** A suggestion only: every imported bot starts on Ask. */
  approval: z.enum(["ask", "auto"], { error: "must be ask or auto" }).optional(),
  playbooks: z.array(key).max(40).optional(),
  skills: z.array(skillName).max(AGENT_MAX_SKILLS).optional(),
  connections: z.array(connKey).max(PACKAGE_MAX_CONNECTIONS).optional(),
  seed: seedSchema.optional(),
});

const routineSchema = z.object({
  key,
  name: requiredText(80),
  /** The owner; for a room goal, the lead coordinator. */
  agent: key,
  /** Present = a room goal (runs on this computer, no continuity). */
  room: key.optional(),
  prompt: requiredText(20_000),
  runOn: z.enum(["maus", "cloud"]),
  schedule: packageRoutineScheduleSchema,
  durationMinutes: z.number().int().min(5).max(240),
  timeoutMinutes: z.number().int().min(1).max(1_440).optional(),
  overlap: z.enum(["skip", "queue"]).optional(),
  continuity: z.boolean().optional(),
  /** The publisher's intent. File imports always arrive paused. */
  enabledAfterInstall: z.boolean(),
});

/** Preset bots: an allowlist. No approval, computer, browser, MCP, apps or model. */
const presetSchema = z.object({
  key,
  name: oneLine(100),
  description: optionalText(300),
  bot: z.object({
    name: optionalLine(100),
    title: optionalLine(200),
    description: optionalText(4_000),
    soul: soulSchema.optional(),
    appearance: appearanceSchema.optional(),
  }),
  playbooks: z.array(key).max(40).optional(),
  skills: z.array(skillName).max(AGENT_MAX_SKILLS).optional(),
  seed: seedSchema.optional(),
});

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A credential SLOT: the address and the names of the values it needs. */
const connectionSchema = z.object({
  key: connKey,
  label: requiredText(100),
  reason: requiredText(240),
  mcp: z.object({
    transport: z.enum(["http", "sse"], { error: "must be http or sse; a package never carries a command to run" }),
    url: requiredText(2_000)
      .refine((value) => {
        const url = parsedUrl(value);
        return Boolean(url && (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))));
      }, { message: "must be an https:// address (http:// only for this computer)" })
      .refine((value) => {
        const url = parsedUrl(value);
        return !url || (!url.username && !url.password);
      }, { message: "must not contain a user name or password" }),
    valueNames: z.array(headerName).max(32).refine((names) => new Set(names.map((name) => name.toLowerCase())).size === names.length, {
      message: "must not repeat a header",
    }),
  }),
});

export const packageDocumentSchema = z.object({
  format: z.literal(PACKAGE_FORMAT, { error: "This is not an OpenMaus package" }),
  version: z.literal(PACKAGE_VERSION, { error: "Package version is not supported" }),
  package: z.object({
    /** The package slug: its identity across releases. */
    id: slug,
    release: semver,
    name: requiredText(100),
    tagline: requiredText(160),
    summary: requiredText(2_000),
    notes: optionalText(RELEASE_NOTES_MAX),
    category: requiredText(80),
    author: z.object({ name: requiredText(100), url: optionalText(500) }),
    license: requiredText(80),
    featured: z.boolean().optional(),
    tags: z.array(requiredText(80)).max(30).optional(),
    outcomes: z.array(requiredText(240)).min(1).max(12),
    setupMinutes: z.number().int().min(1).max(240),
    /** Stamped by Admin only; a file never chooses it (trust "file" drops it). */
    publisher: z.object({ organization: orgSlug, name: requiredText(100) }).optional(),
    requirements: requirementsSchema,
    team: z.object({
      name: requiredText(60),
      brief: z.string({ error: "must be text" }).refine((value) => utf8Bytes(value) <= TEAM_BRIEF_MAX_BYTES, {
        message: `must be at most ${TEAM_BRIEF_MAX_BYTES} bytes`,
      }).optional(),
      /** The team's Chief of Staff. */
      leader: key.optional(),
    }).optional(),
    agents: z.array(agentSchema).max(200).default([]),
    rooms: z.array(roomSchema).max(30).optional(),
    routines: z.array(routineSchema).max(50).optional(),
    playbooks: z.array(playbookSchema).max(80).optional(),
    skills: z.object({
      version: z.literal(1),
      entries: z.array(portableSkillSchema).min(1).max(PACKAGE_MAX_SKILLS),
    }).optional(),
    presets: z.array(presetSchema).max(PACKAGE_MAX_PRESETS).optional(),
    connections: z.array(connectionSchema).max(PACKAGE_MAX_CONNECTIONS).optional(),
    examples: z.array(exampleSchema).max(12).optional(),
  }),
});

export type PackageDocument = z.output<typeof packageDocumentSchema>;
export type PackageDefinition = PackageDocument["package"];
export type PackageAgent = PackageDefinition["agents"][number];
export type PackageRoom = NonNullable<PackageDefinition["rooms"]>[number];
export type PackageRoutine = NonNullable<PackageDefinition["routines"]>[number];
export type PackagePlaybook = NonNullable<PackageDefinition["playbooks"]>[number];
export type PackageSkill = NonNullable<PackageDefinition["skills"]>["entries"][number];
export type PackagePreset = NonNullable<PackageDefinition["presets"]>[number];
export type PackageConnection = NonNullable<PackageDefinition["connections"]>[number];
export type PackageAvatar = NonNullable<PackageAgent["appearance"]["avatar"]>;
export type PackageRoutineSchedule = PackageRoutine["schedule"];

// ── part paths ─────────────────────────────────────────────────────────────

/** Lists whose items are named by `key` in part paths: agents[scout].soul. */
const KEYED_LISTS = new Set(["agents", "rooms", "routines", "playbooks", "presets", "connections"]);

function segmentsAfter(head: string, rest: ReadonlyArray<PropertyKey>): string {
  let out = head;
  for (const segment of rest) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (out.endsWith(".seed.memory")) out += `[${JSON.stringify(String(segment))}]`;
    else out += `.${String(segment)}`;
  }
  return out;
}

/** Map a schema path onto the part-path grammar shared with Admin:
 * package.summary, team.brief, agents[scout].soul, skills[x].instructions,
 * agents[scout].seed.memory["MEMORY.md"]. Keys come from the raw input. */
function describePath(input: unknown, path: ReadonlyArray<PropertyKey>): string {
  if (path[0] !== "package") return path.map(String).join(".") || "package";
  const pkg = input && typeof input === "object" ? (input as { package?: Record<string, unknown> }).package : undefined;
  const field = path[1];
  if (field === undefined) return "package";
  const name = String(field);
  const list = pkg && typeof pkg === "object" ? pkg[name] : undefined;
  if (KEYED_LISTS.has(name)) {
    const index = path[2];
    if (typeof index !== "number") return segmentsAfter(name, path.slice(2));
    const item = Array.isArray(list) ? list[index] : undefined;
    const id = item && typeof item === "object" ? (item as { key?: unknown }).key : undefined;
    return segmentsAfter(`${name}[${typeof id === "string" && id.trim() ? id.trim() : index}]`, path.slice(3));
  }
  if (name === "skills" && path[2] === "entries" && typeof path[3] === "number") {
    const entries = list && typeof list === "object" ? (list as { entries?: unknown }).entries : undefined;
    const entry = Array.isArray(entries) ? entries[path[3]] : undefined;
    const id = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    return segmentsAfter(`skills[${typeof id === "string" && id.trim() ? id.trim() : path[3]}]`, path.slice(4));
  }
  if (name === "team") return segmentsAfter("team", path.slice(2));
  return segmentsAfter(`package.${name}`, path.slice(2));
}

function schemaSentence(error: z.ZodError, input: unknown): string {
  const issue = error.issues[0];
  if (!issue) return "This is not a valid package";
  if (issue.path.length <= 2 && (issue.path[0] === "format" || issue.path[0] === "version")) return issue.message;
  return `${describePath(input, issue.path)} ${issue.message}`;
}

/** The v1 reader's historical message shape ("package.agents.0.name is too long"). */
function v1SchemaSentence(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "This is not a bot package";
  const path = issue.path.map(String).join(".");
  return path ? `${path} ${issue.message}` : issue.message;
}

// ── canonical form ─────────────────────────────────────────────────────────

/** Sorted keys (default UTF-16 sort), undefined omitted, no whitespace,
 * leaves by JSON.stringify. The release sha256 is over exactly these bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((name) => record[name] !== undefined).sort();
  return `{${keys.map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`).join(",")}}`;
}

/** Canonical UTF-8 bytes of a document: what Admin stores and the cap measures. */
export function packageBytes(document: unknown): number {
  return utf8Bytes(canonicalJson(document));
}

function tooLarge(): PackageFormatError {
  return new PackageFormatError("too_large", `This package is larger than ${PACKAGE_MAX_BYTES / (1024 * 1024)} MB.`);
}

// ── cross-references ───────────────────────────────────────────────────────

function invalid(message: string): PackageFormatError {
  return new PackageFormatError("invalid", message);
}

function uniqueKeys(values: string[], label: string): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw invalid(`Duplicate ${label} key: ${value}`);
    seen.add(value);
  }
  return seen;
}

function checkSkillEntries(entries: ReadonlyArray<z.output<typeof portableSkillSchema>>): void {
  for (const skill of entries) {
    const parsed = parseSkillMd(skill.instructions);
    if ("error" in parsed) throw invalid(`Skill ${skill.name} is invalid: ${parsed.error}`);
    if (parsed.name !== skill.name) throw invalid(`Skill ${skill.name} does not match its SKILL.md name`);
    if (parsed.description !== skill.description) throw invalid(`Skill ${skill.name} does not match its description`);
    for (const field of ["license", "compatibility"] as const) {
      if (skill[field] !== undefined && skill[field] !== parsed[field]) {
        throw invalid(`Skill ${skill.name} does not match its ${field}`);
      }
    }
  }
}

function checkV1References(pkg: PackageDocumentV1["package"]): void {
  const agents = uniqueKeys(pkg.agents.map((agent) => agent.key), "agent");
  const playbooks = uniqueKeys((pkg.playbooks ?? []).map((playbook) => playbook.key), "playbook");
  const skills = uniqueKeys((pkg.skills?.entries ?? []).map((skill) => skill.name), "skill");
  uniqueKeys((pkg.rooms ?? []).map((room) => room.key), "room");
  uniqueKeys((pkg.routines ?? []).map((routine) => routine.key), "routine");
  if (pkg.chiefOfStaff && !agents.has(pkg.chiefOfStaff)) throw invalid(`Unknown Chief of Staff: ${pkg.chiefOfStaff}`);
  for (const agent of pkg.agents) {
    for (const playbook of agent.playbooks ?? []) {
      if (!playbooks.has(playbook)) throw invalid(`Agent ${agent.key} references unknown playbook: ${playbook}`);
    }
    for (const skill of uniqueKeys(agent.skills ?? [], `skill in agent ${agent.key}`)) {
      if (!skills.has(skill)) throw invalid(`Agent ${agent.key} references unknown skill: ${skill}`);
    }
  }
  const referenced = new Set(pkg.agents.flatMap((agent) => agent.skills ?? []));
  checkSkillEntries(pkg.skills?.entries ?? []);
  for (const skill of pkg.skills?.entries ?? []) {
    if (!referenced.has(skill.name)) throw invalid(`Skill ${skill.name} is not referenced by an agent`);
  }
  for (const room of pkg.rooms ?? []) {
    const members = uniqueKeys(room.members, `member in room ${room.key}`);
    for (const member of members) {
      if (!agents.has(member)) throw invalid(`Room ${room.key} references unknown agent: ${member}`);
    }
    if (room.defaultResponder.kind === "agent" && !members.has(room.defaultResponder.agent)) {
      throw invalid(`Room ${room.key} has an unknown default responder`);
    }
  }
  for (const routine of pkg.routines ?? []) {
    if (!agents.has(routine.agent)) throw invalid(`Routine ${routine.key} references unknown agent: ${routine.agent}`);
  }
}

function checkV2References(pkg: PackageDefinition): void {
  const isTeam = pkg.agents.length > 0;
  if (isTeam && !pkg.team) throw invalid("A package with bots needs a team");
  if (!isTeam) {
    if (pkg.team || pkg.rooms?.length || pkg.routines?.length) {
      throw invalid("A package without bots cannot have a team, group chats or routines");
    }
    if (!pkg.skills?.entries.length && !pkg.presets?.length) {
      throw invalid("A package without bots needs at least one skill or preset");
    }
  }
  const agents = uniqueKeys(pkg.agents.map((agent) => agent.key), "agent");
  const rooms = uniqueKeys((pkg.rooms ?? []).map((room) => room.key), "room");
  uniqueKeys((pkg.routines ?? []).map((routine) => routine.key), "routine");
  const playbooks = uniqueKeys((pkg.playbooks ?? []).map((playbook) => playbook.key), "playbook");
  uniqueKeys((pkg.presets ?? []).map((preset) => preset.key), "preset");
  const connections = uniqueKeys((pkg.connections ?? []).map((connection) => connection.key), "connection");
  const skills = uniqueKeys((pkg.skills?.entries ?? []).map((skill) => skill.name), "skill");

  if (pkg.team?.leader && !agents.has(pkg.team.leader)) throw invalid(`Unknown team leader: ${pkg.team.leader}`);
  const checkAssignments = (owner: string, assigned: { playbooks?: string[]; skills?: string[] }) => {
    for (const playbook of uniqueKeys(assigned.playbooks ?? [], `playbook in ${owner}`)) {
      if (!playbooks.has(playbook)) throw invalid(`${owner} references unknown playbook: ${playbook}`);
    }
    for (const skill of uniqueKeys(assigned.skills ?? [], `skill in ${owner}`)) {
      if (!skills.has(skill)) throw invalid(`${owner} references unknown skill: ${skill}`);
    }
  };
  for (const agent of pkg.agents) {
    checkAssignments(`Agent ${agent.key}`, agent);
    for (const connection of uniqueKeys(agent.connections ?? [], `connection in agent ${agent.key}`)) {
      if (!connections.has(connection)) throw invalid(`Agent ${agent.key} references unknown connection: ${connection}`);
    }
  }
  for (const preset of pkg.presets ?? []) checkAssignments(`Preset ${preset.key}`, preset);
  checkSkillEntries(pkg.skills?.entries ?? []);
  const roomMembers = new Map<string, Set<string>>();
  for (const room of pkg.rooms ?? []) {
    const members = uniqueKeys(room.members, `member in room ${room.key}`);
    for (const member of members) {
      if (!agents.has(member)) throw invalid(`Room ${room.key} references unknown agent: ${member}`);
    }
    if (room.defaultResponder.kind === "agent" && !members.has(room.defaultResponder.agent)) {
      throw invalid(`Room ${room.key} has a default responder who is not a member: ${room.defaultResponder.agent}`);
    }
    roomMembers.set(room.key, members);
  }
  for (const routine of pkg.routines ?? []) {
    if (!agents.has(routine.agent)) throw invalid(`Routine ${routine.key} references unknown agent: ${routine.agent}`);
    if (routine.room === undefined) continue;
    if (!rooms.has(routine.room)) throw invalid(`Routine ${routine.key} references unknown group chat: ${routine.room}`);
    if (routine.runOn !== "maus") throw invalid(`Routine ${routine.key} is a group chat goal, which only runs on this computer`);
    if (routine.continuity) throw invalid(`Routine ${routine.key} is a group chat goal, which cannot carry continuity`);
    // The goal scheduler refuses a lead who is not in the room.
    if (!roomMembers.get(routine.room)!.has(routine.agent)) {
      throw invalid(`Routine ${routine.key} is led by ${routine.agent}, who is not a member of group chat ${routine.room}`);
    }
  }
}

// ── Markdown (v1 only) ─────────────────────────────────────────────────────

function markdownDocument(markdown: string): unknown {
  if (markdown.length > PACKAGE_MAX_BYTES) throw tooLarge();
  if (utf8Bytes(markdown) > BOTMRR_MARKDOWN_MAX_BYTES) throw new PackageFormatError("too_large", "The bot playbook is too large");
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new PackageFormatError("not_a_package", "This Markdown is missing YAML frontmatter");
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]!);
  } catch {
    throw new PackageFormatError("not_a_package", "This Markdown has invalid YAML frontmatter");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new PackageFormatError("not_a_package", "This Markdown is missing its BotMRR blueprint");
  }
  const { botmrr, ...definition } = metadata as Record<string, unknown>;
  if (botmrr !== BOTMRR_MARKDOWN_VERSION) throw new PackageFormatError("unsupported_version", "BotMRR Markdown version is not supported");
  for (const heading of ["Activation", "Mission", "Outcomes", "Connections", "Team", "Chief of Staff", "Completion rule"]) {
    if (!markdown.includes(`## ${heading}`)) throw new PackageFormatError("invalid", `This Markdown is missing its ${heading} section`);
  }
  return { format: PACKAGE_FORMAT, version: PACKAGE_V1_VERSION, package: definition };
}

// ── readers ────────────────────────────────────────────────────────────────

/** True for a BotMRR Markdown string or an object that says it is a package. */
export function isPackageDocument(value: unknown): boolean {
  if (typeof value === "string") return /^---\r?\n[\s\S]*?\bbotmrr:\s*1\b/m.test(value);
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (value as { format?: unknown }).format === PACKAGE_FORMAT;
}

/** Parse exactly one v1 document (JSON object or Markdown) with the v1 rules.
 * Kept for the v1 exporter and its Markdown renderer. */
export function parsePackageV1(value: unknown): PackageDocumentV1 {
  const source = typeof value === "string" ? markdownDocument(value) : value;
  const parsed = packageDocumentV1Schema.safeParse(source);
  if (!parsed.success) throw new PackageFormatError("invalid", v1SchemaSentence(parsed.error));
  checkV1References(parsed.data.package);
  return parsed.data;
}

function validateV2(source: unknown): PackageDocument {
  const parsed = packageDocumentSchema.safeParse(source);
  if (!parsed.success) throw invalid(schemaSentence(parsed.error, source));
  checkV2References(parsed.data.package);
  return parsed.data;
}

/** Normalize a v1 release ("01.2.03" → "1.2.3"): numeric parts, no leading zeros. */
function normalizedRelease(release: string): string {
  return release.split(".").map((part) => String(Number.parseInt(part, 10))).join(".");
}

/** v1 → v2: chiefOfStaff becomes team.leader, the team is named after the
 * package, routines stay paused. Everything else is copied as it is. */
export function upgradeV1(document: PackageDocumentV1): PackageDocument {
  const { chiefOfStaff, ...pkg } = document.package;
  return validateV2({
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    package: {
      ...pkg,
      release: normalizedRelease(pkg.release),
      team: { name: pkg.name.slice(0, 60).trim(), ...(chiefOfStaff ? { leader: chiefOfStaff } : {}) },
      ...(pkg.routines ? { routines: pkg.routines.map((routine) => ({ ...routine, enabledAfterInstall: false })) } : {}),
    },
  });
}

/** Accepts v1 (object or BotMRR Markdown string) and v2 (object). Always
 * returns v2. trust "file" (the default) deletes package.publisher: only
 * Admin may stamp who published a release. */
export function parsePackageDocument(value: unknown, options: { trust?: PackageTrust } = {}): PackageDocument {
  const trust = options.trust ?? "file";
  let document: PackageDocument;
  if (typeof value === "string") {
    document = upgradeV1(parsePackageV1(value));
  } else {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { format?: unknown }).format !== PACKAGE_FORMAT) {
      throw new PackageFormatError("not_a_package", "This is not an OpenMaus package");
    }
    const version = (value as { version?: unknown }).version;
    if (typeof version === "number" && Number.isInteger(version) && version > PACKAGE_VERSION) {
      throw new PackageFormatError("newer_version", NEWER_PACKAGE_MESSAGE);
    }
    if (version !== PACKAGE_V1_VERSION && version !== PACKAGE_VERSION) {
      throw new PackageFormatError("unsupported_version", "Package version is not supported");
    }
    // A cheap guard before any schema work; the exact cap is re-checked on
    // the normalized document below.
    if (packageBytes(value) > PACKAGE_MAX_BYTES) throw tooLarge();
    document = version === PACKAGE_V1_VERSION ? upgradeV1(parsePackageV1(value)) : validateV2(value);
  }
  if (trust === "file") delete document.package.publisher;
  if (packageBytes(document) > PACKAGE_MAX_BYTES) throw tooLarge();
  return document;
}

// ── older apps ─────────────────────────────────────────────────────────────

/** A v1 document for apps older than v2 support. Refuses what v1 cannot
 * represent; lists what it had to leave out. */
export function downgradeToV1(document: PackageDocument):
  { document: PackageDocumentV1; dropped: string[] } | { error: string } {
  const pkg = document.package;
  if (!pkg.agents.length || !pkg.team) return { error: "Packages without bots cannot be opened by older versions of OpenMausBot." };
  const referenced = new Set(pkg.agents.flatMap((agent) => agent.skills ?? []));
  const skills = (pkg.skills?.entries ?? []).filter((skill) => referenced.has(skill.name));
  if (skills.length > PACKAGE_V1_MAX_SKILLS) {
    return { error: `Older versions of OpenMausBot accept at most ${PACKAGE_V1_MAX_SKILLS} skills in a package.` };
  }
  const crowded = pkg.agents.find((agent) => (agent.skills?.length ?? 0) > PACKAGE_V1_MAX_SKILLS);
  if (crowded) return { error: `Older versions of OpenMausBot accept at most ${PACKAGE_V1_MAX_SKILLS} skills per bot (${crowded.key} has more).` };
  const outOfRange = (pkg.routines ?? []).find((routine) => routine.timeoutMinutes !== undefined && (routine.timeoutMinutes < 5 || routine.timeoutMinutes > 240));
  if (outOfRange) return { error: `Older versions of OpenMausBot accept run limits from 5 to 240 minutes (${outOfRange.key} has ${outOfRange.timeoutMinutes}).` };

  const dropped: string[] = [];
  if (pkg.publisher) dropped.push("package.publisher");
  if (pkg.notes !== undefined) dropped.push("package.notes");
  if (pkg.team.name !== pkg.name.slice(0, 60).trim()) dropped.push("team.name");
  if (pkg.team.brief !== undefined) dropped.push("team.brief");
  for (const skill of pkg.skills?.entries ?? []) if (!referenced.has(skill.name)) dropped.push(`skills[${skill.name}]`);
  for (const preset of pkg.presets ?? []) dropped.push(`presets[${preset.key}]`);
  for (const connection of pkg.connections ?? []) dropped.push(`connections[${connection.key}]`);
  const agents = pkg.agents.map((agent) => {
    const { approval, connections, seed, appearance, ...kept } = agent;
    const { avatar, ...look } = appearance;
    if (avatar) dropped.push(`agents[${agent.key}].appearance.avatar`);
    if (approval !== undefined) dropped.push(`agents[${agent.key}].approval`);
    if (connections?.length) dropped.push(`agents[${agent.key}].connections`);
    if (seed) dropped.push(`agents[${agent.key}].seed`);
    return { ...kept, appearance: look };
  });
  const routines = (pkg.routines ?? []).flatMap((routine) => {
    if (routine.room !== undefined) {
      dropped.push(`routines[${routine.key}]`);
      return [];
    }
    const { room: _room, continuity, ...kept } = routine;
    if (continuity !== undefined) dropped.push(`routines[${routine.key}].continuity`);
    return [{ ...kept, enabledAfterInstall: false as const }];
  });
  const {
    team, publisher: _publisher, notes: _notes, presets: _presets, connections: _connections,
    skills: _skills, agents: _agents, routines: _routines, ...rest
  } = pkg;
  const v1: Record<string, unknown> = {
    ...rest,
    agents,
    ...(team.leader ? { chiefOfStaff: team.leader } : {}),
    ...(routines.length ? { routines } : {}),
    ...(skills.length ? { skills: { version: 1, entries: skills } } : {}),
  };
  try {
    return { document: parsePackageV1({ format: PACKAGE_FORMAT, version: PACKAGE_V1_VERSION, package: v1 }), dropped };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "This package cannot be written for older versions of OpenMausBot." };
  }
}

// ── text leaves: secrets and scan ──────────────────────────────────────────

type TextVisitor = (part: string, value: string) => string | void;

/** Every string leaf of the document, with its part path, except picture
 * bytes. A visitor that returns a string replaces the leaf in place. */
function visitText(document: PackageDocument, visit: TextVisitor): void {
  const walk = (holder: Record<string, unknown> | unknown[], slot: string | number, part: string) => {
    const value = (holder as Record<string | number, unknown>)[slot];
    if (typeof value === "string") {
      const next = visit(part, value);
      if (typeof next === "string" && next !== value) (holder as Record<string | number, unknown>)[slot] = next;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((_, index) => walk(value, index, `${part}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const name of Object.keys(record)) {
      if (part.endsWith(".appearance.avatar") && name === "data") continue;
      walk(record, name, part.endsWith(".seed.memory") ? `${part}[${JSON.stringify(name)}]` : `${part}.${name}`);
    }
  };
  const pkg = document.package as unknown as Record<string, unknown>;
  for (const name of Object.keys(pkg)) {
    const value = pkg[name];
    if (KEYED_LISTS.has(name) && Array.isArray(value)) {
      value.forEach((item, index) => {
        const id = item && typeof item === "object" ? (item as { key?: unknown }).key : undefined;
        const head = `${name}[${typeof id === "string" ? id : index}]`;
        if (!item || typeof item !== "object") return walk(value, index, head);
        for (const field of Object.keys(item as Record<string, unknown>)) walk(item as Record<string, unknown>, field, `${head}.${field}`);
      });
    } else if (name === "skills" && value && typeof value === "object") {
      const entries = (value as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        const id = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
        const head = `skills[${typeof id === "string" ? id : index}]`;
        if (!entry || typeof entry !== "object") return;
        for (const field of Object.keys(entry as Record<string, unknown>)) walk(entry as Record<string, unknown>, field, `${head}.${field}`);
      });
    } else if (name === "team") {
      if (!value || typeof value !== "object") continue;
      for (const field of Object.keys(value as Record<string, unknown>)) walk(value as Record<string, unknown>, field, `team.${field}`);
    } else {
      walk(pkg, name, `package.${name}`);
    }
  }
}

/** Part paths where a key- or password-shaped value appears. Never values. */
export function packageSecretFindings(document: PackageDocument): string[] {
  const parts: string[] = [];
  visitText(document, (part, value) => {
    if (redactSecretsInText(value) !== value) parts.push(part);
  });
  return parts;
}

/** Replace every key- or password-shaped value with the redaction marker.
 * Idempotent. The caller re-parses: a redaction can break a skill's
 * frontmatter, and then the export must refuse with the parser's sentence. */
export function redactPackageSecrets(document: PackageDocument): { document: PackageDocument; redacted: string[] } {
  const copy = structuredClone(document);
  const redacted: string[] = [];
  visitText(copy, (part, value) => {
    const next = redactSecretsInText(value);
    if (next === value) return;
    redacted.push(part);
    return next;
  });
  return { document: copy, redacted };
}

/** The skill scan (hidden blobs, curl|sh, invisible text) over every text part. */
export function packageScanFindings(document: PackageDocument): Array<{ part: string; warning: string }> {
  const findings: Array<{ part: string; warning: string }> = [];
  visitText(document, (part, value) => {
    for (const warning of scanSkillText(value)) findings.push({ part, warning });
  });
  return findings;
}

// ── identity and contents ──────────────────────────────────────────────────

/** Every item's stable identity: "agents:scout", "skills:x", … */
export function packageKeys(document: PackageDocument): string[] {
  const pkg = document.package;
  return [
    ...pkg.agents.map((agent) => `agents:${agent.key}`),
    ...(pkg.rooms ?? []).map((room) => `rooms:${room.key}`),
    ...(pkg.routines ?? []).map((routine) => `routines:${routine.key}`),
    ...(pkg.skills?.entries ?? []).map((skill) => `skills:${skill.name}`),
    ...(pkg.presets ?? []).map((preset) => `presets:${preset.key}`),
    ...(pkg.connections ?? []).map((connection) => `connections:${connection.key}`),
    ...(pkg.playbooks ?? []).map((playbook) => `playbooks:${playbook.key}`),
  ];
}

export interface PackageSummary {
  kind: "team" | "library";
  name: string;
  tagline: string;
  counts: { bots: number; skills: number; presets: number; rooms: number; routines: number; connections: number; playbooks: number };
  botNames: string[];
  skillNames: string[];
  presetNames: string[];
  connectionLabels: string[];
  apps: string[];
}

export function packageSummary(document: PackageDocument): PackageSummary {
  const pkg = document.package;
  return {
    kind: pkg.agents.length ? "team" : "library",
    name: pkg.name,
    tagline: pkg.tagline,
    counts: {
      bots: pkg.agents.length,
      skills: pkg.skills?.entries.length ?? 0,
      presets: pkg.presets?.length ?? 0,
      rooms: pkg.rooms?.length ?? 0,
      routines: pkg.routines?.length ?? 0,
      connections: pkg.connections?.length ?? 0,
      playbooks: pkg.playbooks?.length ?? 0,
    },
    botNames: pkg.agents.slice(0, 12).map((agent) => agent.name),
    skillNames: (pkg.skills?.entries ?? []).slice(0, PACKAGE_MAX_SKILLS).map((skill) => skill.name),
    presetNames: (pkg.presets ?? []).map((preset) => preset.name),
    connectionLabels: (pkg.connections ?? []).map((connection) => connection.label),
    apps: pkg.requirements.apps.map((app) => app.label),
  };
}
