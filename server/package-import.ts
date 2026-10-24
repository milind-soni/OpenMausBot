// Packages are untrusted: import only adds new records, sets every privilege-bearing field itself, and rolls back on any failure.
import { createHash, randomUUID } from "node:crypto";

import { mcpServerNameError, MAX_MCP_SERVERS, parseStoredMcpServer } from "./mcp-registry.ts";
import {
  AGENT_PARTS, agentReleaseValues, connectionLocalValue, connectionReleaseValue, pair, pairs, playbookValues,
  mascotLookFields, ROOM_PARTS, roomReleaseValues, ROUTINE_PARTS, routineReleaseValues, scheduleValue, sha256Hex, TEAM_PARTS,
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
export const NO_PRESETS_MESSAGE = "This file has no bots or preset bots to add. Its skills can be added from your organization's shelf.";

export type PackageImportErrorCode = "no_bots" | "invalid_package";

export class PackageImportError extends Error {
  readonly status = 400;
  readonly code: PackageImportErrorCode;
  constructor(code: PackageImportErrorCode, message: string) {
    super(message);
    this.name = "PackageImportError";
    this.code = code;
  }
}

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
  routines: Pick<RoutineManager, "create" | "remove"> & Partial<Pick<RoutineManager, "stampInstalledPackage">>;
  skills: {
    install(botId: string, source: string, files: Array<{ path: string; content: string }>): SkillListing | { error: string };
    setEnabled(botId: string, name: string, enabled: boolean): SkillListing | { error: string };
    installOrg?(botId: string, source: string, skillMd: string, stamp: SkillPackageStamp): SkillListing | { error: string };
  };
  memory: {
    writeIndex(botId: string, text: string): void;
    writeTopic(botId: string, name: string, text: string): void;
  };
  mcp: {
    servers(): Readonly<Record<string, unknown>>;
    refusal(name: string, server: object): string | undefined;
    persist(next: Record<string, unknown>): void;
  };
  sections: { writeBrief(section: string, text: string): void };
  images: { save(bytes: Uint8Array, mime: string): string };
  broadcast?: (event: { kind: "bot"; bot: BotRecord } | { kind: "group"; group: GroupRecord }) => void;
  defaultSelection: () => ModelSelection;
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
  cwd?: string | null;
  room?: string;
  /** Who may see the new bots: the admin's choice, never the file's. */
  visibility?: BotVisibility;
  org?: OrgImportContext;
}

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
  org?: OrgInstallIndex;
  name: string;
  section: string;
  bots: BotRecord[];
  groups: GroupRecord[];
  group?: GroupRecord;
  routines: Routine[];
  offeredSkills: string[];
  connections: Array<{ key: string; name: string; label: string }>;
  skipped: ImportSkip[];
  brief: boolean;
  notes: number;
  presets?: Array<{ id: string; key: string; name: string }>;
}

export type ImportResult = PackageImportResult | { alreadyAdded: true; installId: string };

export function orgInstallId(adminOrigin: string, organizationId: string, packageId: string): string {
  return createHash("sha256").update(`omb-install:v1\n${adminOrigin}\n${organizationId}\n${packageId}`, "utf8").digest("hex").slice(0, 32);
}

export function memberFromAgent(agent: PackageAgent): TeamManifestMember {
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
      ...(agent.appearance.mascotProfile ? { mascotProfile: agent.appearance.mascotProfile } : {}),
    },
  };
}

/** Never an existing or reserved name, so a slot can never bind to credentials already here. */
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

export function importPackageDocument(
  document: PackageDocument,
  options: PackageImportOptions,
  deps: PackageImportDeps,
): ImportResult {
  const pkg = document.package;
  const library = !pkg.agents.length || !pkg.team;
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
    if (deps.store.bots.some((bot) => bot.installedPackage?.installId === org.installId && !bot.installedPackage.presetKey) ||
        deps.store.groups.some((group) => group.installedPackage?.installId === org.installId)) {
      return { alreadyAdded: true, installId: org.installId };
    }
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
    // Always a new section: never merge into an existing one or replace its Chief.
    section = takeImportName(teamName, existingSections, 60);

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
      // importedMemberProfile is the authority boundary: persona fields only.
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
      // No connected apps (absence would mean allowed) and no approval level: an imported bot starts at the defaults.
      store.patchBot(created.id, {
        composio: false,
        connectorTools: {},
        // The publisher's choice, with no card: recording only keeps evidence in this workspace.
        ...(agent?.recordBrowserSteps === true ? { recordBrowserSteps: true } : {}),
        ...(playbooks.length ? { playbooks } : {}),
        ...(installed ? { installedPackage: installed } : {}),
        ...(agent?.connections ? { mcpServers: agent.connections.flatMap((key) => serverForKey.has(key) ? [serverForKey.get(key)!] : []) } : {}),
        ...avatar,
      });
      for (const skillName of agent?.skills ?? []) {
        const skill = skillByName.get(skillName);
        if (!skill) throw new Error(`Package skill "${skillName}" is unavailable`);
        // The organization channel names its own source, so ownership can never be forged.
        const added = org
          ? deps.skills.installOrg!(created.id, `org:${org.ref}@${pkg!.release}`, skill.instructions,
              { installId: org.installId, key: skill.name, release: pkg!.release, ...pair(skill.instructions, skill.instructions) })
          : deps.skills.install(created.id, skill.source ?? `package:${pkg!.id}`, [{ path: "SKILL.md", content: skill.instructions }]);
        if ("error" in added) throw new Error(`Package skill "${skillName}" could not be imported: ${added.error}`);
      }
      for (const [path, text] of Object.entries(agent?.seed?.memory ?? {})) {
        if (path === "MEMORY.md") deps.memory.writeIndex(created.id, text);
        else deps.memory.writeTopic(created.id, path.slice("memory/".length), text);
        notes += 1;
      }
      // Part hashes are written last: after a crash, a bot that has them is complete.
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
            ...mascotLookFields(written),
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

    // Brief first, leader last, so an interrupted organization add can tell a finished team from a partial one.
    const brief = Boolean(pkg?.team?.brief?.trim());
    if (brief) deps.sections.writeBrief(section, pkg!.team!.brief!);

    const groupIds = new Map<string, string>();
    for (const room of pkg?.rooms ?? []) {
      const ids = room.members.map((key) => botIds.get(key)!);
      let created = store.createGroup(room.name, ids, false, section);
      createdGroups.push(created);
      const responder = room.defaultResponder;
      const defaultResponder = responder.kind === "agent"
        ? { kind: "member" as const, botId: botIds.get(responder.agent)! }
        : responder.kind === "auto"
          ? { kind: "auto" as const, ...(responder.agent ? { fallbackBotId: botIds.get(responder.agent)! } : {}) }
          : { kind: responder.kind };
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
      // Routines always arrive paused.
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
        ...(routine.runOnStartup ? { runOnStartup: true } : {}),
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
    if (source.kind === "package" && deps.presets && (pkg?.presets?.length || org)) {
      const registered = deps.presets.register(source.document, { source: org ? "org" : "file", installId: installId!, ...(org ? { org } : {}) });
      createdPresets.push(...registered.added.map((preset) => preset.id));
      skipped.push(...registered.skipped);
      presets = [...registered.added, ...registered.existing];
    } else for (const preset of pkg?.presets ?? []) skipped.push({ part: `presets[${preset.key}]`, reason: "presets_not_supported_yet" });

    if (!pkg && options.mode === "project" && importedBots.length > 0) {
      const roomName = options.room?.trim() || name;
      group = store.createGroup(roomName, importedBots.map((bot) => bot.id), false, section);
      createdGroups.push(group);
      if (options.cwd) {
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
    for (const routine of createdRoutines) deps.routines.remove(routine.id);
    for (const created of createdGroups) store.deleteGroup(created.id);
    for (const bot of importedBots) store.deleteBot(bot.id);
    deps.presets?.remove(createdPresets);
    if (createdServers.length) {
      const next: Record<string, unknown> = { ...deps.mcp.servers() };
      for (const serverName of createdServers) delete next[serverName];
      deps.mcp.persist(next);
    }
    if (section && store.sections.includes(section)) store.changeEmptySection(section, null);
    throw error;
  }
}
