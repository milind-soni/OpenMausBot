import { join } from "node:path";

import { IMPORTED_SKILLS_DIR, readImportedSkills, syncImportedSkillLinks, type ImportedSkillView } from "./imported-skills.ts";
import type { HarnessSkillLinks } from "./lending-memory.ts";
import { ownSkillLinks, syncSkillLinks } from "./skills.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

/** Every link this file's two syncs may put in a bot's folders. */
export function harnessSkillLinks(botId: string): HarnessSkillLinks {
  return { own: ownSkillLinks(botId), imported: new Map(Object.keys(readImportedSkills()).map((name) => [name, join(IMPORTED_SKILLS_DIR, name)])) };
}

export function syncTaskSkillLinks(
  botId: string,
  threadId: string,
  options: { beforeRemove?: (link: string) => void } = {},
): void {
  syncSkillLinks(botId, { ...options, task: { threadId, folder: ensureTaskWorkspace(botId, threadId) } });
}

/** The turn's task folder, with the bot's enabled skills and this turn's skills from this computer (`imported`)
 * linked in. A failed link only loses native discovery; the prompt index still lists them. */
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
  linkImported();
  return folder;
}
