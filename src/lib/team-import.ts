import { parse as parseYaml } from "yaml";
import { parseTeamBackup, TEAM_BACKUP_CONTENTS } from "../../shared/team-backup";

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
  conversations?: number;
  archivedBots?: number;
  warnings?: string[];
}

/** Small client-side preview only; the server remains the trust boundary. */
export function teamImportPreview(manifest: unknown): PendingTeamImport {
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

function packagePreview(root: Record<string, unknown>, manifest: unknown): PendingTeamImport {
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
  return {
    manifest,
    kind: "package",
    name: pkg.name.trim(),
    description: typeof pkg.summary === "string" ? pkg.summary.trim() : "",
    members,
    ...(typeof chief === "string" ? { chiefOfStaff: chief } : {}),
    rooms: Array.isArray(pkg.rooms) ? pkg.rooms.length : 0,
    playbooks: Array.isArray(pkg.playbooks) ? pkg.playbooks.length : 0,
    routines: Array.isArray(pkg.routines) ? pkg.routines.length : 0,
    apps,
  };
}
