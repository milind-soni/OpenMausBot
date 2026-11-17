// The files beside a stored skill's SKILL.md, read for a template. Security: only the files its record lists, and only
// while they still hash as they came in; never a walk of the folder, where a run may have left a cache, a lockfile or an
// .env beside the skill.
import { join } from "node:path";

import { readNoFollow, skillFolderDigest } from "./skill-folder.ts";
import { librarySkillDirectory, readSkillLibraryIndex, skillsLibraryRoot } from "./skill-library.ts";
import { readManifest, readSkillReferences, skillDirectory } from "./skills.ts";

/** The files, or null when they no longer match what came in. */
export type StoredSkillFiles = Array<{ path: string; content: string | Uint8Array }> | null;

function listedFiles(dir: string | null, paths: readonly string[] | undefined, sha256: string | undefined): StoredSkillFiles {
  if (!paths?.length) return [];
  if (!dir || !sha256 || skillFolderDigest(dir, paths) !== sha256) return null;
  const files: Array<{ path: string; content: Uint8Array }> = [];
  for (const path of paths) {
    const bytes = readNoFollow(join(dir, ...path.split("/")));
    if (bytes === null) return null;
    files.push({ path, content: new Uint8Array(bytes) });
  }
  return files;
}

/** A bot's own skill: an import's files, or a learned skill's reviewed references. */
export function ownSkillFiles(botId: string, name: string): StoredSkillFiles {
  const entry = readManifest(botId)[name];
  if (!entry) return [];
  if (entry.files?.length) return listedFiles(skillDirectory(botId, name, entry), entry.files, entry.filesSha256);
  return entry.referencesSha256 ? readSkillReferences(botId, name) : [];
}

/** A skill of the organization's library on this server. */
export function librarySkillFiles(name: string, root: string = skillsLibraryRoot()): StoredSkillFiles {
  const entry = readSkillLibraryIndex(root)[name];
  return entry ? listedFiles(librarySkillDirectory(root, name), entry.files, entry.filesSha256) : [];
}
