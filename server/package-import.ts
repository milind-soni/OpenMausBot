// Adding a shared team to this installation.
//
// Import is additive-only. A package is untrusted input (a file someone
// sent, GitHub, the community catalog), so it is structurally unable to reach
// records the person already has: every bot, group chat, routine, section and
// connection it creates is NEW, and every privilege-bearing field is chosen
// here, never read from the file. What the file may set is persona and
// structure: names, standing instructions, looks, playbooks, skills (which
// land switched off), group chats, routines (which land paused), the team
// brief and Chief, starter notes, and connection SLOTS (an address and the
// names of values the person fills in later; never the values).
//
// `trust` is a function argument, never read from a request. The HTTP import
// route always passes "file". Only the organization library (wave 2, a
// separate module) passes "org": its skills arrive switched on because the
// organization's Admin published them, and its records carry the provenance
// the organization channel needs. Everything else is identical.
//
// A failure anywhere rolls back every record this import created.
import { createHash, randomUUID } from "node:crypto";

import { mcpServerNameError, MAX_MCP_SERVERS, parseStoredMcpServer } from "./mcp-registry.ts";
import {
  AGENT_PARTS, agentReleaseValues, connectionLocalValue, connectionReleaseValue, pair, pairs, playbookValues,
  ROOM_PARTS, roomReleaseValues, ROUTINE_PARTS, routineReleaseValues, scheduleValue, sha256Hex, TEAM_PARTS,
  type AgentPart, type PartPair, type TeamPart,
} from "./package-parts.ts";
import type { PresetRegistry } from "./presets.ts";
import type { Routine, RoutineInput, RoutineManager } from "./routines.ts";
import type { SkillListing, SkillPackageStamp } from "./skills.ts";
import type { BotRecord, GroupRecord, InstalledPackageMetadata, Store } from "./store.ts";
import { importedMemberProfile, type ParsedTeamManifest, type TeamManifestMember } from "./team-manifest.ts";
import { takeImportName } from "../shared/import-name.ts";
import { decodeBase64, type PackageAgent, type PackageDocument, type PackageTrust } from "../shared/package-format.ts";
import type { BotVisibility, ModelSelection } from "../shared/wire.ts";

export const NO_BOTS_MESSAGE = "This package has no bots. Add it from your organization's shelf, or update OpenMausBot.";
/** A file with skills only: a file never adds a skill without a bot or a preset to hold it. */
export const NO_PRESETS_MESSAGE = "This file has no bots or preset bots to add. Its skills can be added from your organization's shelf.";

export type PackageImportErrorCode = "no_bots" | "invalid_package";

/** A refusal before anything was created, as a plain sentence. */
export class PackageImportError extends Error {
  readonly status = 400;
  readonly code: PackageImportErrorCode;
  constructor(code: PackageImportErrorCode, message: string) {
    super(message);
    this.name = "PackageImportError";
    this.code = code;
  }
}

/** Why part of a package was not added. Listed to the person; not an error. */
export type ImportSkipReason =
  | "presets_not_supported_yet"
  | "connection_refused_by_policy"
  | "too_many_connections"
  | "connection_invalid"
  | "run_limit_adjusted"
  | "too_many_presets";

export interface ImportSkip { part: string; reason: ImportSkipReason }

export interface PackageImportDeps {
  store: Store;
  /** stampInstalledPackage is needed for trust "org" only. */
  routines: Pick<RoutineManager, "create" | "remove"> & Partial<Pick<RoutineManager, "stampInstalledPackage">>;
  skills: {
    install(botId: string, source: string, files: Array<{ path: string; content: string }>): SkillListing | { error: string };
    setEnabled(botId: string, name: string, enabled: boolean): SkillListing | { error: string };
    /** The organization path (skills.ts installOrgSkill): switched on, stamped. Needed for trust "org". */
    installOrg?(botId: string, source: string, skillMd: string, stamp: SkillPackageStamp): SkillListing | { error: string };
  };
  /** Starter notes go through the normal memory writers, which scrub secrets again. */
  memory: {
    writeIndex(botId: string, text: string): void;
    writeTopic(botId: string, name: string, text: string): void;
  };
  mcp: {
    servers(): Readonly<Record<string, unknown>>;
    /** The organization's MCP policy (managed desktops); undefined = allowed. */
    refusal(name: string, server: object): string | undefined;
    persist(next: Record<string, unknown>): void;
  };
  sections: { writeBrief(section: string, text: string): void };
  /** Store picture bytes as a normal local avatar; returns its avatar URL. */
  images: { save(bytes: Uint8Array, mime: string): string };
  /** Tell open windows about new records (after the import succeeded). */
  broadcast?: (event: { kind: "bot"; bot: BotRecord } | { kind: "group"; group: GroupRecord }) => void;
  /** The installation's default model: packages never carry one. */
  defaultSelection: () => ModelSelection;
  /** Preset bots (presets.ts). Absent, presets are listed as skipped and a
   * package without bots is refused, as before presets existed. */
  presets?: PresetRegistry;
}

export interface OrgImportContext {
  installId: string;
  ref: string;
  packageId: string;
  sha256: string;
  publisher: { organizationId: string; slug: string; name: string };
  adminOrigin: string;
  organizationId: string;
}

export interface PackageImportOptions {
  /** A function argument only; never read from any request. */
  trust: PackageTrust;
  mode: "add" | "project";
  /** Project mode (legacy team files): the folder the caller chose. */
  cwd?: string | null;
  /** Project mode (legacy team files): the group chat name the caller chose. */
  room?: string;
  /** Who may see the new bots: the admin's choice, never the file's. */
  visibility?: BotVisibility;
  org?: OrgImportContext;
}

/** What an organization install created, for DATA_DIR/org-library/state.json
 * (contract §3.4). Records carry their own stamps; this is the index. */
export interface OrgInstallIndex {
  kind: "team" | "library";
  section: string;
  team: { parts: Partial<Record<TeamPart, PartPair>> };
  bots: Record<string, string>;
  rooms: Record<string, string>;
  routines: Record<string, string>;
  connections: Record<string, { name: string; r: string; w: string }>;
}

export interface PackageImportResult {
  alreadyAdded: false;
  installId?: string;
  /** trust "org" only. */
  org?: OrgInstallIndex;
  name: string;
  section: string;
  bots: BotRecord[];
  groups: GroupRecord[];
  /** Project mode's new group chat (legacy team files only). */
  group?: GroupRecord;
  routines: Routine[];
  /** Skills the package offers without assigning them to a bot. */
  offeredSkills: string[];
  /** Connection slots created as MCP servers, switched off, values empty. */
  connections: Array<{ key: string; name: string; label: string }>;
  skipped: ImportSkip[];
  brief: boolean;
  /** Starter note files written. */
  notes: number;
  /** Preset bots now offered in New bot (new, or already here from the same file). */
  presets?: Array<{ id: string; key: string; name: string }>;
}

export type ImportResult = PackageImportResult | { alreadyAdded: true; installId: string };

/** Deterministic, so reconnecting to the same organization recognizes what
 * it already added. `packageId` is Admin's package UUID. */
export function orgInstallId(adminOrigin: string, organizationId: string, packageId: string): string {
  return createHash("sha256").update(`omb-install:v1\n${adminOrigin}\n${organizationId}\n${packageId}`, "utf8").digest("hex").slice(0, 32);
}

function memberFromAgent(agent: PackageAgent): TeamManifestMember {
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

/** The first free server name for a slot: key, key-2, … (never an existing
 * or reserved name, so a slot can never bind to credentials already here). */
function freeServerName(key: string, taken: Readonly<Record<string, unknown>>): string | null {
  for (let n = 1; n < 100; n += 1) {
    const name = n === 1 ? key : `${key}-${n}`;
    if (name.length > 32) return null;
    if (mcpServerNameError(name) || Object.hasOwn(taken, name)) continue;
    return name;
  }
  return null;
}

type ImportSource =
  | { kind: "package"; document: PackageDocument }
  | { kind: "manifest"; manifest: ParsedTeamManifest };

/** Add a shared team (v1 or v2, already parsed) as new records. */
export function importPackageDocument(
  document: PackageDocument,
  options: PackageImportOptions,
  deps: PackageImportDeps,
): ImportResult {
  const pkg = document.package;
  const library = !pkg.agents.length || !pkg.team;
  // A library package (skills and presets, no bots) from a file needs the preset store.
  if (library && options.trust !== "org" && !deps.presets) throw new PackageImportError("no_bots", NO_BOTS_MESSAGE);
  if (options.trust === "org") {
    const org = options.org;
    if (!org) throw new PackageImportError("invalid_package", "This package is missing its organization details.");
    if (org.installId !== orgInstallId(org.adminOrigin, org.organizationId, org.packageId)) {
      throw new PackageImportError("invalid_package", "This package's install id does not match its organization.");
    }
    if (pkg.publisher?.organization !== org.publisher.slug) {
      throw new PackageImportError("invalid_package", "This package was not published by the organization that shared it.");
    }
    if (org.ref !== `${org.publisher.slug}/${pkg.id}`) {
      throw new PackageImportError("invalid_package", "This package is not the one your organization listed.");
    }
    if (!deps.skills.installOrg || !deps.routines.stampInstalledPackage) {
      throw new PackageImportError("invalid_package", "This installation cannot add packages from an organization.");
    }
    // A bot someone made from one of the install's presets carries its
    // install id too, but it is theirs, not one of the package's records;
    // preset rows are not records either. Re-adding a removed team, or
    // retrying after a crash, re-registers its presets in place (presets.ts).
    if (deps.store.bots.some((bot) => bot.installedPackage?.installId === org.installId && !bot.installedPackage.presetKey) ||
        deps.store.groups.some((group) => group.installedPackage?.installId === org.installId)) {
      return { alreadyAdded: true, installId: org.installId };
    }
    // A library package (skills and presets, no team) creates no bots:
    // its skills are offered under Bot → Skills, its presets go to New bot,
    // and the organization library keeps the index of what it offers.
    if (library) {
      const registered = deps.presets?.register(document, { source: "org", installId: org.installId, org });
      return {
        alreadyAdded: false, installId: org.installId, name: pkg.name, section: "", bots: [], groups: [], routines: [],
        offeredSkills: (pkg.skills?.entries ?? []).map((skill) => skill.name), connections: [],
        skipped: registered?.skipped ?? (pkg.presets ?? []).map((preset) => ({ part: `presets[${preset.key}]`, reason: "presets_not_supported_yet" as const })),
        brief: false, notes: 0,
        ...(registered ? { presets: [...registered.added, ...registered.existing] } : {}),
        org: { kind: "library", section: "", team: { parts: {} }, bots: {}, rooms: {}, routines: {}, connections: {} },
      };
    }
  }
  if (library) return importLibraryFile(document, deps.presets!);
  return runImport({ kind: "package", document }, options, deps);
}

/** A preset file (skills and presets, no team): the presets go to New bot,
 * and the skills are offered (a file never installs a skill without a bot or
 * a preset to hold it). */
function importLibraryFile(document: PackageDocument, presets: PresetRegistry): PackageImportResult {
  const pkg = document.package;
  if (!pkg.presets?.length) throw new PackageImportError("no_bots", NO_PRESETS_MESSAGE);
  const installId = randomUUID();
  const registered = presets.register(document, { source: "file", installId });
  return {
    alreadyAdded: false, installId, name: pkg.name, section: "", bots: [], groups: [], routines: [],
    offeredSkills: (pkg.skills?.entries ?? []).map((skill) => skill.name), connections: [],
    skipped: registered.skipped, brief: false, notes: 0, presets: [...registered.added, ...registered.existing],
  };
}

/** Add a legacy `openmaus.team` file: people only (plus a project room when
 * the caller asks for one). */
export function importTeamManifest(
  manifest: ParsedTeamManifest,
  options: Omit<PackageImportOptions, "trust" | "org">,
  deps: PackageImportDeps,
): PackageImportResult {
  return runImport({ kind: "manifest", manifest }, { ...options, trust: "file" }, deps);
}

function runImport(source: ImportSource, options: PackageImportOptions, deps: PackageImportDeps): PackageImportResult {
  const { store } = deps;
  const pkg = source.kind === "package" ? source.document.package : null;
  const name = pkg?.name ?? (source.kind === "manifest" ? source.manifest.team.name : "");
  const teamName = pkg?.team?.name ?? name;
  const org = options.trust === "org" ? options.org : undefined;
  const installId = pkg ? org?.installId ?? randomUUID() : undefined;
  const members = pkg
    ? pkg.agents.map((agent) => ({ member: memberFromAgent(agent), agent }))
    : (source as { manifest: ParsedTeamManifest }).manifest.team.members.map((member) => ({ member, agent: undefined }));

  const importedBots: BotRecord[] = [];
  const createdGroups: GroupRecord[] = [];
  const createdRoutines: Routine[] = [];
  const createdServers: string[] = [];
  const createdPresets: string[] = [];
  const skipped: ImportSkip[] = [];
  const orgIndex: OrgInstallIndex = { kind: "team", section: "", team: { parts: {} }, bots: {}, rooms: {}, routines: {}, connections: {} };
  // Names already in use, hidden bots included: an archived bot can be
  // un-archived later, and a revived duplicate would be just as ambiguous.
  const takenNames = new Set(store.bots.map((bot) => bot.name.trim().toLowerCase()));
  const botIds = new Map<string, string>();
  let group: GroupRecord | undefined;
  let section: string | undefined;
  let notes = 0;
  try {
    const selection = deps.defaultSelection();
    const existingSections = new Set(
      [...store.sections, ...store.bots.map((bot) => bot.section), ...store.groups.map((candidate) => candidate.section)]
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim().toLowerCase()),
    );
    // Every template gets its own new section, numbered on collision. Never
    // merge into an existing section (or replace its Chief).
    section = takeImportName(teamName, existingSections, 60);

    // Connection slots first, so bots can be bound to exactly these servers.
    const serverForKey = new Map<string, string>();
    const connections: PackageImportResult["connections"] = [];
    if (pkg?.connections?.length) {
      const next: Record<string, unknown> = { ...deps.mcp.servers() };
      for (const connection of pkg.connections) {
        const part = `connections[${connection.key}]`;
        if (Object.keys(next).length >= MAX_MCP_SERVERS) {
          skipped.push({ part, reason: "too_many_connections" });
          continue;
        }
        const serverName = freeServerName(connection.key, next);
        const server = {
          type: connection.mcp.transport,
          url: connection.mcp.url,
          ...(connection.mcp.valueNames.length ? { headers: Object.fromEntries(connection.mcp.valueNames.map((header) => [header, ""])) } : {}),
          // Off until the person fills in the values and switches it on.
          enabled: false,
        };
        if (!serverName || !parseStoredMcpServer(serverName, server).ok) {
          skipped.push({ part, reason: "connection_invalid" });
          continue;
        }
        if (deps.mcp.refusal(serverName, server)) {
          skipped.push({ part, reason: "connection_refused_by_policy" });
          continue;
        }
        next[serverName] = server;
        createdServers.push(serverName);
        serverForKey.set(connection.key, serverName);
        connections.push({ key: connection.key, name: serverName, label: connection.label });
        if (org) {
          orgIndex.connections[connection.key] = { name: serverName, ...pair(connectionReleaseValue(connection), connectionLocalValue(server)) };
        }
      }
      if (createdServers.length) deps.mcp.persist(next);
    }

    const playbookByKey = new Map((pkg?.playbooks ?? []).map((playbook) => [playbook.key, playbook]));
    const skillByName = new Map((pkg?.skills?.entries ?? []).map((skill) => [skill.name, skill]));
    for (const { member, agent } of members) {
      // importedMemberProfile is the authority boundary: persona fields
      // only, colliding names numbered. seedMessages: false — an imported
      // bot must not open by greeting the user as though it were new.
      const created = store.createBot(
        {
          ...importedMemberProfile(member, takenNames),
          modelSelection: selection,
          section,
          ...(options.visibility ? { visibility: options.visibility } : {}),
        },
        { seedMessages: false },
      );
      importedBots.push(created);
      botIds.set(member.key, created.id);
      const playbooks = (agent?.playbooks ?? []).flatMap((key) => {
        const playbook = playbookByKey.get(key);
        return playbook ? [{ ...playbook }] : [];
      });
      let avatar: Partial<Pick<BotRecord, "avatarUrl" | "avatarCrop">> = {};
      let avatarHash: string | null = null;
      if (agent?.appearance.avatar) {
        const bytes = decodeBase64(agent.appearance.avatar.data);
        if (!bytes) throw new Error(`The picture for ${member.name} could not be read`);
        avatar = { avatarUrl: deps.images.save(bytes, agent.appearance.avatar.mime), avatarCrop: agent.appearance.avatar.crop };
        avatarHash = sha256Hex(bytes);
      }
      const installed: InstalledPackageMetadata | undefined = pkg
        ? {
            id: pkg.id,
            name: pkg.name,
            release: pkg.release,
            requiredApps: pkg.requirements.apps.map((app) => ({ ...app })),
            source: org ? "org" : "file",
            installId,
            agentKey: member.key,
            ...(agent?.approval ? { suggestedApproval: agent.approval } : {}),
            ...(org ? { publisher: { ...org.publisher }, ref: org.ref, sha256: org.sha256 } : {}),
          }
        : undefined;
      // composio: false — a shared persona never starts with reach into the
      // person's connected apps (absence would mean allowed). Approval is
      // never set: every imported bot starts on Ask, whatever was suggested.
      store.patchBot(created.id, {
        composio: false,
        connectorTools: {},
        ...(playbooks.length ? { playbooks } : {}),
        ...(installed ? { installedPackage: installed } : {}),
        ...(agent?.connections ? { mcpServers: agent.connections.flatMap((key) => serverForKey.has(key) ? [serverForKey.get(key)!] : []) } : {}),
        ...avatar,
      });
      for (const skillName of agent?.skills ?? []) {
        const skill = skillByName.get(skillName);
        if (!skill) throw new Error(`Package skill "${skillName}" is unavailable`);
        // A file's `source` is display provenance only; the organization
        // channel names its own source so ownership can never be forged.
        // Organization skills arrive switched on, stamped with their install.
        const added = org
          ? deps.skills.installOrg!(created.id, `org:${org.ref}@${pkg!.release}`, skill.instructions,
              { installId: org.installId, key: skill.name, release: pkg!.release, ...pair(skill.instructions, skill.instructions) })
          : deps.skills.install(created.id, skill.source ?? `package:${pkg!.id}`, [{ path: "SKILL.md", content: skill.instructions }]);
        if ("error" in added) throw new Error(`Package skill "${skillName}" could not be imported: ${added.error}`);
      }
      // Starter notes are copied once, on this first add.
      for (const [path, text] of Object.entries(agent?.seed?.memory ?? {})) {
        if (path === "MEMORY.md") deps.memory.writeIndex(created.id, text);
        else deps.memory.writeTopic(created.id, path.slice("memory/".length), text);
        notes += 1;
      }
      // An organization bot's part hashes are its last write, so a bot that
      // has them is complete (org-library.ts reads that after a crash).
      if (org && agent) {
        const written = store.bot(created.id)!;
        const local: Record<AgentPart, unknown> = {
          name: written.name,
          title: written.title ?? "",
          description: written.description ?? "",
          soul: written.soul ?? "",
          look: {
            color: written.color,
            mascotExpression: written.mascotExpression ?? null,
            mascotBody: written.mascotBody ?? null,
            avatar: avatarHash,
            crop: written.avatarCrop ?? null,
          },
          playbooks: playbookValues(written.playbooks ?? []),
          skills: [...(agent.skills ?? [])].sort(),
          connections: [...(written.mcpServers ?? [])].sort(),
          approval: "ask",
        };
        store.patchBot(created.id, { packageBase: pairs(AGENT_PARTS, agentReleaseValues(agent, playbookByKey), local) });
        orgIndex.bots[member.key] = created.id;
      }
    }

    // The brief goes before the group chats and routines, and the leader is
    // set last, so an organization Add the app stopped partway through can
    // tell a finished team from a partial one (org-library.ts).
    const brief = Boolean(pkg?.team?.brief?.trim());
    if (brief) deps.sections.writeBrief(section, pkg!.team!.brief!);

    // A package is an explicit structure import: its rooms are created from
    // package-local keys only, then normalized to the fresh bot ids.
    const groupIds = new Map<string, string>();
    for (const room of pkg?.rooms ?? []) {
      const ids = room.members.map((key) => botIds.get(key)!);
      let created = store.createGroup(room.name, ids, false, section);
      createdGroups.push(created);
      const defaultResponder = room.defaultResponder.kind === "agent"
        ? { kind: "member" as const, botId: botIds.get(room.defaultResponder.agent)! }
        : { kind: room.defaultResponder.kind } as const;
      created = store.patchGroup(created.id, {
        bulletin: room.bulletin ?? "",
        defaultResponder,
        setupCompletedAt: Date.now(),
      }) ?? created;
      groupIds.set(room.key, created.id);
      if (org) {
        const local = {
          name: created.name,
          bulletin: created.bulletin ?? "",
          members: [...created.memberIds].sort(),
          defaultResponder: created.defaultResponder,
        };
        created = store.patchGroup(created.id, {
          installedPackage: { installId: org.installId, key: room.key, memberKeys: [...room.members].sort(), parts: pairs(ROOM_PARTS, roomReleaseValues(room), local) },
        }) ?? created;
        orgIndex.rooms[room.key] = created.id;
      }
    }

    for (const routine of pkg?.routines ?? []) {
      // Routines always arrive paused from a file. The organization channel
      // also pauses them for now; honouring enabledAfterInstall there is a
      // later, Admin-side decision.
      let timeoutMinutes = routine.timeoutMinutes;
      if (timeoutMinutes !== undefined && (timeoutMinutes < 5 || timeoutMinutes > 240)) {
        timeoutMinutes = Math.min(240, Math.max(5, timeoutMinutes));
        skipped.push({ part: `routines[${routine.key}].timeoutMinutes`, reason: "run_limit_adjusted" });
      }
      const input: RoutineInput = {
        name: routine.name,
        prompt: routine.prompt,
        botId: botIds.get(routine.agent)!,
        ...(routine.room !== undefined ? { target: "room-goal" as const, groupId: groupIds.get(routine.room)! } : {}),
        runOn: routine.runOn,
        enabled: false,
        schedule: routine.schedule,
        durationMinutes: routine.durationMinutes,
        ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
        ...(routine.overlap ? { overlap: routine.overlap } : {}),
        ...(routine.continuity && routine.room === undefined ? { continuity: true } : {}),
      };
      const created = deps.routines.create(input);
      createdRoutines.push(created);
      if (org) {
        const local = {
          name: created.name,
          prompt: created.prompt,
          schedule: scheduleValue(created),
          target: { botId: created.botId, groupId: created.groupId ?? null },
        };
        deps.routines.stampInstalledPackage!(created.id, { installId: org.installId, key: routine.key, parts: pairs(ROUTINE_PARTS, routineReleaseValues(routine), local) });
        orgIndex.routines[routine.key] = created.id;
      }
    }

    if (pkg?.team?.leader) store.setChiefOfStaff(botIds.get(pkg.team.leader)!);
    if (org && pkg?.team) {
      orgIndex.section = section;
      orgIndex.team.parts = pairs(TEAM_PARTS, {
        name: pkg.team.name, brief: pkg.team.brief ?? "", leader: pkg.team.leader ?? null,
      }, {
        name: section, brief: brief ? pkg.team.brief! : "", leader: pkg.team.leader ? botIds.get(pkg.team.leader)! : null,
      });
    }
    let presets: PackageImportResult["presets"];
    // An organization install always registers, so a release re-added without
    // presets also drops the rows an earlier one left (presets.ts).
    if (source.kind === "package" && deps.presets && (pkg?.presets?.length || org)) {
      const registered = deps.presets.register(source.document, { source: org ? "org" : "file", installId: installId!, ...(org ? { org } : {}) });
      createdPresets.push(...registered.added.map((preset) => preset.id));
      skipped.push(...registered.skipped);
      presets = [...registered.added, ...registered.existing];
    } else for (const preset of pkg?.presets ?? []) skipped.push({ part: `presets[${preset.key}]`, reason: "presets_not_supported_yet" });

    // The legacy project room is created last, so a failure anywhere above
    // leaves no half-built project behind.
    if (!pkg && options.mode === "project" && importedBots.length > 0) {
      const roomName = options.room?.trim() || name;
      group = store.createGroup(roomName, importedBots.map((bot) => bot.id), false, section);
      createdGroups.push(group);
      if (options.cwd) {
        // `cwd` is the folder the room WANTS; the store pins it on the
        // first turn (pinGroupCwd).
        group = store.patchGroup(group.id, { cwd: options.cwd }) ?? group;
      }
    }

    const referenced = new Set((pkg?.agents ?? []).flatMap((agent) => agent.skills ?? []));
    const bots = importedBots.map((bot) => store.bot(bot.id)!);
    for (const bot of bots) deps.broadcast?.({ kind: "bot", bot });
    if (group) deps.broadcast?.({ kind: "group", group });
    return {
      alreadyAdded: false,
      ...(installId ? { installId } : {}),
      ...(org ? { org: orgIndex } : {}),
      name,
      section,
      bots,
      groups: createdGroups.map((created) => store.group(created.id) ?? created),
      ...(group ? { group } : {}),
      routines: createdRoutines,
      offeredSkills: (pkg?.skills?.entries ?? []).filter((skill) => !referenced.has(skill.name)).map((skill) => skill.name),
      connections,
      skipped,
      brief,
      notes,
      ...(presets ? { presets } : {}),
    };
  } catch (error) {
    // A room of deleted members must not survive either — patchGroup can
    // throw (disk) after createGroup already saved.
    for (const routine of createdRoutines) deps.routines.remove(routine.id);
    for (const created of createdGroups) store.deleteGroup(created.id);
    for (const bot of importedBots) store.deleteBot(bot.id);
    deps.presets?.remove(createdPresets);
    if (createdServers.length) {
      const next: Record<string, unknown> = { ...deps.mcp.servers() };
      for (const serverName of createdServers) delete next[serverName];
      deps.mcp.persist(next);
    }
    // This import allocated a fresh section (and maybe its brief); a failed
    // installation retires that identity again.
    if (section && store.sections.includes(section)) store.changeEmptySection(section, null);
    throw error;
  }
}
