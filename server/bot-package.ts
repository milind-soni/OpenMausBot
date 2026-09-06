import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { schemaIssue, type JsonValue } from "./schema.ts";
import type { MausColor } from "./store.ts";
import type { TeamManifestMember } from "./team-manifest.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";

export const BOT_PACKAGE_FORMAT = "openmaus.package" as const;
export const BOT_PACKAGE_VERSION = 1 as const;
export const BOTMRR_MARKDOWN_VERSION = 1 as const;

const COLORS = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
] as const satisfies readonly MausColor[];

const requiredText = (max: number) =>
  z.string({ error: "must be text" }).trim().min(1, { message: "is required" }).max(max, { message: "is too long" });

const optionalText = (max: number) =>
  z
    .union([z.string({ error: "must be text" }), z.null(), z.undefined()])
    .transform((value) => value?.trim() || undefined)
    .refine((value) => value === undefined || value.length <= max, { message: "is too long" })
    .optional();

const key = requiredText(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
  message: "may only contain lowercase letters, numbers, - and _",
});
const MAX_DATE_MS = 8_640_000_000_000_000;

const packageSchema = z.object({
  format: z.literal(BOT_PACKAGE_FORMAT, { error: "This is not an OpenMaus package" }),
  version: z.literal(BOT_PACKAGE_VERSION, { error: "Package version is not supported" }),
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
    requirements: z.object({
      apps: z.array(z.object({
        slug: key,
        label: requiredText(100),
        reason: requiredText(240),
        optional: z.boolean().optional(),
      })).max(30),
      capabilities: z.array(requiredText(80)).max(20),
      platforms: z.array(requiredText(80)).max(10).optional(),
    }),
    agents: z.array(z.object({
      key,
      name: requiredText(100),
      title: optionalText(200),
      description: optionalText(4_000),
      soul: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= BOT_PROFILE_LIMITS.soul, {
        error: "standing instructions must be at most 24000 bytes",
      }).optional(),
      appearance: z.object({
        color: z.enum(COLORS, { error: "is not supported" }),
        mascotExpression: optionalText(80),
        mascotBody: optionalText(40),
      }),
      playbooks: z.array(key).max(40).optional(),
    })).min(1).max(200),
    chiefOfStaff: key.optional(),
    rooms: z.array(z.object({
      key,
      name: requiredText(100),
      members: z.array(key).min(1).max(200),
      bulletin: optionalText(12_000),
      defaultResponder: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("agent"), agent: key }),
        z.object({ kind: z.literal("everyone") }),
        z.object({ kind: z.literal("mentions") }),
      ]),
    })).max(30).optional(),
    routines: z.array(z.object({
      key,
      name: requiredText(80),
      agent: key,
      prompt: requiredText(20_000),
      runOn: z.enum(["maus", "cloud"]),
      schedule: z.discriminatedUnion("type", [
        z.object({ type: z.literal("once"), at: z.number().int() }),
        z.object({
          type: z.literal("daily"),
          time: requiredText(5).regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "must use HH:MM" }),
          weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        }),
        z.object({
          type: z.literal("interval"),
          everyMinutes: z.number().int().min(5).max(1_440),
          anchorAt: z.number().int().nonnegative().max(MAX_DATE_MS),
        }),
      ]),
      durationMinutes: z.number().int().min(5).max(240),
      timeoutMinutes: z.number().int().min(5).max(240).optional(),
      enabledAfterInstall: z.literal(false),
    })).max(50).optional(),
    playbooks: z.array(z.object({
      key,
      name: requiredText(100),
      summary: requiredText(300),
      triggers: z.array(requiredText(100)).min(1).max(30),
      instructions: requiredText(24_000),
    })).max(80).optional(),
    examples: z.array(z.object({
      title: requiredText(120),
      input: requiredText(4_000),
      output: requiredText(8_000),
    })).max(12).optional(),
  }),
});

export type ParsedBotPackage = z.infer<typeof packageSchema>;
export type BotPackageDefinition = ParsedBotPackage["package"];
export type BotPackageAgent = BotPackageDefinition["agents"][number];
export type BotPackagePlaybook = NonNullable<BotPackageDefinition["playbooks"]>[number];

export function isBotPackage(value: unknown): boolean {
  if (typeof value === "string") return /^---\r?\n[\s\S]*?\bbotmrr:\s*1\b/m.test(value);
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (value as { format?: unknown }).format === BOT_PACKAGE_FORMAT;
}

function markdownDocument(markdown: string): ParsedBotPackage {
  if (Buffer.byteLength(markdown) > 1_000_000) throw new Error("The bot playbook is too large");
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error("This Markdown is missing YAML frontmatter");
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]);
  } catch {
    throw new Error("This Markdown has invalid YAML frontmatter");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("This Markdown is missing its BotMRR blueprint");
  }
  const { botmrr, ...definition } = metadata as Record<string, unknown>;
  if (botmrr !== BOTMRR_MARKDOWN_VERSION) throw new Error("BotMRR Markdown version is not supported");
  for (const heading of ["Activation", "Mission", "Outcomes", "Connections", "Team", "Chief of Staff", "Completion rule"]) {
    if (!markdown.includes(`## ${heading}`)) throw new Error(`This Markdown is missing its ${heading} section`);
  }
  return {
    format: BOT_PACKAGE_FORMAT,
    version: BOT_PACKAGE_VERSION,
    package: definition as BotPackageDefinition,
  };
}

/** Parse and cross-reference one complete, portable package. Unknown fields
 * are stripped; ids, grants, credentials, paths, model selections, and
 * runtime state therefore cannot ride through the package boundary. */
export function parseBotPackage(value: JsonValue | ParsedBotPackage): ParsedBotPackage {
  const source = typeof value === "string" ? markdownDocument(value) : value;
  const parsed = packageSchema.safeParse(source);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "This is not a bot package"));
  const pkg = parsed.data.package;

  const unique = (values: string[], label: string) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) throw new Error(`Duplicate ${label} key: ${value}`);
      seen.add(value);
    }
    return seen;
  };
  const agents = unique(pkg.agents.map((agent) => agent.key), "agent");
  const playbooks = unique((pkg.playbooks ?? []).map((playbook) => playbook.key), "playbook");
  unique((pkg.rooms ?? []).map((room) => room.key), "room");
  unique((pkg.routines ?? []).map((routine) => routine.key), "routine");

  if (pkg.chiefOfStaff && !agents.has(pkg.chiefOfStaff)) {
    throw new Error(`Unknown Chief of Staff: ${pkg.chiefOfStaff}`);
  }
  for (const agent of pkg.agents) {
    for (const playbook of agent.playbooks ?? []) {
      if (!playbooks.has(playbook)) throw new Error(`Agent ${agent.key} references unknown playbook: ${playbook}`);
    }
  }
  for (const room of pkg.rooms ?? []) {
    const members = unique(room.members, `member in room ${room.key}`);
    for (const member of members) {
      if (!agents.has(member)) throw new Error(`Room ${room.key} references unknown agent: ${member}`);
    }
    if (room.defaultResponder.kind === "agent" && !members.has(room.defaultResponder.agent)) {
      throw new Error(`Room ${room.key} has an unknown default responder`);
    }
  }
  for (const routine of pkg.routines ?? []) {
    if (!agents.has(routine.agent)) throw new Error(`Routine ${routine.key} references unknown agent: ${routine.agent}`);
  }
  return parsed.data;
}

const list = (values: string[]) => values.map((value) => `- ${value}`).join("\n");

/** Render the public artifact. The frontmatter enables deterministic imports;
 * the body is deliberately complete enough for any Chief-of-Staff agent to
 * run without OpenMausBot or another proprietary parser. */
export function renderBotPackageMarkdown(document: ParsedBotPackage): string {
  const pkg = parseBotPackage(document).package;
  const frontmatter = stringifyYaml({ botmrr: BOTMRR_MARKDOWN_VERSION, ...pkg }, { lineWidth: 0 }).trim();
  const agents = pkg.agents.map((agent) => [
    `### ${agent.name} — ${agent.title || "Specialist"}`,
    `**Role key:** \`${agent.key}\``,
    agent.playbooks?.length ? `**Use these playbooks:** ${agent.playbooks.map((key) => `\`${key}\``).join(", ")}` : "",
    "",
    agent.description,
  ].filter(Boolean).join("\n\n")).join("\n\n");
  const rooms = (pkg.rooms ?? []).map((room) => [
    `### ${room.name}`,
    `**Members:** ${room.members.map((key) => `\`${key}\``).join(", ")}`,
    `**Default responder:** ${room.defaultResponder.kind === "agent" ? `\`${room.defaultResponder.agent}\`` : room.defaultResponder.kind}`,
    "",
    room.bulletin,
  ].join("\n\n")).join("\n\n");
  const routines = (pkg.routines ?? []).map((routine) => [
    `### ${routine.name}`,
    `**Owner:** \`${routine.agent}\`  `,
    `**Schedule:** ${
      routine.schedule.type === "daily"
        ? `${routine.schedule.time} on weekdays ${routine.schedule.weekdays.join(", ")}`
        : routine.schedule.type === "interval"
          ? `every ${routine.schedule.everyMinutes} minutes from ${new Date(routine.schedule.anchorAt).toISOString()}`
          : `once at ${routine.schedule.at}`
    }  `,
    `**Run limit:** ${routine.timeoutMinutes === undefined ? "none" : `${routine.timeoutMinutes} minutes`}  `,
    "**Initial state:** paused — the user must enable it",
    "",
    routine.prompt,
  ].join("\n")).join("\n\n");
  const playbooks = (pkg.playbooks ?? []).map((playbook) => [
    `### ${playbook.name}`,
    `**Playbook key:** \`${playbook.key}\`  `,
    `**Use when:** ${playbook.triggers.join(", ")}`,
    "",
    playbook.summary,
    "",
    playbook.instructions,
  ].join("\n")).join("\n\n");
  const examples = (pkg.examples ?? []).map((example) => [
    `### ${example.title}`,
    "**Ask**",
    "",
    example.input,
    "",
    "**Expected result**",
    "",
    example.output,
  ].join("\n")).join("\n\n");
  const connections = pkg.requirements.apps.length
    ? pkg.requirements.apps.map((app) => `- **${app.label}${app.optional ? " (optional)" : ""}:** ${app.reason}`).join("\n")
    : "- No connected apps are required.";

  return `---\n${frontmatter}\n---\n\n# ${pkg.name}\n\n${pkg.tagline}\n\n> **Give this file to your Chief of Staff.** It is the complete team blueprint. Any agent system can run it; OpenMausBot can also install it directly.\n\n## Activation\n\nYou are the Chief of Staff for this blueprint. Read the whole document before acting. Confirm the user's goal and any missing inputs, then create or delegate to the specialist roles below. Preserve their names, ownership, boundaries, shared-room rules, and playbooks. If your platform cannot literally spawn agents, perform the roles one at a time and keep their outputs clearly separated.\n\nNever request pasted passwords or secret keys. Use the platform's normal connection flow. Do not send messages, publish content, spend money, delete data, or enable a schedule without the user's explicit approval. All routines start paused.\n\n## Mission\n\n${pkg.summary}\n\n## Outcomes\n\n${list(pkg.outcomes)}\n\n## Connections\n\n${connections}\n\n## Team\n\n${agents}\n\n## Chief of Staff\n\nThe Chief of Staff role is \`${pkg.chiefOfStaff ?? pkg.agents[0].key}\`. This role owns delegation, synthesis, conflict resolution, and the final answer to the user.\n${rooms ? `\n## Shared rooms\n\n${rooms}\n` : ""}${routines ? `\n## Suggested routines\n\n${routines}\n` : ""}${playbooks ? `\n## Playbooks\n\n${playbooks}\n` : ""}${examples ? `\n## Example job\n\n${examples}\n` : ""}\n## Completion rule\n\nReturn one clear result to the user, distinguish evidence from inference, cite source links when the work uses external material, and state what still needs human approval or a connected app.\n`;
}

export function packageAgentAsMember(agent: BotPackageAgent): TeamManifestMember {
  return {
    key: agent.key,
    name: agent.name,
    title: agent.title ?? "",
    description: agent.description ?? "",
    ...(agent.soul !== undefined ? { soul: agent.soul } : {}),
    appearance: {
      color: agent.appearance.color,
      ...(agent.appearance.mascotExpression ? { mascotExpression: agent.appearance.mascotExpression } : {}),
      ...(agent.appearance.mascotBody ? { mascotBody: agent.appearance.mascotBody } : {}),
    },
  };
}
