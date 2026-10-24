import { parseBotPackage, type BotPackageDefinition, type BotPackagePlaybook, type BotPackageSkill, type ParsedBotPackage } from "./bot-package.ts";
import type { DefaultsPreset, PublishedLibrary } from "./presets.ts";
import type { PublishedTeam } from "./published-teams.ts";
import { nextPatchRelease } from "./published-teams.ts";
import type { Routine } from "./routines.ts";
import type { BotRecord, GroupRecord, InstalledPlaybook } from "./store.ts";
import {
  AGENT_MAX_SKILLS,
  AVATAR_MAX_BYTES,
  decodeBase64,
  PACKAGE_FORMAT,
  PACKAGE_MAX_SKILLS,
  PACKAGE_VERSION,
  PackageFormatError,
  parsePackageDocument,
  pictureMatchesMime,
  RELEASE_NOTES_MAX,
  redactPackageSecrets,
  SEED_FILE_MAX_BYTES,
  SEED_MAX_BYTES,
  SEED_MAX_FILES,
  utf8Bytes,
  type PackageAgent,
  type PackageConnection,
  type PackageDefinition,
  type PackageDocument,
  type PackagePreset,
  type PackageRoom,
  type PackageRoutine,
  type PackageRoutineSchedule,
} from "../shared/package-format.ts";
import type { MascotProfile } from "../shared/mascot-profile.ts";

function portableMascotProfile(profile: MascotProfile): NonNullable<PackageAgent["appearance"]["mascotProfile"]> {
  return {
    version: profile.version,
    shapes: profile.shapes.map((shape) => ({
      ...shape,
      outline: shape.outline.map(([x, y]): [number, number] => [x, y]),
      anchor: { ...shape.anchor },
    })),
    selected: { ...profile.selected },
  };
}

function portableKey(value: string, fallback: string, used: Set<string>): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || fallback;
  let key = stem;
  for (let suffix = 2; used.has(key); suffix++) key = `${stem}-${suffix}`;
  used.add(key);
  return key;
}

/** An Auto room is written as its lead: older apps refuse a package with an `auto` kind. */
function packageRoomResponder(
  responder: GroupRecord["defaultResponder"],
  keys: ReadonlyMap<string, string>,
  members: readonly string[],
): { kind: "agent"; agent: string } | { kind: "everyone" } | { kind: "mentions" } {
  if (responder.kind === "member" && keys.has(responder.botId)) return { kind: "agent", agent: keys.get(responder.botId)! };
  if (responder.kind === "everyone") return { kind: "everyone" };
  if (responder.kind === "auto") {
    const lead = responder.fallbackBotId ? keys.get(responder.fallbackBotId) : undefined;
    return { kind: "agent", agent: lead ?? members[0]! };
  }
  return { kind: "mentions" };
}

function samePlaybook(a: InstalledPlaybook, b: BotPackagePlaybook): boolean {
  return a.name === b.name && a.summary === b.summary && a.instructions === b.instructions &&
    a.triggers.join("\n") === b.triggers.join("\n");
}

export interface ExportablePackageSkill extends Omit<BotPackageSkill, "name" | "description"> {
  name: string;
  description: string;
  enabled?: boolean;
}

function sameSkill(a: ExportablePackageSkill, b: ExportablePackageSkill): boolean {
  return a.instructions === b.instructions && a.description === b.description &&
    a.source === b.source && a.license === b.license && a.compatibility === b.compatibility;
}

function assignPlaybooks(bots: readonly BotRecord[], idToKey: ReadonlyMap<string, string>) {
  const playbooks: BotPackagePlaybook[] = [];
  const playbookKeys = new Set<string>();
  const agentPlaybooks = new Map<string, string[]>();
  for (const bot of bots) {
    const agentKey = idToKey.get(bot.id)!;
    const assigned: string[] = [];
    for (const playbook of bot.playbooks ?? []) {
      const existing = playbooks.find((candidate) => candidate.key === playbook.key);
      if (existing && samePlaybook(playbook, existing)) {
        assigned.push(existing.key);
        continue;
      }
      let key = playbook.key;
      if (existing) key = `${agentKey}-${playbook.key}`;
      key = portableKey(key, `${agentKey}-playbook`, playbookKeys);
      if (!playbooks.some((candidate) => candidate.key === key)) playbooks.push({ ...playbook, key });
      assigned.push(key);
    }
    agentPlaybooks.set(bot.id, assigned);
  }
  return { playbooks, agentPlaybooks };
}

function assignSkills(bots: readonly BotRecord[], skillsByBot?: ReadonlyMap<string, readonly ExportablePackageSkill[]>) {
  const packageSkills = new Map<string, ExportablePackageSkill>();
  const agentSkills = new Map<string, string[]>();
  for (const bot of bots) {
    const assignedSkills: string[] = [];
    for (const skill of skillsByBot?.get(bot.id) ?? []) {
      const existing = packageSkills.get(skill.name);
      if (existing && !sameSkill(existing, skill)) {
        throw new Error(`Skill "${skill.name}" has conflicting content across selected bots`);
      }
      if (!existing) {
        const { enabled: _enabled, ...entry } = skill;
        packageSkills.set(skill.name, entry);
      }
      if (!assignedSkills.includes(skill.name)) assignedSkills.push(skill.name);
    }
    agentSkills.set(bot.id, assignedSkills);
  }
  return { packageSkills, agentSkills };
}

function requiredApps(bots: readonly BotRecord[]) {
  const requirements = new Map<string, { slug: string; label: string; reason: string; optional?: boolean }>();
  for (const bot of bots) {
    for (const app of bot.installedPackage?.requiredApps ?? []) {
      if (!requirements.has(app.slug)) requirements.set(app.slug, { ...app });
    }
  }
  return requirements;
}

/** A limit-reset schedule waits for this computer's engine sign-in, so it never travels in a package. */
const portable = (routine: Routine) => routine.schedule.type !== "limit_reset";

function portableSchedule(schedule: Routine["schedule"]): PackageRoutineSchedule {
  if (schedule.type === "limit_reset") throw new Error("A limit-reset schedule is not portable");
  if (schedule.type === "once") return { type: "once", at: schedule.at };
  if (schedule.type === "cron") return { ...schedule };
  if (schedule.type === "interval") {
    return {
      type: "interval",
      everyMinutes: schedule.everyMinutes,
      anchorAt: schedule.anchorAt,
      ...(schedule.weekdays === undefined ? {} : { weekdays: [...schedule.weekdays] }),
      ...(schedule.window === undefined ? {} : { window: { ...schedule.window } }),
      ...(schedule.endsAt === undefined ? {} : { endsAt: schedule.endsAt }),
    };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

/** A workspace definition, never runtime state: no grants, credentials, approvals, transcripts, memory, paths or engines. */
export function createBotPackageExport(input: {
  name: string;
  authorName?: string;
  bots: BotRecord[];
  groups: GroupRecord[];
  routines: Routine[];
  skillsByBot?: ReadonlyMap<string, readonly ExportablePackageSkill[]>;
}): ParsedBotPackage {
  const bots = input.bots.filter((bot) => !bot.hidden);
  if (!bots.length) throw new Error("Create a bot before exporting your package");

  const packageKeys = new Set<string>();
  const idToKey = new Map<string, string>();
  for (const [index, bot] of bots.entries()) {
    idToKey.set(bot.id, portableKey(bot.name, `bot-${index + 1}`, packageKeys));
  }

  const { playbooks, agentPlaybooks } = assignPlaybooks(bots, idToKey);
  const { packageSkills, agentSkills } = assignSkills(bots, input.skillsByBot);
  const requirements = requiredApps(bots);

  const roomKeys = new Set<string>();
  const rooms: NonNullable<BotPackageDefinition["rooms"]> = [];
  for (const [index, group] of input.groups.filter((group) => !group.dm).entries()) {
    const members = group.memberIds.flatMap((id) => idToKey.has(id) ? [idToKey.get(id)!] : []);
    if (!members.length) continue;
    const defaultResponder = packageRoomResponder(group.defaultResponder, idToKey, members);
    rooms.push({
      key: portableKey(group.name, `room-${index + 1}`, roomKeys),
      name: group.name,
      members,
      bulletin: group.bulletin,
      defaultResponder,
    });
  }

  const routineKeys = new Set<string>();
  const routines: NonNullable<BotPackageDefinition["routines"]> = input.routines.flatMap((routine, index) => {
    if (routine.target === "room-goal" || !portable(routine)) return [];
    const agent = idToKey.get(routine.botId);
    if (!agent) return [];
    return [{
      key: portableKey(routine.name, `routine-${index + 1}`, routineKeys),
      name: routine.name,
      agent,
      prompt: routine.prompt,
      runOn: routine.runOn,
      schedule: portableSchedule(routine.schedule),
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      ...(routine.overlap === "queue" ? { overlap: "queue" as const } : {}),
      enabledAfterInstall: false as const,
    }];
  });

  const id = portableKey(input.name, "openmaus-package", new Set());
  const agents: BotPackageDefinition["agents"] = bots.map((bot) => {
    const appearance: BotPackageDefinition["agents"][number]["appearance"] = { color: bot.color };
    if (bot.mascotExpression) appearance.mascotExpression = bot.mascotExpression;
    if (bot.mascotBody) appearance.mascotBody = bot.mascotBody;
    if (bot.mascotProfile?.shapes.length) appearance.mascotProfile = portableMascotProfile(bot.mascotProfile);
    const agent: BotPackageDefinition["agents"][number] = {
      key: idToKey.get(bot.id)!,
      name: bot.name,
      title: bot.title,
      description: bot.description,
      ...(bot.soul !== undefined ? { soul: bot.soul } : {}),
      appearance,
    };
    const assigned = agentPlaybooks.get(bot.id);
    if (assigned?.length) agent.playbooks = assigned;
    const assignedSkills = agentSkills.get(bot.id);
    if (assignedSkills?.length) agent.skills = assignedSkills;
    return agent;
  });
  const definition: BotPackageDefinition = {
    id,
    release: "1.0.0",
    name: input.name,
    tagline: `A portable OpenMausBot setup with ${bots.length} ${bots.length === 1 ? "bot" : "bots"}.`,
    summary: "Exported from OpenMausBot. Review the roles, rooms, playbooks, connector requirements, and paused routines before sharing or publishing.",
    category: "Community",
    author: { name: input.authorName?.trim() || "OpenMausBot user" },
    license: "Unspecified",
    outcomes: ["Recreate this bot setup without copying private runtime state."],
    setupMinutes: Math.min(240, Math.max(2, bots.length + requirements.size * 2)),
    requirements: { apps: [...requirements.values()], capabilities: [] },
    agents,
  };
  const chief = bots.find((bot) => bot.chiefOfStaff);
  if (chief) definition.chiefOfStaff = idToKey.get(chief.id)!;
  if (rooms.length) definition.rooms = rooms;
  if (routines.length) definition.routines = routines;
  if (playbooks.length) definition.playbooks = playbooks;
  if (packageSkills.size) {
    definition.skills = {
      version: 1,
      entries: [...packageSkills.values()].map((skill) => ({ ...skill })),
    };
  }
  return parseBotPackage({
    format: "openmaus.package",
    version: 1,
    package: definition,
  });
}

export type TeamExportSkipReason =
  | "picture_too_large"
  | "picture_invalid"
  | "stdio_server"
  | "insecure_address"
  | "files_not_shared"
  | "lead_not_in_group_chat"
  | "notes_too_large"
  | "skill_changed"
  | "skill_conflict"
  | "bot_skill_limit"
  | "team_skill_limit"
  | "preset_empty"
  | "preset_skill_conflict";

export interface TeamExportSkip { part: string; reason: TeamExportSkipReason }

export class TeamExportError extends Error {
  readonly status = 400;
}

export const TEAM_TOO_LARGE_MESSAGE = "This department is too large to share (4 MB). Leave out pictures, starter notes or some skills and try again.";

export interface TeamExportInput {
  team: string;
  name?: string;
  tagline?: string;
  summary?: string;
  release?: string;
  notes?: string;
  authorName?: string;
  bots: readonly BotRecord[];
  groups: readonly GroupRecord[];
  routines: readonly Routine[];
  brief?: string;
  published: PublishedTeam | null;
  skillsByBot?: ReadonlyMap<string, readonly ExportablePackageSkill[]>;
  skillSelection?: "all" | "chosen";
  memoryByBot?: ReadonlyMap<string, ReadonlyArray<{ path: string; text: string }>>;
  avatars?: Readonly<Record<string, unknown>>;
  mcpServers?: Readonly<Record<string, unknown>>;
  skipped?: readonly TeamExportSkip[];
  preset?: DefaultsPreset | null;
}

export interface TeamExportResult {
  document: PackageDocument;
  filename: string;
  redacted: string[];
  skipped: TeamExportSkip[];
  published: PublishedTeam;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const CONNECTION_KEY = /^[a-z][a-z0-9_-]{0,27}$/;
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

const teamOf = (section?: string) => section?.trim() ?? "";

function stableKeys<T extends { id: string; name: string }>(
  records: readonly T[],
  recorded: Readonly<Record<string, string>> | undefined,
  installed: (record: T) => string | undefined,
  fallback: string,
): Map<string, string> {
  const used = new Set<string>();
  const keys = new Map<string, string>();
  const claim = (record: T, key: string | undefined) => {
    if (keys.has(record.id) || !key || key.length > 64 || !KEY_PATTERN.test(key) || used.has(key)) return;
    keys.set(record.id, key);
    used.add(key);
  };
  for (const record of records) claim(record, recorded?.[record.id]);
  for (const record of records) claim(record, installed(record));
  const taken = new Set([...used, ...Object.values(recorded ?? {})]);
  for (const [index, record] of records.entries()) {
    if (!keys.has(record.id)) keys.set(record.id, portableKey(record.name, `${fallback}-${index + 1}`, taken));
  }
  return keys;
}

export function picture(value: unknown): { mime: "image/png" | "image/jpeg" | "image/webp"; data: string } | "picture_invalid" | "picture_too_large" {
  const match = typeof value === "string" ? DATA_URL.exec(value) : null;
  if (!match) return "picture_invalid";
  const bytes = decodeBase64(match[2]!);
  if (!bytes) return "picture_invalid";
  if (bytes.length > AVATAR_MAX_BYTES) return "picture_too_large";
  if (!pictureMatchesMime(bytes, match[1]!)) return "picture_invalid";
  return { mime: match[1] as "image/png" | "image/jpeg" | "image/webp", data: match[2]! };
}

function remoteServer(raw: unknown): { transport: "http" | "sse"; url: string; valueNames: string[] } | "stdio" | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const server = raw as { url?: unknown; type?: unknown; headers?: unknown; command?: unknown };
  if (typeof server.url !== "string") return typeof server.command === "string" ? "stdio" : null;
  const headers = server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) ? Object.keys(server.headers) : [];
  return { transport: server.type === "sse" ? "sse" : "http", url: server.url, valueNames: headers };
}

function sharableAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)));
  } catch {
    return false;
  }
}

const TOKEN_RUN = /[A-Za-z0-9_-]{16,}/g;
const NAME_WORD = /^[A-Za-z]*\d{0,4}$/;

function keyShaped(piece: string): boolean {
  let text = piece;
  try {
    text = decodeURIComponent(piece);
  } catch {
  }
  return (text.match(TOKEN_RUN) ?? []).some((run) => {
    if (/[A-Za-z]{24,}|\d{24,}/.test(run)) return true;
    if (!/[A-Za-z]/.test(run) || !/\d/.test(run)) return false;
    const words = run.split(/[-_]+/).filter(Boolean);
    return !(words.length > 1 && words.every((word) => NAME_WORD.test(word)));
  });
}

export const ADDRESS_KEY_PLACEHOLDER = "redacted";

/** A segment with a key-shaped part is replaced whole, so no piece of a key split by ":" or ";" is left behind. */
function shareableSegment(segment: string): string {
  const parts = segment.split(";");
  if (parts.some((part) => keyShaped(part.split("=")[0]!))) return ADDRESS_KEY_PLACEHOLDER;
  return parts.map((part) => (part.includes("=") ? `${part.slice(0, part.indexOf("="))}=` : part)).join(";");
}

/** Hosted MCP servers often carry their credential in the address, where text redaction does not look. */
export function shareableAddress(value: string): { url: string; changed: boolean } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { url: value, changed: false };
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  if (url.hash) {
    url.hash = "";
    changed = true;
  }
  const labels = url.hostname.split(".");
  const hostLabels = labels.map((label, index) => (index < labels.length - 2 && keyShaped(label) ? ADDRESS_KEY_PLACEHOLDER : label));
  if (hostLabels.some((label, index) => label !== labels[index])) {
    url.hostname = hostLabels.join(".");
    changed = true;
  }
  const params = [...url.searchParams];
  const names = params.map(([name]) => (keyShaped(name) ? ADDRESS_KEY_PLACEHOLDER : name));
  if (params.some(([name, value], index) => value || names[index] !== name)) {
    url.search = new URLSearchParams(names.map((name) => [name, ""])).toString();
    changed = true;
  }
  const segments = url.pathname.split("/");
  const shareable = segments.map(shareableSegment);
  if (shareable.some((segment, index) => segment !== segments[index])) {
    url.pathname = shareable.join("/");
    changed = true;
  }
  return changed ? { url: url.toString(), changed } : { url: value, changed };
}

function fitSkills(
  bots: readonly BotRecord[],
  botKeys: ReadonlyMap<string, string>,
  skillsByBot: ReadonlyMap<string, readonly ExportablePackageSkill[]> | undefined,
  skipped: TeamExportSkip[],
): Map<string, ExportablePackageSkill[]> {
  const firstByName = new Map<string, ExportablePackageSkill>();
  const conflicted = new Set<string>();
  for (const bot of bots) {
    for (const skill of skillsByBot?.get(bot.id) ?? []) {
      const first = firstByName.get(skill.name);
      if (!first) firstByName.set(skill.name, skill);
      else if (!sameSkill(first, skill)) conflicted.add(skill.name);
    }
  }
  for (const name of [...conflicted].sort()) skipped.push({ part: `skills[${name}]`, reason: "skill_conflict" });
  const on = (skill: ExportablePackageSkill) => skill.enabled !== false;
  const fitted = new Map<string, ExportablePackageSkill[]>();
  for (const bot of bots) {
    const own = (skillsByBot?.get(bot.id) ?? []).filter((skill) => !conflicted.has(skill.name));
    const ranked = [...own].sort((a, b) => Number(on(b)) - Number(on(a)) || a.name.localeCompare(b.name));
    for (const skill of ranked.slice(AGENT_MAX_SKILLS)) {
      skipped.push({ part: `agents[${botKeys.get(bot.id)}].skills[${skill.name}]`, reason: "bot_skill_limit" });
    }
    const kept = new Set(ranked.slice(0, AGENT_MAX_SKILLS).map((skill) => skill.name));
    fitted.set(bot.id, own.filter((skill) => kept.has(skill.name)));
  }
  const names = new Map<string, boolean>();
  for (const list of fitted.values()) {
    for (const skill of list) names.set(skill.name, names.get(skill.name) === true || on(skill));
  }
  if (names.size > PACKAGE_MAX_SKILLS) {
    const ranked = [...names].sort(([a, aOn], [b, bOn]) => Number(bOn) - Number(aOn) || a.localeCompare(b));
    const left = new Set(ranked.slice(PACKAGE_MAX_SKILLS).map(([name]) => name));
    for (const name of [...left].sort()) skipped.push({ part: `skills[${name}]`, reason: "team_skill_limit" });
    for (const [id, list] of fitted) fitted.set(id, list.filter((skill) => !left.has(skill.name)));
  }
  return fitted;
}

function refuseSkillConflicts(bots: readonly BotRecord[], skillsByBot: ReadonlyMap<string, readonly ExportablePackageSkill[]> | undefined) {
  const firstByName = new Map<string, ExportablePackageSkill>();
  for (const bot of bots) {
    for (const skill of skillsByBot?.get(bot.id) ?? []) {
      const first = firstByName.get(skill.name);
      if (!first) firstByName.set(skill.name, skill);
      else if (!sameSkill(first, skill)) {
        throw new TeamExportError(`Two bots in this department have different skills named "${skill.name}". Leave that skill out and try again.`);
      }
    }
  }
}

/** One team without its chat history; every text part is redacted and the result goes through the import parser. */
export function createTeamPackageExport(input: TeamExportInput): TeamExportResult {
  const team = teamOf(input.team);
  const bots = input.bots.filter((bot) => !bot.hidden && teamOf(bot.section) === team);
  if (!bots.length) throw new TeamExportError("Add a bot to this department before sharing it.");
  const skipped: TeamExportSkip[] = [...(input.skipped ?? [])];

  const release = input.release?.trim() || nextPatchRelease(input.published?.lastRelease);
  if (!SEMVER.test(release)) throw new TeamExportError("Use a version like 1.2.3.");
  const notes = input.notes?.trim();
  if (notes && notes.length > RELEASE_NOTES_MAX) throw new TeamExportError(`Release notes must be at most ${RELEASE_NOTES_MAX} characters.`);
  const displayName = input.name?.trim() || team || "General";

  const installedIds = new Set(bots.map((bot) => bot.installedPackage?.id));
  const inherited = installedIds.size === 1 ? [...installedIds][0] : undefined;
  const packageId = input.published?.packageId ?? inherited ?? portableKey(team || displayName, "team", new Set());
  const recorded = input.published?.packageId === packageId ? input.published.keys : undefined;

  const botKeys = stableKeys(bots, recorded?.bots,
    (bot) => (bot.installedPackage?.id === packageId ? bot.installedPackage.agentKey : undefined), "bot");
  const { playbooks, agentPlaybooks } = assignPlaybooks(bots, botKeys);
  let skillsByBot = input.skillsByBot;
  if (input.skillSelection === "all") skillsByBot = fitSkills(bots, botKeys, skillsByBot, skipped);
  else refuseSkillConflicts(bots, skillsByBot);
  const { packageSkills, agentSkills } = assignSkills(bots, skillsByBot);
  if (packageSkills.size > PACKAGE_MAX_SKILLS) {
    throw new TeamExportError(`A department can share at most ${PACKAGE_MAX_SKILLS} skills. Choose fewer skills and try again.`);
  }
  const crowded = bots.find((bot) => (agentSkills.get(bot.id)?.length ?? 0) > AGENT_MAX_SKILLS);
  if (crowded) throw new TeamExportError(`${crowded.name} has more than ${AGENT_MAX_SKILLS} skills. Choose fewer skills and try again.`);
  const requirements = requiredApps(bots);

  // Addresses and header names only; values stay on this computer.
  const connections: PackageConnection[] = [];
  const connectionKeyByServer = new Map<string, string>();
  const connectionUsers = new Map<string, string[]>();
  const connectionKeys = new Set<string>();
  const agentConnections = new Map<string, string[]>();
  const addressRedactions: string[] = [];
  for (const bot of bots) {
    const assigned: string[] = [];
    for (const name of bot.mcpServers ?? []) {
      if (!connectionKeyByServer.has(name)) {
        const server = remoteServer(input.mcpServers?.[name]);
        if (!server) continue;
        const part = `connections[${name}]`;
        if (server === "stdio") {
          if (!skipped.some((skip) => skip.part === part)) skipped.push({ part, reason: "stdio_server" });
          continue;
        }
        if (!sharableAddress(server.url)) {
          if (!skipped.some((skip) => skip.part === part)) skipped.push({ part, reason: "insecure_address" });
          continue;
        }
        let key = CONNECTION_KEY.test(name) ? name : portableKey(name, "connection", new Set()).replace(/^[^a-z]+/, "").slice(0, 28) || "connection";
        const stem = key.slice(0, 25);
        for (let suffix = 2; connectionKeys.has(key); suffix++) key = `${stem}-${suffix}`;
        connectionKeys.add(key);
        connectionKeyByServer.set(name, key);
        const address = shareableAddress(server.url);
        if (address.changed) addressRedactions.push(`connections[${key}].mcp.url`);
        connections.push({
          key,
          label: name.slice(0, 100),
          reason: "",
          mcp: { transport: server.transport, url: address.url, valueNames: server.valueNames },
        });
      }
      const key = connectionKeyByServer.get(name);
      if (!key) continue;
      if (!assigned.includes(key)) assigned.push(key);
      connectionUsers.set(key, [...(connectionUsers.get(key) ?? []), bot.name]);
    }
    agentConnections.set(bot.id, assigned);
  }
  for (const connection of connections) {
    connection.reason = `Used by ${[...new Set(connectionUsers.get(connection.key) ?? [])].join(", ")}`.slice(0, 240);
  }

  const agents: PackageAgent[] = bots.map((bot) => {
    const key = botKeys.get(bot.id)!;
    const appearance: PackageAgent["appearance"] = { color: bot.color };
    if (bot.mascotExpression) appearance.mascotExpression = bot.mascotExpression;
    if (bot.mascotBody) appearance.mascotBody = bot.mascotBody;
    if (bot.mascotProfile?.shapes.length) appearance.mascotProfile = portableMascotProfile(bot.mascotProfile);
    const offered = input.avatars?.[bot.id];
    if (offered !== undefined) {
      const crop = bot.avatarCrop === "rounded" || bot.avatarCrop === "square" ? bot.avatarCrop : "circle";
      const prepared = picture(offered);
      if (typeof prepared === "string") skipped.push({ part: `agents[${key}].appearance.avatar`, reason: prepared });
      else appearance.avatar = { ...prepared, crop };
    }
    const agent: PackageAgent = {
      key,
      name: bot.name,
      title: bot.title || undefined,
      description: bot.description || undefined,
      ...(bot.soul ? { soul: bot.soul } : {}),
      appearance,
      ...(bot.recordBrowserSteps === true ? { recordBrowserSteps: true } : {}),
    };
    const assignedPlaybooks = agentPlaybooks.get(bot.id);
    if (assignedPlaybooks?.length) agent.playbooks = assignedPlaybooks;
    const assignedSkills = agentSkills.get(bot.id);
    if (assignedSkills?.length) agent.skills = assignedSkills;
    const assignedConnections = agentConnections.get(bot.id);
    if (assignedConnections?.length) agent.connections = assignedConnections;
    const memory: Record<string, string> = {};
    let files = 0;
    let total = 0;
    for (const note of input.memoryByBot?.get(bot.id) ?? []) {
      if (!note.text.trim()) continue;
      const bytes = utf8Bytes(note.text);
      if (bytes > SEED_FILE_MAX_BYTES || files >= SEED_MAX_FILES || total + bytes > SEED_MAX_BYTES) {
        skipped.push({ part: `agents[${key}].seed.memory[${JSON.stringify(note.path)}]`, reason: "notes_too_large" });
        continue;
      }
      memory[note.path] = note.text;
      files += 1;
      total += bytes;
    }
    if (files) agent.seed = { memory };
    return agent;
  });

  const groups = input.groups.filter((group) => !group.dm && teamOf(group.section) === team);
  const roomKeys = stableKeys(groups, recorded?.rooms, () => undefined, "group-chat");
  const rooms: PackageRoom[] = [];
  const roomMembers = new Map<string, Set<string>>();
  for (const group of groups) {
    const members = group.memberIds.flatMap((id) => botKeys.has(id) ? [botKeys.get(id)!] : []);
    if (!members.length) continue;
    const defaultResponder = packageRoomResponder(group.defaultResponder, botKeys, members);
    const key = roomKeys.get(group.id)!;
    rooms.push({ key, name: group.name, members, ...(group.bulletin ? { bulletin: group.bulletin } : {}), defaultResponder });
    roomMembers.set(group.id, new Set(members));
  }

  const owned = input.routines.filter((routine) => botKeys.has(routine.botId) && portable(routine) &&
    (routine.target !== "room-goal" || (routine.groupId !== undefined && roomMembers.has(routine.groupId))));
  const routineKeys = stableKeys(owned, recorded?.routines, () => undefined, "routine");
  const routines: PackageRoutine[] = owned.flatMap((routine) => {
    const key = routineKeys.get(routine.id)!;
    const agent = botKeys.get(routine.botId)!;
    const goal = routine.target === "room-goal";
    if (goal && !roomMembers.get(routine.groupId!)!.has(agent)) {
      skipped.push({ part: `routines[${key}]`, reason: "lead_not_in_group_chat" });
      return [];
    }
    if (routine.attachments?.length) skipped.push({ part: `routines[${key}].attachments`, reason: "files_not_shared" });
    return [{
      key,
      name: routine.name,
      agent,
      ...(goal ? { room: roomKeys.get(routine.groupId!)! } : {}),
      prompt: routine.prompt,
      runOn: goal ? "maus" as const : routine.runOn,
      schedule: portableSchedule(routine.schedule),
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      ...(routine.overlap === "queue" ? { overlap: "queue" as const } : {}),
      ...(!goal && routine.continuity ? { continuity: true } : {}),
      ...(routine.runOnStartup ? { runOnStartup: true } : {}),
      enabledAfterInstall: routine.enabled,
    }];
  });

  const chief = bots.find((bot) => bot.chiefOfStaff);
  const brief = input.brief?.trim() ? input.brief : undefined;
  const definition: PackageDefinition = {
    id: packageId,
    release,
    name: displayName,
    tagline: input.tagline?.trim() || `A portable OpenMausBot team with ${bots.length} ${bots.length === 1 ? "bot" : "bots"}.`,
    summary: input.summary?.trim() ||
      "Shared from OpenMausBot. Bots, skills, group chats and routines arrive as new copies; routines start paused and chat history never travels.",
    ...(notes ? { notes } : {}),
    category: "Community",
    author: { name: input.authorName?.trim() || "OpenMausBot user" },
    license: "Unspecified",
    outcomes: ["Recreate this team without copying chat history or private settings."],
    setupMinutes: Math.min(240, Math.max(2, bots.length + requirements.size * 2 + connections.length * 2)),
    requirements: { apps: [...requirements.values()], capabilities: [] },
    team: {
      name: (team || displayName).slice(0, 60).trim(),
      ...(brief ? { brief } : {}),
      ...(chief ? { leader: botKeys.get(chief.id)! } : {}),
    },
    agents,
  };
  if (rooms.length) definition.rooms = rooms;
  if (routines.length) definition.routines = routines;
  if (playbooks.length) definition.playbooks = playbooks;
  if (input.preset) definition.presets = [withPresetSkills(input.preset, packageSkills, skipped)];
  if (packageSkills.size) definition.skills = { version: 1, entries: [...packageSkills.values()].map((skill) => ({ ...skill })) };
  if (connections.length) definition.connections = connections;

  const { document: redactedDocument, redacted } = redactPackageSecrets({
    format: PACKAGE_FORMAT, version: PACKAGE_VERSION, package: definition,
  } as PackageDocument);
  let document: PackageDocument;
  try {
    document = parsePackageDocument(redactedDocument, { trust: "file" });
  } catch (error) {
    if (error instanceof PackageFormatError && error.code === "too_large") throw new TeamExportError(TEAM_TOO_LARGE_MESSAGE);
    throw new TeamExportError(error instanceof Error ? error.message : "This department could not be shared.");
  }
  const toRecord = (keys: ReadonlyMap<string, string>, include: (id: string) => boolean) =>
    Object.fromEntries([...keys].filter(([id]) => include(id)));
  const exportedRooms = new Set(rooms.map((room) => room.key));
  const exportedRoutines = new Set(routines.map((routine) => routine.key));
  return {
    document,
    filename: `${document.package.id}-${document.package.release}.openmaus.json`,
    redacted: [...new Set([...addressRedactions, ...redacted])],
    skipped,
    published: {
      packageId,
      lastRelease: release,
      keys: {
        bots: { ...recorded?.bots, ...toRecord(botKeys, () => true) },
        rooms: { ...recorded?.rooms, ...toRecord(roomKeys, (id) => exportedRooms.has(roomKeys.get(id)!)) },
        routines: { ...recorded?.routines, ...toRecord(routineKeys, (id) => exportedRoutines.has(routineKeys.get(id)!)) },
      },
    },
  };
}

/** Skill entries never carry their switched-on state: whoever adds the file decides by where it came from. */
function withPresetSkills(
  value: DefaultsPreset,
  packageSkills: Map<string, ExportablePackageSkill>,
  skipped: TeamExportSkip[],
): PackagePreset {
  const kept: string[] = [];
  for (const skill of value.skills) {
    const part = `presets[${value.preset.key}].skills[${skill.name}]`;
    const existing = packageSkills.get(skill.name);
    if (existing) {
      if (sameSkill(existing, skill)) kept.push(skill.name);
      else skipped.push({ part, reason: "preset_skill_conflict" });
      continue;
    }
    if (packageSkills.size >= PACKAGE_MAX_SKILLS) {
      skipped.push({ part, reason: "team_skill_limit" });
      continue;
    }
    const { enabled: _enabled, ...entry } = skill;
    packageSkills.set(skill.name, entry);
    kept.push(skill.name);
  }
  const { skills: _skills, ...preset } = value.preset;
  return { ...preset, ...(kept.length ? { skills: kept } : {}) };
}

export const PRESET_TOO_LARGE_MESSAGE = "This preset is too large to share (4 MB). Leave out starter notes or some skills and try again.";

export interface LibraryExportInput {
  name?: string;
  tagline?: string;
  summary?: string;
  release?: string;
  notes?: string;
  authorName?: string;
  published: PublishedLibrary | null;
  preset: DefaultsPreset | null;
  skipped?: readonly TeamExportSkip[];
}

export interface LibraryExportResult {
  document: PackageDocument;
  filename: string;
  redacted: string[];
  skipped: TeamExportSkip[];
  published: PublishedLibrary;
}

export function createLibraryPackageExport(input: LibraryExportInput): LibraryExportResult {
  if (!input.preset) throw new TeamExportError("Your New bot defaults are empty. Give them a name, instructions, skills or starter notes first.");
  const skipped: TeamExportSkip[] = [...(input.skipped ?? [])];
  const release = input.release?.trim() || nextPatchRelease(input.published?.lastRelease);
  if (!SEMVER.test(release)) throw new TeamExportError("Use a version like 1.2.3.");
  const notes = input.notes?.trim();
  if (notes && notes.length > RELEASE_NOTES_MAX) throw new TeamExportError(`Release notes must be at most ${RELEASE_NOTES_MAX} characters.`);
  const displayName = (input.name?.trim() || input.preset.preset.name).slice(0, 100).trim();
  const packageId = input.published?.packageId ?? portableKey(displayName, "preset", new Set());
  const packageSkills = new Map<string, ExportablePackageSkill>();
  const preset = withPresetSkills(input.preset, packageSkills, skipped);
  const definition: PackageDefinition = {
    id: packageId,
    release,
    name: displayName,
    tagline: input.tagline?.trim() || "A preset bot for OpenMausBot's New bot dialog.",
    summary: input.summary?.trim() ||
      "Shared from OpenMausBot. Adds a preset bot to New bot. Its skills arrive switched off; model choices, computers, approval levels and connected apps never travel.",
    ...(notes ? { notes } : {}),
    category: "Community",
    author: { name: input.authorName?.trim() || "OpenMausBot user" },
    license: "Unspecified",
    outcomes: ["Start new bots from a shared preset."],
    setupMinutes: 2,
    requirements: { apps: [], capabilities: [] },
    agents: [],
    presets: [preset],
  };
  if (packageSkills.size) definition.skills = { version: 1, entries: [...packageSkills.values()].map((skill) => ({ ...skill })) };
  const { document: redactedDocument, redacted } = redactPackageSecrets({
    format: PACKAGE_FORMAT, version: PACKAGE_VERSION, package: definition,
  } as PackageDocument);
  let document: PackageDocument;
  try {
    document = parsePackageDocument(redactedDocument, { trust: "file" });
  } catch (error) {
    if (error instanceof PackageFormatError && error.code === "too_large") throw new TeamExportError(PRESET_TOO_LARGE_MESSAGE);
    throw new TeamExportError(error instanceof Error ? error.message : "This preset could not be shared.");
  }
  return {
    document,
    filename: `${document.package.id}-${document.package.release}.openmaus.json`,
    redacted,
    skipped,
    published: { packageId, lastRelease: release },
  };
}
