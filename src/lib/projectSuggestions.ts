import type { ProjectRecord } from "../types/gbs.ts";

export const BROWSER_SUGGESTED_FOLDERS = [
  "~/Projects",
  "~/Documents",
  "~/Desktop",
  "~/workspace",
] as const;

export const BROWSER_HOST_FOLDER_HINT =
  "This folder is on the host computer running Gerer Build Studio.";

export function repositoryFolderName(repositoryUrl: string): string {
  return (
    repositoryUrl
      .trim()
      .replace(/[\\/]$/, "")
      .split(/[\\/:]/)
      .at(-1)
      ?.replace(/\.git$/i, "") ?? ""
  );
}

export function childPath(parent: string, name: string, platform?: string): string {
  const separator = platform === "win32" ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function parentFolderPath(projectPath: string): string | null {
  const trimmed = projectPath.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (lastSlash <= 0) return null;
  return trimmed.slice(0, lastSlash);
}

export function getSuggestedProjectFolders(
  projects?: Pick<ProjectRecord, "path">[] | null,
): string[] {
  const suggestions: string[] = [...BROWSER_SUGGESTED_FOLDERS];
  const seen = new Set(suggestions.map((item) => item.toLowerCase()));

  for (const project of projects ?? []) {
    const parent = parentFolderPath(project.path);
    if (!parent) continue;
    const key = parent.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(parent);
    if (suggestions.length >= BROWSER_SUGGESTED_FOLDERS.length + 2) break;
  }

  return suggestions;
}

export function applySuggestedFolder(
  suggestion: string,
  options: {
    mode: "existing" | "create" | "clone";
    repositoryUrl?: string;
    platform?: string;
  },
): string {
  const base = suggestion.trim();
  if (options.mode !== "clone") return base;
  const repoName = repositoryFolderName(options.repositoryUrl ?? "");
  return repoName ? childPath(base, repoName, options.platform) : base;
}

export function projectSourceLabel(project: Pick<ProjectRecord, "source">): string {
  if (project.source === "github") return "From GitHub";
  if (project.source === "created") return "New project folder";
  return "Folder on this computer";
}
