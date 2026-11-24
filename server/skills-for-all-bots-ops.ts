// Putting a skill on all of a person's bots, changing it there and taking it off again (skills-for-all-bots.ts reads
// it). A bot that already has its own copy with the very same files gives that copy up for the shared one, keeping its
// on/off state as its own switch; a bot whose own copy differs keeps it (its own skill wins the name) and is reported.
import { createHash } from "node:crypto";

import { LEARN_SOURCE_PREFIX } from "./skill-learn.ts";
import { installLibrarySkill, readLibrarySkillFile, readSkillLibraryIndex, retireLibrarySkill, updateLibrarySkill } from "./skill-library.ts";
import { librarySkillFiles, ownSkillFiles } from "./skill-side-files.ts";
import {
  applySkillWriteWithReceipt, installSkill, listSkills, readSkillFile, rejectStagedSkillWrite, removeSkill, setSkillEnabled, stageSkillWrite,
} from "./skills.ts";
import { allBotsRoot, botsInAllBotsScope, setAllBotsSkillOff } from "./skills-for-all-bots.ts";

export interface SkillCopy {
  skillMd: string;
  /** The files beside SKILL.md: a learned skill's references/*.md, or an import's folder. */
  files: Array<{ path: string; content: string | Uint8Array }>;
  source: string;
}

const hex = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One digest over SKILL.md and every file beside it, so two copies match only when all of their bytes do. */
export function copyDigest(copy: Pick<SkillCopy, "skillMd" | "files">): string {
  const files = [...copy.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => `${file.path}\0${hex(file.content)}`);
  return hex([hex(copy.skillMd), ...files].join("\n"));
}

/** The bot's own copy as stored, while every file still verifies. */
export function ownCopy(botId: string, name: string): SkillCopy | null {
  const skillMd = readSkillFile(botId, name), files = ownSkillFiles(botId, name);
  const source = listSkills(botId).find((skill) => skill.name === name)?.source;
  return skillMd !== null && files !== null && source ? { skillMd, files, source } : null;
}

export function sharedCopy(scope: string, name: string): SkillCopy | null {
  const root = allBotsRoot(scope), entry = readSkillLibraryIndex(root)[name];
  const skillMd = entry ? readLibrarySkillFile(name, root) : null, files = entry ? librarySkillFiles(name, root) : null;
  return entry && skillMd !== null && files !== null ? { skillMd, files, source: entry.source } : null;
}

export interface RetiredCopy {
  botId: string;
  wasOff: boolean;
  copy: SkillCopy;
}

export interface PutOnAllBots {
  name: string;
  sha256: string;
  /** Bots whose identical own copy gave way to the shared one. */
  retired: RetiredCopy[];
  /** Bots that keep a different copy of their own under the same name. */
  kept: string[];
}

/** Adds the skill to every bot of the person's, or replaces the copy they share. `fresh`: a new skill, so no bot keeps an
 * old switch for a skill of this name; Undo of a removal passes false and every bot keeps its switch. */
export function putOnAllBots(scope: string, name: string, copy: SkillCopy, options: { fresh: boolean }): PutOnAllBots | { error: string } {
  const root = allBotsRoot(scope), current = readSkillLibraryIndex(root)[name];
  const existing = current ? sharedCopy(scope, name) : null;
  if (current && !existing) return { error: `the copy of "${name}" on all your bots changed outside OpenMausBot; remove it and add it again` };
  if (!existing || copyDigest(existing) !== copyDigest(copy)) {
    const files = copy.files.map((file) => ({ path: file.path, content: file.content }));
    if (current && !current.files?.length && !files.length) {
      const updated = updateLibrarySkill({ name, instructions: copy.skillMd, expectSha256: current.sha256, source: copy.source, root });
      if ("stale" in updated) return { error: `"${name}" changed while it was being updated; try again` };
      if ("error" in updated) return updated;
    } else {
      if (current) {
        const retired = retireLibrarySkill(name, current.sha256, root);
        if (!("retired" in retired)) return { error: "stale" in retired ? `"${name}" changed while it was being updated; try again` : retired.error };
      }
      const installed = installLibrarySkill({ name, instructions: copy.skillMd, source: copy.source, reviewState: "approved", ...(files.length ? { files } : {}), root });
      if ("error" in installed) return installed;
    }
  }
  const sha256 = readSkillLibraryIndex(root)[name]?.sha256 ?? hex(copy.skillMd);
  const digest = copyDigest(copy), retired: RetiredCopy[] = [], kept: string[] = [];
  for (const bot of botsInAllBotsScope(scope)) {
    if (options.fresh) setAllBotsSkillOff(bot.id, name, false);
    const own = listSkills(bot.id).find((skill) => skill.name === name);
    if (!own) continue;
    const theirs = ownCopy(bot.id, name);
    if (!theirs || copyDigest(theirs) !== digest || "error" in removeSkill(bot.id, name)) {
      kept.push(bot.id);
      continue;
    }
    retired.push({ botId: bot.id, wasOff: !own.enabled, copy: theirs });
    if (!own.enabled) setAllBotsSkillOff(bot.id, name, true);
  }
  return { name, sha256, retired, kept };
}

/** Takes the skill off every bot of the person's; the bytes go to the library's archive, never deleted. */
export function removeFromAllBots(scope: string, name: string): { removed: SkillCopy } | { error: string } {
  const root = allBotsRoot(scope), current = readSkillLibraryIndex(root)[name], copy = sharedCopy(scope, name);
  if (!current) return { error: `no skill named "${name}" is on all your bots` };
  const retired = retireLibrarySkill(name, current.sha256, root);
  if (!("retired" in retired)) return { error: "stale" in retired ? `"${name}" changed outside OpenMausBot; try again` : retired.error };
  return { removed: copy ?? { skillMd: "", files: [], source: current.source } };
}

/** Undo of a put: gives each bot that gave way its own copy back, in the state it was in. */
export function restoreOwnCopies(name: string, retired: readonly RetiredCopy[]): void {
  for (const { botId, wasOff, copy } of retired) {
    if (listSkills(botId).some((skill) => skill.name === name)) continue;
    const learned = copy.source.startsWith(LEARN_SOURCE_PREFIX) && copy.files.every((file) => typeof file.content === "string" && file.path.startsWith("references/"));
    if (learned) {
      const staged = stageSkillWrite(botId, { action: "create", files: [{ path: "SKILL.md", content: copy.skillMd }, ...copy.files as Array<{ path: string; content: string }>], source: copy.source });
      if ("error" in staged) continue;
      const applied = applySkillWriteWithReceipt(botId, staged, () => {});
      if ("error" in applied) { rejectStagedSkillWrite(botId, staged.id); continue; }
    } else {
      const installed = installSkill(botId, copy.source, [{ path: "SKILL.md", content: copy.skillMd }, ...copy.files]);
      if ("error" in installed) continue;
    }
    setSkillEnabled(botId, name, !wasOff);
    setAllBotsSkillOff(botId, name, false);
  }
}
