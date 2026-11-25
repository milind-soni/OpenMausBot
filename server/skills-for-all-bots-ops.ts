// Putting a skill on all of a person's bots, changing it there and taking it off again, and keeping each bot's own copy
// in step with the person's record (skills-for-all-bots.ts). A bot that already had the very same skill keeps its copy,
// now marked as shared ("adopted"), and keeps it as its own again when the skill is taken off all bots; a bot whose own
// copy differs keeps it (its own skill wins the name) and is reported.
import { createHash } from "node:crypto";

import { installLibrarySkill, readLibrarySkillFile, readSkillLibraryIndex, retireLibrarySkill, updateLibrarySkill } from "./skill-library.ts";
import { librarySkillFiles, ownSkillFiles } from "./skill-side-files.ts";
import { installSkill, listSkills, readManifest, readSkillFile, removeSkill, setSharedSkillMark, setSharedSkills, setSkillEnabled } from "./skills.ts";
import {
  allBotsRoot, allBotsScopeOfBot, allBotsStore, botsInAllBotsScope, ensureAllBotsStore, entryKey, forgetAllBotsStore, sharedMarkCurrent,
  wireSkillsForAllBots, type AllBotsBot,
} from "./skills-for-all-bots.ts";

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
  const entry = readManifest(botId)[name];
  const skillMd = entry ? readSkillFile(botId, name) : null, files = entry ? ownSkillFiles(botId, name) : null;
  return entry && skillMd !== null && files !== null ? { skillMd, files, source: entry.source } : null;
}

export function sharedCopy(scope: string, name: string): SkillCopy | null {
  const root = allBotsRoot(scope), entry = readSkillLibraryIndex(root)[name];
  const skillMd = entry ? readLibrarySkillFile(name, root) : null, files = entry ? librarySkillFiles(name, root) : null;
  return entry && skillMd !== null && files !== null ? { skillMd, files, source: entry.source } : null;
}

const syncing = new Set<string>();
/** Own copies already found to differ from the person's, so a listing does not read them again. */
const differs = new Set<string>();

function installCopy(botId: string, scope: string, store: string, name: string, enabled: boolean, adopted?: true): boolean {
  const copy = sharedCopy(scope, name), entry = allBotsStore(scope).entries[name];
  if (!copy || !entry) return false;
  const installed = installSkill(botId, copy.source, [{ path: "SKILL.md", content: copy.skillMd }, ...copy.files]);
  if ("error" in installed) return false;
  if (enabled && "error" in setSkillEnabled(botId, name, true)) return false;
  setSharedSkillMark(botId, name, { store, sha256: entryKey(entry), ...(adopted ? { adopted } : {}) });
  return true;
}

/** Brings one bot's copies in step with its person's record: adds what it lacks, rewrites what changed (keeping its
 * switch), takes away what was removed (giving an adopted copy back as its own), and adopts an identical own copy.
 * Returns the names it could not bring in step; the next listing tries them again. */
export function syncBotCopies(bot: AllBotsBot | null | undefined): string[] {
  const scope = allBotsScopeOfBot(bot);
  return scope && bot ? syncInScope(bot.id, scope) : [];
}

/** Set once by the server: whose bots are whose, and a bot's copies kept in step as its skills are listed. */
export function wireAllBotsSkills(next: Parameters<typeof wireSkillsForAllBots>[0]): void {
  wireSkillsForAllBots(next);
  setSharedSkills(next ? { list: (botId) => { syncBotCopies(next.bot(botId)); }, current: sharedMarkCurrent } : null);
}

export function syncInScope(botId: string, scope: string): string[] {
  const store = allBotsStore(scope);
  if (!store.id || syncing.has(botId)) return [];
  syncing.add(botId);
  const failed: string[] = [];
  try {
    const manifest = readManifest(botId);
    for (const [name, entry] of Object.entries(manifest)) {
      const mark = entry.allBots;
      if (!mark || mark.store !== store.id) continue;
      const wanted = store.entries[name];
      if (!wanted) {
        if (mark.adopted) setSharedSkillMark(botId, name, undefined);
        else if ("error" in removeSkill(botId, name)) failed.push(name);
      } else if (mark.sha256 !== entryKey(wanted)) {
        if ("error" in removeSkill(botId, name) || !installCopy(botId, scope, store.id, name, entry.enabled, mark.adopted)) failed.push(name);
      }
    }
    for (const [name, wanted] of Object.entries(store.entries)) {
      const entry = manifest[name];
      if (!entry) {
        if (!installCopy(botId, scope, store.id, name, true)) failed.push(name);
        continue;
      }
      if (entry.allBots?.store === store.id) continue;
      const seen = [botId, name, entry.sha256, entry.filesSha256 ?? entry.referencesSha256 ?? "", entryKey(wanted)].join("\0");
      if (differs.has(seen)) continue;
      if (differs.size > 10_000) differs.clear();
      const theirs = ownCopy(botId, name), shared = sharedCopy(scope, name);
      if (theirs && shared && copyDigest(theirs) === copyDigest(shared)) setSharedSkillMark(botId, name, { store: store.id, sha256: entryKey(wanted), adopted: true });
      else differs.add(seen);
    }
  } finally {
    syncing.delete(botId);
  }
  return failed;
}

export interface Fanned {
  /** Bots that keep a different copy of their own under the same name. */
  kept: string[];
  /** Bots that could not be brought in step yet; their next listing tries again. */
  failed: string[];
}

function fanOut(scope: string, name: string): Fanned {
  const kept: string[] = [], failed: string[] = [];
  const store = allBotsStore(scope);
  for (const bot of botsInAllBotsScope(scope)) {
    if (syncInScope(bot.id, scope).includes(name)) failed.push(bot.id);
    const entry = readManifest(bot.id)[name];
    if (store.entries[name] && entry && entry.allBots?.store !== store.id) kept.push(bot.id);
  }
  return { kept, failed };
}

/** Adds the skill to every bot of the person's, or replaces the copy they share. The record changes all at once or not at
 * all: when a replacement cannot be stored, the copy it replaced is put back. */
export function putOnAllBots(scope: string, name: string, copy: SkillCopy): Fanned | { error: string } {
  const root = allBotsRoot(scope);
  ensureAllBotsStore(scope);
  const current = readSkillLibraryIndex(root)[name];
  const existing = current ? sharedCopy(scope, name) : null;
  if (current && !existing) return { error: `the copy of "${name}" on all your bots changed outside OpenMausBot; remove it and add it again` };
  try {
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
        if ("error" in installed) {
          if (existing) installLibrarySkill({ name, instructions: existing.skillMd, source: existing.source, reviewState: "approved", ...(existing.files.length ? { files: existing.files } : {}), root });
          return installed;
        }
      }
    }
  } finally {
    forgetAllBotsStore(scope);
  }
  return fanOut(scope, name);
}

export interface Removed extends Fanned {
  removed: SkillCopy;
  /** Each bot's switch for it as it was, so Undo puts them back. */
  switches: Array<{ botId: string; enabled: boolean }>;
}

/** Takes the skill off every bot of the person's: a bot that had it before keeps that copy as its own; the record's bytes
 * go to the library's archive, never deleted. */
export function removeFromAllBots(scope: string, name: string): Removed | { error: string } {
  const root = allBotsRoot(scope), current = readSkillLibraryIndex(root)[name], copy = sharedCopy(scope, name);
  if (!current) return { error: `no skill named "${name}" is on all your bots` };
  const store = allBotsStore(scope).id;
  const switches = botsInAllBotsScope(scope).flatMap((bot) => {
    const entry = readManifest(bot.id)[name];
    return entry?.allBots?.store === store ? [{ botId: bot.id, enabled: entry.enabled }] : [];
  });
  const retired = retireLibrarySkill(name, current.sha256, root);
  forgetAllBotsStore(scope);
  if (!("retired" in retired)) return { error: "stale" in retired ? `"${name}" changed outside OpenMausBot; try again` : retired.error };
  const fanned = fanOut(scope, name);
  return { ...fanned, removed: copy ?? { skillMd: "", files: [], source: current.source }, switches };
}

/** Undo of a removal: each bot's switch as it was. */
export function restoreSwitches(name: string, switches: ReadonlyArray<{ botId: string; enabled: boolean }>): string[] {
  const failed: string[] = [];
  for (const { botId, enabled } of switches) {
    const entry = listSkills(botId).find((skill) => skill.name === name);
    if (!entry?.allBots || ("error" in setSkillEnabled(botId, name, enabled))) failed.push(botId);
  }
  return failed;
}
