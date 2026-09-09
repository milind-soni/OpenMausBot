import { z } from "zod";

import { schemaIssue, type JsonValue } from "./schema.ts";
import type { MausColor } from "./store.ts";
import { botMascotBody, type MascotBodyId } from "../shared/mascot-bodies.ts";
import { takeImportName } from "../shared/import-name.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";

export const TEAM_MANIFEST_FORMAT = "openmaus.team" as const;
export const TEAM_MANIFEST_VERSION = 2 as const;
export const LEGACY_TEAM_MANIFEST_VERSION = 1 as const;
export const MAX_TEAM_MEMBERS = 200;

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

const responderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), member: requiredText(64) }),
  z.object({ kind: z.literal("everyone") }),
  z.object({ kind: z.literal("mentions") }),
]);

const memberSchema = z.object({
  key: requiredText(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "may only contain lowercase letters, numbers, - and _",
  }),
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
});

const membersSchema = z
  .array(memberSchema)
  .min(1, { message: "A team needs at least one member" })
  .max(MAX_TEAM_MEMBERS, { message: `A team can have at most ${MAX_TEAM_MEMBERS} members` });

const manifestSchema = z.discriminatedUnion("version", [
  z.object({
    format: z.literal(TEAM_MANIFEST_FORMAT, { error: "This is not an OpenMaus team file" }),
    version: z.literal(LEGACY_TEAM_MANIFEST_VERSION),
    team: z.object({
      name: requiredText(100),
      description: optionalText(2_000),
      members: membersSchema,
      room: z.object({
        name: requiredText(100),
        bulletin: optionalText(12_000),
        defaultResponder: responderSchema,
      }),
    }),
  }),
  z.object({
    format: z.literal(TEAM_MANIFEST_FORMAT, { error: "This is not an OpenMaus team file" }),
    version: z.literal(TEAM_MANIFEST_VERSION),
    team: z.object({
      name: requiredText(100),
      description: optionalText(2_000),
      members: membersSchema,
    }),
  }),
]);

export interface TeamManifestMember {
  key: string;
  name: string;
  title: string;
  description: string;
  soul?: string;
  appearance: {
    color: MausColor;
    mascotExpression?: string;
    mascotBody?: string;
  };
}

export type TeamManifestResponder =
  | { kind: "member"; member: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

export interface TeamManifestRoom {
  name: string;
  bulletin: string;
  defaultResponder: TeamManifestResponder;
}

export interface ParsedTeamManifest {
  format: typeof TEAM_MANIFEST_FORMAT;
  version: typeof LEGACY_TEAM_MANIFEST_VERSION | typeof TEAM_MANIFEST_VERSION;
  team: {
    name: string;
    description?: string;
    members: TeamManifestMember[];
    /** Present on legacy v1 files. New imports intentionally do not create it. */
    room?: TeamManifestRoom;
  };
}

export interface TeamManifestV2 {
  format: typeof TEAM_MANIFEST_FORMAT;
  version: typeof TEAM_MANIFEST_VERSION;
  team: {
    name: string;
    description?: string;
    members: TeamManifestMember[];
  };
}

export type TeamManifestInput = JsonValue | ParsedTeamManifest | TeamManifestV2;

interface ExportableBot {
  id: string;
  name: string;
  title: string;
  description: string;
  soul?: string;
  color: MausColor;
  mascotExpression?: string | null;
  mascotBody?: string | null;
}

interface ExportableTeam {
  name: string;
  memberIds: string[];
}

/** Parse an untrusted shared file into the small, portable subset we support. */
export function parseTeamManifest(value: TeamManifestV2): TeamManifestV2;
export function parseTeamManifest(value: TeamManifestInput): ParsedTeamManifest;
export function parseTeamManifest(value: TeamManifestInput): ParsedTeamManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    const formatIssue = parsed.error.issues.find((issue) => issue.path[0] === "format");
    if (formatIssue) throw new Error(formatIssue.message);
    const versionIssue = parsed.error.issues.find((issue) => issue.path[0] === "version");
    if (versionIssue) throw new Error("Team file version is not supported");
    throw new Error(schemaIssue(parsed.error, "This is not a team file"));
  }

  const seenKeys = new Set<string>();
  const members = parsed.data.team.members.map((member): TeamManifestMember => {
    if (seenKeys.has(member.key)) throw new Error(`Duplicate member key: ${member.key}`);
    seenKeys.add(member.key);
    const appearance: TeamManifestMember["appearance"] = { color: member.appearance.color };
    if (member.appearance.mascotExpression) appearance.mascotExpression = member.appearance.mascotExpression;
    if (member.appearance.mascotBody) appearance.mascotBody = member.appearance.mascotBody;
    return {
      key: member.key,
      name: member.name,
      title: member.title ?? "",
      description: member.description ?? "",
      ...(member.soul !== undefined ? { soul: member.soul } : {}),
      appearance,
    };
  });

  const result: ParsedTeamManifest = {
    format: TEAM_MANIFEST_FORMAT,
    version: parsed.data.version,
    team: {
      name: parsed.data.team.name,
      members,
    },
  };
  if (parsed.data.team.description) result.team.description = parsed.data.team.description;

  if (parsed.data.version === LEGACY_TEAM_MANIFEST_VERSION) {
    const defaultResponder = parsed.data.team.room.defaultResponder;
    if (defaultResponder.kind === "member" && !seenKeys.has(defaultResponder.member)) {
      throw new Error(`Unknown default responder: ${defaultResponder.member}`);
    }
    result.team.room = {
      name: parsed.data.team.room.name,
      bulletin: parsed.data.team.room.bulletin ?? "",
      defaultResponder,
    };
  }

  return result;
}

/** What one imported member is allowed to become: persona only. */
export interface ImportedMemberProfile {
  name: string;
  title: string;
  description: string;
  soul?: string;
  color: MausColor;
  mascotExpression?: string;
  mascotBody?: MascotBodyId;
}

/** Everything an untrusted manifest may seed into a brand-new bot — and
 * nothing else.
 *
 * A team file can come from the remote catalog, a GitHub repo, or a file
 * someone shared, so import is additive-only: a manifest is a persona
 * description, never a grant, and never a handle on records the user
 * already has. Two rules are enforced here, at the single point where a
 * member becomes bot fields:
 *
 * 1. Allowlist, not blocklist. The returned object is built field by field
 *    from the parsed member, so every privilege-bearing BotRecord field —
 *    approvalMode, autoApprove, autoReview, alwaysAllow, chiefOfStaff, approvePeerComms, composio,
 *    computer, cloudBackend, cwd — is structurally absent, whatever the
 *    file claimed. parseTeamManifest already drops unknown member keys;
 *    this keeps the guarantee even if the schema grows a field later,
 *    because nothing new can reach a bot record without someone
 *    consciously widening this return type. The caller must still force
 *    composio: false on the created record — that is the one privilege
 *    where *absence* means allowed, so leaving it unset is not safe.
 *
 * 2. No name captures. Display names are identity wherever bots address
 *    each other — @mention resolution in rooms, the Chief of Staff roster,
 *    peer-approval prompts — so an imported member wearing an existing
 *    bot's name could be mentioned, granted, or listed as if it were that
 *    bot. A colliding name is therefore visibly numbered ("Scout" →
 *    "Scout 2"), the same convention the name generator uses when its pool
 *    runs out. Matching is case-insensitive because @mention matching is.
 *    `takenNames` (lowercased) is mutated as names are claimed, so one
 *    import batch also stays unique against itself; a suffixed name never
 *    exceeds the member-name cap.
 */
export function importedMemberProfile(
  member: TeamManifestMember,
  takenNames: Set<string>,
): ImportedMemberProfile {
  const name = takeImportName(member.name, takenNames);
  const profile: ImportedMemberProfile = {
    name,
    title: member.title,
    description: member.description,
    ...(member.soul !== undefined ? { soul: member.soul } : {}),
    color: member.appearance.color,
  };
  if (member.appearance.mascotExpression) profile.mascotExpression = member.appearance.mascotExpression;
  // The manifest carries the body as free text (parseTeamManifest only
  // bounds its length); an untrusted or stale value must never reach a
  // BotRecord unvalidated, so it is safe-parsed here — the one point where
  // an imported member becomes bot fields — falling back to the default
  // body rather than rejecting the whole import over a cosmetic field.
  if (member.appearance.mascotBody) profile.mascotBody = botMascotBody(member.appearance.mascotBody);
  return profile;
}

function memberKey(name: string, index: number, used: Set<string>): string {
  const stem =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `member-${index + 1}`;
  let key = stem;
  let suffix = 2;
  while (used.has(key)) key = `${stem}-${suffix++}`;
  used.add(key);
  return key;
}

/** Build a shareable definition only: no IDs, transcripts, engines or permissions. */
export function createTeamManifest(team: ExportableTeam, bots: ExportableBot[]): TeamManifestV2 {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const usedKeys = new Set<string>();
  const members = team.memberIds.map((id, index): TeamManifestMember => {
    const bot = byId.get(id);
    if (!bot) throw new Error(`Team member ${id} no longer exists`);
    const key = memberKey(bot.name, index, usedKeys);
    const appearance: TeamManifestMember["appearance"] = { color: bot.color };
    if (bot.mascotExpression) appearance.mascotExpression = bot.mascotExpression;
    if (bot.mascotBody) appearance.mascotBody = bot.mascotBody;
    return {
      key,
      name: bot.name,
      title: bot.title,
      description: bot.description,
      ...(bot.soul !== undefined ? { soul: bot.soul } : {}),
      appearance,
    };
  });

  const manifest: TeamManifestV2 = {
    format: TEAM_MANIFEST_FORMAT,
    version: TEAM_MANIFEST_VERSION,
    team: {
      name: team.name,
      members,
    },
  };
  // Keep export and import in lockstep: a file produced here must satisfy
  // the exact same limits and normalization as an untrusted shared file.
  return parseTeamManifest(manifest);
}
