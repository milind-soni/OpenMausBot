import { stringify as stringifyYaml } from "yaml";

import type { JsonValue } from "./schema.ts";
import type { TeamManifestMember } from "./team-manifest.ts";
import { cronScheduleLabel } from "../shared/cron-label.ts";
import {
  BOTMRR_MARKDOWN_VERSION,
  isPackageDocument,
  PACKAGE_FORMAT,
  PACKAGE_V1_MAX_SKILLS,
  PACKAGE_V1_VERSION,
  parsePackageV1,
  utf8Bytes,
  type PackageDocumentV1,
} from "../shared/package-format.ts";

// The package file format (v1 and v2) lives in shared/package-format.ts: one
// validation gate for the server, the renderer and Admin. This module keeps
// the v1 names the v1 exporter and its Markdown playbook are written in, and
// re-exports the v2 reader so server code has one place to import from.
export {
  canonicalJson,
  downgradeToV1,
  PACKAGE_MAX_BYTES,
  PACKAGE_VERSION,
  PackageFormatError,
  packageKeys,
  packageScanFindings,
  packageSecretFindings,
  packageSummary,
  parsePackageDocument,
  redactPackageSecrets,
  upgradeV1,
  type PackageDocument,
  type PackageTrust,
} from "../shared/package-format.ts";

export const BOT_PACKAGE_FORMAT = PACKAGE_FORMAT;
export const BOT_PACKAGE_VERSION = PACKAGE_V1_VERSION;
export { BOTMRR_MARKDOWN_VERSION };
export const BOT_PACKAGE_SKILLS_VERSION = 1 as const;
export const BOT_PACKAGE_MAX_SKILLS = PACKAGE_V1_MAX_SKILLS;
const BOT_PACKAGE_MARKDOWN_MAX_BYTES = 1_000_000;

export type ParsedBotPackage = PackageDocumentV1;
export type BotPackageDefinition = ParsedBotPackage["package"];
export type BotPackageAgent = BotPackageDefinition["agents"][number];
export type BotPackagePlaybook = NonNullable<BotPackageDefinition["playbooks"]>[number];
export type BotPackageSkill = NonNullable<BotPackageDefinition["skills"]>["entries"][number];

export function isBotPackage(value: unknown): boolean {
  return isPackageDocument(value);
}

/** Parse and cross-reference one complete v1 package. Unknown fields are
 * stripped; ids, grants, credentials, paths, model selections, and runtime
 * state therefore cannot ride through the package boundary. v2 documents
 * go through parsePackageDocument instead. */
export function parseBotPackage(value: JsonValue | ParsedBotPackage): ParsedBotPackage {
  return parsePackageV1(value);
}

const list = (values: string[]) => values.map((value) => `- ${value}`).join("\n");
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function intervalScheduleText(
  schedule: Extract<NonNullable<BotPackageDefinition["routines"]>[number]["schedule"], { type: "interval" }>,
): string {
  const restrictions = [
    schedule.weekdays?.length
      ? `on ${schedule.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ")}`
      : null,
    schedule.window ? `during ${schedule.window.start}–${schedule.window.end}` : null,
    schedule.endsAt !== undefined ? `until ${new Date(schedule.endsAt).toISOString()}` : null,
  ].filter((part): part is string => part !== null);
  const cadence = `every ${schedule.everyMinutes} minutes from ${new Date(schedule.anchorAt).toISOString()}`;
  return restrictions.length ? `${cadence}; ${restrictions.join("; ")}` : cadence;
}

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
        : routine.schedule.type === "cron"
          ? `${cronScheduleLabel(routine.schedule)} (\`${routine.schedule.expression}\`)`
        : routine.schedule.type === "interval"
          ? intervalScheduleText(routine.schedule)
          : `once at ${routine.schedule.at}`
    }  `,
    `**Run limit:** ${routine.timeoutMinutes === undefined ? "none" : `${routine.timeoutMinutes} minutes`}  `,
    `**While busy:** ${routine.overlap === "queue" ? "queue one scheduled run" : "skip scheduled occurrences"}  `,
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

  const markdown = `---\n${frontmatter}\n---\n\n# ${pkg.name}\n\n${pkg.tagline}\n\n> **Give this file to your Chief of Staff.** It is the complete team blueprint. Any agent system can run it; OpenMausBot can also install it directly.\n\n## Activation\n\nYou are the Chief of Staff for this blueprint. Read the whole document before acting. Confirm the user's goal and any missing inputs, then create or delegate to the specialist roles below. Preserve their names, ownership, boundaries, shared-room rules, and playbooks. If your platform cannot literally spawn agents, perform the roles one at a time and keep their outputs clearly separated.\n\nNever request pasted passwords or secret keys. Use the platform's normal connection flow. Do not send messages, publish content, spend money, delete data, or enable a schedule without the user's explicit approval. All routines start paused.\n\n## Mission\n\n${pkg.summary}\n\n## Outcomes\n\n${list(pkg.outcomes)}\n\n## Connections\n\n${connections}\n\n## Team\n\n${agents}\n\n## Chief of Staff\n\nThe Chief of Staff role is \`${pkg.chiefOfStaff ?? pkg.agents[0].key}\`. This role owns delegation, synthesis, conflict resolution, and the final answer to the user.\n${rooms ? `\n## Shared rooms\n\n${rooms}\n` : ""}${routines ? `\n## Suggested routines\n\n${routines}\n` : ""}${playbooks ? `\n## Playbooks\n\n${playbooks}\n` : ""}${examples ? `\n## Example job\n\n${examples}\n` : ""}\n## Completion rule\n\nReturn one clear result to the user, distinguish evidence from inference, cite source links when the work uses external material, and state what still needs human approval or a connected app.\n`;
  if (utf8Bytes(markdown) > BOT_PACKAGE_MARKDOWN_MAX_BYTES) throw new Error("The bot playbook is too large");
  return markdown;
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
