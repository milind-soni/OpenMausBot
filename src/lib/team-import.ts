import { parse as parseYaml } from "yaml";
import { parseTeamBackup, TEAM_BACKUP_CONTENTS } from "../../shared/team-backup";
import { NEWER_PACKAGE_MESSAGE, PACKAGE_VERSION, parsePackageDocument, type PackageDocument } from "../../shared/package-format";
import { composioSlugFor, grokExportToPackage, isGrokExport, parseGrokExport, type GrokLeftOut } from "../../shared/grok-import";

export interface PendingTeamImport {
  manifest: unknown;
  kind: "team" | "package" | "backup";
  name: string;
  description: string;
  members: Array<{ name: string; title: string }>;
  chiefOfStaff?: string;
  rooms: number;
  playbooks: number;
  routines: number;
  apps: Array<{ label: string; optional: boolean }>;
  skills?: string[];
  conversations?: number;
  archivedBots?: number;
  warnings?: string[];
  version?: number;
  teamName?: string;
  brief?: string;
  pictures?: Array<string | null>;
  offeredSkills?: string[];
  connections?: Array<{ label: string; url: string; values: number }>;
  notes?: number;
  presets?: string[];
  library?: boolean;
  /** The warnings list what a Grok Bot export could not carry. */
  leftOut?: boolean;
  /** What is left to do after a Grok Bot import, for the Chief of Staff's prepared message. */
  grokSetup?: GrokSetupNotes;
}

export interface GrokSetupNotes {
  sourceUrl?: string;
  /** Apps with a Composio toolkit, to connect. */
  apps: Array<{ label: string; slug: string }>;
  /** Grok Bot plugins Maus has no match for. */
  unmatched: string[];
  leftOut: GrokLeftOut[];
}

export interface GrokPreviewOptions {
  /** The x.ai/bot link the export came from, credited as the author's link. */
  sourceUrl?: string;
  /** For routines whose export named no zone; the computer's own by default. */
  timeZone?: string;
}

const leftOutLine = (item: GrokLeftOut) =>
  `${item.name}: ${item.reason}.${item.original ? ` It said: ${item.original.length > 2_000 ? `${item.original.slice(0, 1_999)}…` : item.original}` : ""}`;

/** A Grok Bot export (pasted reply or file) as the package preview, with what was left out as warnings. */
export function grokImportPreview(input: unknown, options: GrokPreviewOptions = {}): PendingTeamImport {
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const x = parseGrokExport(input);
  const { document, leftOut } = grokExportToPackage(x, { ...options, timeZone });
  const sourceUrl = document.package.author.url;
  const grokSetup: GrokSetupNotes = {
    ...(sourceUrl ? { sourceUrl } : {}),
    apps: document.package.requirements.apps.flatMap((app) => (composioSlugFor(app.label) === app.slug ? [{ label: app.label, slug: app.slug }] : [])),
    unmatched: document.package.requirements.apps.flatMap((app) => (composioSlugFor(app.label) === app.slug ? [] : [app.label])),
    leftOut,
  };
  const preview = { ...sharedTeamPreview(document, document), grokSetup };
  return leftOut.length ? { ...preview, warnings: leftOut.map(leftOutLine), leftOut: true } : preview;
}

/** Client-side preview only; the server remains the trust boundary. */
export function teamImportPreview(manifest: unknown): PendingTeamImport {
  if (isGrokExport(manifest)) return grokImportPreview(manifest);
  if (typeof manifest === "string") manifest = markdownPackage(manifest);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("This file does not contain a team.");
  }
  const root = manifest as Record<string, unknown>;
  if (root.format === "openmaus.backup") {
    const backup = parseTeamBackup(manifest);
    return {
      manifest: backup, kind: "backup", name: backup.name, description: TEAM_BACKUP_CONTENTS,
      members: backup.bots.map((bot) => ({ name: bot.name, title: bot.title })),
      rooms: backup.groups.length, playbooks: backup.bots.reduce((total, bot) => total + bot.playbooks.length, 0),
      routines: backup.routines.length, apps: [],
      conversations: [...backup.bots, ...backup.groups].reduce((total, owner) => total + owner.tasks.length, 0),
      archivedBots: backup.bots.filter((bot) => bot.hidden).length,
      warnings: backup.warnings,
    };
  }
  if (root.format === "openmaus.package") return packagePreview(root, manifest);
  if (root.format !== "openmaus.team") throw new Error("This is not an OpenMaus backup, BotMRR playbook or legacy team.");
  if (root.version !== 1 && root.version !== 2) throw new Error(`Team file version ${String(root.version)} is not supported.`);
  if (!root.team || typeof root.team !== "object" || Array.isArray(root.team)) {
    throw new Error("This team file is missing its team definition.");
  }
  const team = root.team as Record<string, unknown>;
  if (typeof team.name !== "string" || !team.name.trim()) throw new Error("This team does not have a name.");
  if (!Array.isArray(team.members) || team.members.length === 0) throw new Error("This team has no members.");
  if (team.members.length > 200) throw new Error("This team has too many members.");
  const members = team.members.map((member, index) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw new Error(`Team member ${index + 1} is invalid.`);
    }
    const value = member as Record<string, unknown>;
    if (typeof value.name !== "string" || !value.name.trim()) {
      throw new Error(`Team member ${index + 1} does not have a name.`);
    }
    return {
      name: value.name.trim(),
      title: typeof value.title === "string" ? value.title.trim() : "",
    };
  });
  return {
    manifest,
    kind: "team",
    name: team.name.trim(),
    description: typeof team.description === "string" ? team.description.trim() : "",
    members,
    rooms: root.version === 1 && team.room && typeof team.room === "object" ? 1 : 0,
    playbooks: 0,
    routines: 0,
    apps: [],
  };
}

function markdownPackage(markdown: string): unknown {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error("This Markdown is missing its BotMRR frontmatter.");
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]);
  } catch {
    throw new Error("This Markdown has invalid YAML frontmatter.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("This Markdown is missing its BotMRR blueprint.");
  }
  const { botmrr, ...pkg } = metadata as Record<string, unknown>;
  if (botmrr !== 1) throw new Error("This BotMRR Markdown version is not supported.");
  return { format: "openmaus.package", version: 1, package: pkg };
}

function sharedTeamPreview(document: PackageDocument, manifest: unknown): PendingTeamImport {
  const pkg = document.package;
  if (!pkg.agents.length) return libraryPreview(document, manifest);
  const referenced = new Set(pkg.agents.flatMap((agent) => agent.skills ?? []));
  const leader = pkg.team?.leader ? pkg.agents.find((agent) => agent.key === pkg.team?.leader)?.name : undefined;
  return {
    manifest,
    kind: "package",
    version: 2,
    name: pkg.name,
    teamName: pkg.team?.name ?? pkg.name,
    description: pkg.summary,
    members: pkg.agents.map((agent) => ({ name: agent.name, title: agent.title ?? "" })),
    ...(leader ? { chiefOfStaff: leader } : {}),
    ...(pkg.team?.brief?.trim() ? { brief: pkg.team.brief } : {}),
    pictures: pkg.agents.map((agent) => agent.appearance.avatar
      ? `data:${agent.appearance.avatar.mime};base64,${agent.appearance.avatar.data}`
      : null),
    rooms: pkg.rooms?.length ?? 0,
    playbooks: pkg.playbooks?.length ?? 0,
    routines: pkg.routines?.length ?? 0,
    apps: pkg.requirements.apps.map((app) => ({ label: app.label, optional: app.optional === true })),
    skills: (pkg.skills?.entries ?? []).filter((skill) => referenced.has(skill.name)).map((skill) => skill.name),
    offeredSkills: (pkg.skills?.entries ?? []).filter((skill) => !referenced.has(skill.name)).map((skill) => skill.name),
    connections: (pkg.connections ?? []).map((connection) => ({
      label: connection.label, url: connection.mcp.url, values: connection.mcp.valueNames.length,
    })),
    notes: pkg.agents.reduce((total, agent) => total + Object.keys(agent.seed?.memory ?? {}).length, 0),
    presets: (pkg.presets ?? []).map((preset) => preset.name),
  };
}

function libraryPreview(document: PackageDocument, manifest: unknown): PendingTeamImport {
  const pkg = document.package;
  if (!pkg.presets?.length) throw new Error("This file has no bots or preset bots to add. Its skills can be added from your organization's shelf.");
  return {
    manifest,
    kind: "package",
    version: 2,
    library: true,
    name: pkg.name,
    description: pkg.summary,
    members: [],
    rooms: 0,
    playbooks: pkg.playbooks?.length ?? 0,
    routines: 0,
    apps: [],
    skills: [],
    offeredSkills: (pkg.skills?.entries ?? []).filter((skill) => !pkg.presets!.some((preset) => preset.skills?.includes(skill.name))).map((skill) => skill.name),
    presets: pkg.presets.map((preset) => preset.name),
  };
}

function packagePreview(root: Record<string, unknown>, manifest: unknown): PendingTeamImport {
  if (typeof root.version === "number" && root.version > PACKAGE_VERSION) throw new Error(NEWER_PACKAGE_MESSAGE);
  if (root.version === PACKAGE_VERSION) return sharedTeamPreview(parsePackageDocument(manifest), manifest);
  if (root.version !== 1) throw new Error(`BotMRR playbook version ${String(root.version)} is not supported.`);
  if (!root.package || typeof root.package !== "object" || Array.isArray(root.package)) {
    throw new Error("This playbook is missing its team definition.");
  }
  const pkg = root.package as Record<string, unknown>;
  if (typeof pkg.name !== "string" || !pkg.name.trim()) throw new Error("This playbook does not have a name.");
  if (!Array.isArray(pkg.agents) || pkg.agents.length === 0) throw new Error("This playbook has no bots.");
  if (pkg.agents.length > 200) throw new Error("This playbook has too many bots.");
  const members = pkg.agents.map((agent, index) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) throw new Error(`Bot ${index + 1} is invalid.`);
    const value = agent as Record<string, unknown>;
    if (typeof value.name !== "string" || !value.name.trim()) throw new Error(`Bot ${index + 1} does not have a name.`);
    return { name: value.name.trim(), title: typeof value.title === "string" ? value.title.trim() : "" };
  });
  const chiefKey = typeof pkg.chiefOfStaff === "string" ? pkg.chiefOfStaff : undefined;
  const chief = chiefKey
    ? (pkg.agents as Array<Record<string, unknown>>).find((agent) => agent.key === chiefKey)?.name
    : undefined;
  const requirements = pkg.requirements && typeof pkg.requirements === "object" && !Array.isArray(pkg.requirements)
    ? pkg.requirements as Record<string, unknown>
    : {};
  const apps = Array.isArray(requirements.apps)
    ? requirements.apps.flatMap((app) => {
        if (!app || typeof app !== "object" || Array.isArray(app)) return [];
        const value = app as Record<string, unknown>;
        return typeof value.label === "string"
          ? [{ label: value.label.trim(), optional: value.optional === true }]
          : [];
      })
    : [];
  const skills = pkg.skills && typeof pkg.skills === "object" && !Array.isArray(pkg.skills)
    ? (pkg.skills as Record<string, unknown>).entries
    : undefined;
  return {
    manifest,
    kind: "package",
    version: 1,
    name: pkg.name.trim(),
    description: typeof pkg.summary === "string" ? pkg.summary.trim() : "",
    members,
    ...(typeof chief === "string" ? { chiefOfStaff: chief } : {}),
    rooms: Array.isArray(pkg.rooms) ? pkg.rooms.length : 0,
    playbooks: Array.isArray(pkg.playbooks) ? pkg.playbooks.length : 0,
    routines: Array.isArray(pkg.routines) ? pkg.routines.length : 0,
    apps,
    skills: Array.isArray(skills) ? skills.flatMap((skill) => {
      if (!skill || typeof skill !== "object" || Array.isArray(skill)) return [];
      const { name } = skill as Record<string, unknown>;
      return typeof name === "string" && name.trim() ? [name.trim()] : [];
    }) : [],
  };
}
