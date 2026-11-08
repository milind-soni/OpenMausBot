import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { IMPORTED_SKILLS_DIR, readImportedSkills, syncImportedSkillLinks, type ImportedSkillView } from "./imported-skills.ts";
import type { HarnessSkillLinks } from "./lending-memory.ts";
import { orgSkillStorage, ownSkillLinks, syncSkillLinks } from "./skills.ts";
import { taskSkillMayReferTo } from "./skill-task-references.ts";
import { nativeSkillLinksMayReferTo } from "./skill-native-reference.ts";
import type { BotRecord, Store } from "./store.ts";
import { ensureTaskWorkspace, workspaceDir } from "./workspace.ts";

export class SkillLinkSafetyError extends Error {}
const turnWorkspaceOwners = new WeakMap<object, ReadonlySet<string>>();

const comparable = (path: string) => {
  const normalized = resolve(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const inside = (parent: string, child: string) => {
  const rest = relative(comparable(parent), comparable(child));
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
};

export function workspaceMayContain(botId: string, cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const workspace = workspaceDir(botId);
  if (inside(workspace, cwd)) return true;
  try { return inside(realpathSync(workspace), realpathSync(cwd)); } catch { return true; }
}

export function noteSkillWorkspaceUse(turn: object, cwd: string | undefined, botIds: readonly string[]): void {
  if (!cwd) { turnWorkspaceOwners.set(turn, new Set()); return; }
  let actual: string | undefined;
  try { actual = realpathSync(cwd); } catch {}
  // A mutable or unresolved alias can change after a provider takes its working folder.
  const alias = !actual || comparable(actual) !== comparable(cwd);
  turnWorkspaceOwners.set(turn, new Set(alias ? botIds : botIds.filter((owner) => workspaceMayContain(owner, cwd))));
}

export function skillWorkspaceMayBeInUse(botId: string, direct: Iterable<[string, BotRecord]>, rooms: Iterable<string>, store: Store, turns: ReadonlyMap<string, object>): boolean {
  const noted = (threadId: string) => { const turn = turns.get(threadId); return turn && turnWorkspaceOwners.get(turn)?.has(botId); };
  for (const [threadId, bot] of direct) {
    if (noted(threadId)) return true;
    const cwd = store.taskByThread(bot.id, threadId)?.cwd;
    if (workspaceMayContain(botId, cwd === undefined ? bot.cwd : cwd)) return true;
  }
  for (const threadId of rooms) {
    if (noted(threadId)) return true;
    const group = store.groupByThread(threadId);
    if (!group) continue;
    const task = store.groupTaskByThread(group.id, threadId);
    const pinned = task ? task.pinnedCwd : group.pinnedCwd;
    const cwd = pinned === undefined ? group.cwd : pinned;
    if (workspaceMayContain(botId, cwd)) return true;
  }
  return false;
}

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

/** A turn must not discover a retained revision through any bot's workspace. */
export function assertWorkspaceSkillLinksCurrent(botId: string, cwd: string | undefined, otherBotIds: readonly string[] = []): void {
  if (!cwd) return;
  for (const owner of new Set([botId, ...otherBotIds])) {
    const workspace = workspaceDir(owner);
    if (!workspaceMayContain(owner, cwd)) continue;
    let workspaceAvailable = true;
    try { realpathSync(workspace); } catch { workspaceAvailable = false; }
    const root = join(workspace, "skills");
    const manifest = orgSkillStorage.readProtectedManifest(owner);
    if (!manifest) throw new SkillLinkSafetyError("Skill links could not be synchronized safely; retry after the previous skill links are cleared.");
    for (const [name, entry] of Object.entries(manifest)) {
      const pending = [...(entry.pendingRetirements ?? []), ...(entry.pendingRemoval ? [entry.pendingRemoval] : [])];
      if (pending.length && (!workspaceAvailable || pending.some((item) => nativeSkillLinksMayReferTo(owner, name, item.revision ? join(root, ".revisions", item.revision) : join(root, name))))) {
        throw new SkillLinkSafetyError("Skill links could not be synchronized safely; retry after the previous skill links are cleared.");
      }
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
  try {
    syncTaskSkillLinks(botId, threadId);
  } catch (error) {
    console.warn(`[skills] linking skills into the task folder failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (taskHasStaleOrganizationLink(botId, threadId)) {
    throw new SkillLinkSafetyError("Skill links could not be synchronized safely; retry after the task's previous skill links are cleared.");
  }
  linkImported();
  return folder;
}
