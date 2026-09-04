import { api } from "@/state/store";

export type ExportScope = "all" | { botIds: string[]; groupIds: string[] };

export interface ExportScopeContext {
  projectFilter: string;
  bots: readonly { id: string; name?: string; section?: string; hidden?: boolean }[];
  groups: readonly { id: string; name?: string; memberIds: string[]; dm?: boolean; section?: string }[];
}

export interface ExportScopeOption {
  key: `project:${string}` | `group:${string}` | `bot:${string}` | "all";
  category: "project" | "team" | "bot" | "other";
  label: string;
  detail: string;
  scope: ExportScope;
  botIds: string[];
}

export interface ExportRequest {
  name: string;
  scope: ExportScope;
  skillIds: string[];
  format: "package";
}

/** Resolve the bot represented by a single-bot export option. */
export function resolveExportScopeBot<T extends { id: string }>(
  option: ExportScopeOption,
  bots: readonly T[],
): T | undefined {
  if (!option.key.startsWith("bot:")) return undefined;
  return bots.find((bot) => bot.id === option.botIds[0]);
}

export interface ExportedPackage {
  name: string;
  members: number;
  markdown: string;
}

/** Convert a package name into a safe Markdown download filename. */
export function exportFilename(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "openmaus-package";
  return `${slug}.md`;
}

/** Build the server request for exporting a selected package scope. */
export function buildExportRequest(name: string, scope: ExportScope, skillIds: readonly string[]): ExportRequest {
  return {
    name: name.trim() || "OpenMaus package",
    scope,
    skillIds: [...skillIds],
    format: "package",
  };
}

/** Build project, room, bot, and all-bot options for the export picker. */
export function buildExportScopeOptions({ projectFilter, bots, groups }: ExportScopeContext): ExportScopeOption[] {
  const activeBots = bots.filter((bot) => !bot.hidden);
  const activeIds = new Set(activeBots.map((bot) => bot.id));
  const options: ExportScopeOption[] = [];

  const sections = [...new Set(activeBots.map((bot) => bot.section?.trim()).filter((section): section is string => Boolean(section)))];
  sections.sort((a, b) => a.localeCompare(b));
  if (projectFilter !== "all" && sections.includes(projectFilter)) {
    sections.splice(sections.indexOf(projectFilter), 1);
    sections.unshift(projectFilter);
  }
  for (const section of sections) {
    const projectBotIds = activeBots.filter((bot) => bot.section?.trim() === section).map((bot) => bot.id);
    const projectIdSet = new Set(projectBotIds);
    const groupIds = groups
      .filter((group) => !group.dm && group.memberIds.some((id) => projectIdSet.has(id)) && group.memberIds.filter((id) => activeIds.has(id)).every((id) => projectIdSet.has(id)) && (group.section?.trim() === section || (!group.section && group.memberIds.some((id) => projectIdSet.has(id)))))
      .map((group) => group.id)
      .sort((a, b) => a.localeCompare(b));
    options.push({
      key: `project:${section}`,
      category: "project",
      label: section,
      detail: section === projectFilter ? `Current project · ${projectBotIds.length} ${projectBotIds.length === 1 ? "bot" : "bots"}` : `${projectBotIds.length} ${projectBotIds.length === 1 ? "bot" : "bots"}`,
      scope: { botIds: projectBotIds, groupIds },
      botIds: projectBotIds,
    });
  }

  for (const group of [...groups].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id))) {
    if (group.dm) continue;
    const memberIds = group.memberIds.filter((id) => activeIds.has(id));
    if (!memberIds.length) continue;
    options.push({
      key: `group:${group.id}`,
      category: "team",
      label: group.section && group.section !== projectFilter ? `${group.name ?? group.id} · ${group.section}` : group.name ?? group.id,
      detail: `${memberIds.length} ${memberIds.length === 1 ? "bot" : "bots"} · channel/team`,
      scope: { botIds: memberIds, groupIds: [group.id] },
      botIds: memberIds,
    });
  }

  for (const bot of activeBots) {
    options.push({
      key: `bot:${bot.id}`,
      category: "bot",
      label: bot.name || bot.id,
      detail: "Single bot",
      scope: { botIds: [bot.id], groupIds: [] },
      botIds: [bot.id],
    });
  }

  if (activeBots.length) {
    options.push({
      key: "all",
      category: "other",
      label: "All active bots",
      detail: `${activeBots.length} ${activeBots.length === 1 ? "bot" : "bots"} · explicit full selection`,
      scope: "all",
      botIds: activeBots.map((bot) => bot.id),
    });
  }
  return options;
}

/** Download a rendered team package as a local Markdown file. */
export function downloadExportPackage(playbook: ExportedPackage) {
  const blob = new Blob([playbook.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFilename(playbook.name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: playbook.name, members: playbook.members };
}

/** Export every active sidebar bot as one portable Chief-of-Staff Markdown. */
export async function downloadAllBots(): Promise<{ name: string; members: number }> {
  const playbook = (await api("/api/teams/export", {
    method: "POST",
    body: JSON.stringify({ format: "package" }),
  })) as ExportedPackage;
  return downloadExportPackage(playbook);
}
