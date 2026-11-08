import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { IMPORTED_SKILLS_DIR, readImportedSkills, syncImportedSkillLinks, type ImportedSkillView } from "./imported-skills.ts";
import type { HarnessSkillLinks } from "./lending-memory.ts";
import { orgSkillStorage, ownSkillLinks, syncSkillLinks } from "./skills.ts";
import { taskSkillMayReferTo } from "./skill-task-references.ts";
import { nativeSkillLinksMayReferTo } from "./skill-native-reference.ts";
import { ensureTaskWorkspace, workspaceDir } from "./workspace.ts";

/** Every link this file's two syncs may put in a bot's folders. */
export function harnessSkillLinks(botId: string): HarnessSkillLinks {
  return { own: ownSkillLinks(botId), imported: new Map(Object.keys(readImportedSkills()).map((name) => [name, join(IMPORTED_SKILLS_DIR, name)])) };
}

export function syncTaskSkillLinks(
  botId: string,
  threadId: string,
  options: { beforeRemove?: (link: string) => void } = {},
): boolean {
  return syncSkillLinks(botId, { ...options, task: { threadId, folder: ensureTaskWorkspace(botId, threadId) } });
}

function taskHasStaleOrganizationLink(botId: string, threadId: string): boolean {
  const root = join(workspaceDir(botId), "skills");
  return Object.entries(orgSkillStorage.readManifest(botId)).some(([name, entry]) => {
    const pending = [...(entry.pendingRetirements ?? []), ...(entry.pendingRemoval ? [entry.pendingRemoval] : [])];
    const targets = pending.map((item) => item.revision ? join(root, ".revisions", item.revision) : join(root, name));
    return taskSkillMayReferTo(botId, threadId, name, targets);
  });
}

/** A legacy turn using the bot's own workspace must not discover a retained old revision. */
export function assertWorkspaceSkillLinksCurrent(botId: string, cwd: string | undefined): void {
  const workspace = workspaceDir(botId);
  if (!cwd) return;
  const comparable = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const inside = (parent: string, child: string) => {
    const rest = relative(comparable(parent), comparable(child));
    return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
  };
  let inWorkspace = inside(workspace, cwd);
  if (!inWorkspace) {
    try { inWorkspace = inside(realpathSync(workspace), realpathSync(cwd)); } catch {}
  }
  if (!inWorkspace) return;
  const root = join(workspace, "skills");
  for (const [name, entry] of Object.entries(orgSkillStorage.readManifest(botId))) {
    const pending = [...(entry.pendingRetirements ?? []), ...(entry.pendingRemoval ? [entry.pendingRemoval] : [])];
    if (pending.some((item) => nativeSkillLinksMayReferTo(botId, name, item.revision ? join(root, ".revisions", item.revision) : join(root, name)))) {
      throw new Error("Skill links could not be synchronized safely; retry after the previous skill links are cleared.");
    }
  }
}

/** The turn's task folder, with its enabled and imported skills linked in. */
export function ensureTaskWorkspaceWithSkills(botId: string, threadId: string, imported: readonly ImportedSkillView[] = []): string {
  const folder = ensureTaskWorkspace(botId, threadId);
  const linkImported = () => {
    try {
      syncImportedSkillLinks(botId, folder, imported);
    } catch (error) {
      console.warn(`[skills] linking this computer's skills into the task folder failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Before the bot's own, so a name it now holds itself is free; after, so a name it gave up is linked this turn.
  linkImported();
  let synchronized = false;
  try {
    synchronized = syncTaskSkillLinks(botId, threadId);
  } catch (error) {
    console.warn(`[skills] linking skills into the task folder failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!synchronized && taskHasStaleOrganizationLink(botId, threadId)) {
    throw new Error("Skill links could not be synchronized safely; retry after the task's previous skill links are cleared.");
  }
  linkImported();
  return folder;
}
