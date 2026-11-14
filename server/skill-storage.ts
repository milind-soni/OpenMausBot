// Learned-skill files on disk: SKILL.md plus at most MAX_SKILL_REFERENCES references/<topic>.md files,
// published as one immutable reviewed revision and never read through a symlink.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export const STAGED_SKILL_FILE_MAX_BYTES = 32 * 1024;
export const MAX_SKILL_REFERENCES = 8;
const SKILL_REFERENCE_PATH = /^references\/[a-z0-9][a-z0-9-]{0,63}\.md$/;

export function isSkillReferencePath(path: string): boolean {
  return SKILL_REFERENCE_PATH.test(path);
}

export function referencePathError(path: string): string {
  return `learned skill files must be SKILL.md or references/<topic>.md (lowercase letters, digits, and hyphens), not "${path}"`;
}

/** One hash over the reference files (paths and bytes), or undefined when there are none; SKILL.md keeps its own sha256. */
export function skillReferencesSha256(files: ReadonlyArray<{ path: string; content: string | Buffer }>): string | undefined {
  const references = files
    .filter((file) => file.path !== "SKILL.md")
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!references.length) return undefined;
  const hash = createHash("sha256");
  for (const file of references) {
    hash.update(`${file.path}\0${createHash("sha256").update(file.content).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

export function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export const REFERENCES_ADVICE =
  "Keep SKILL.md to the core steps and move detail (long rule lists, examples, lookup tables) into " +
  "references/<topic>.md files inside the skill — pass them as skill_manage references — then link each one " +
  "from SKILL.md, for example \"For edge cases, read references/<topic>.md.\"";

export type DirectoryEntryState = "missing" | "directory" | "unsafe";

export function directoryEntryState(path: string): DirectoryEntryState {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe";
  } catch {
    return "missing";
  }
}

export function entryExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function referenceLimitError(files: Array<{ path: string; content: string }>): string | null {
  const references = files.filter((file) => file.path !== "SKILL.md");
  for (const file of references) {
    if (!isSkillReferencePath(file.path)) return referencePathError(file.path);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > STAGED_SKILL_FILE_MAX_BYTES) {
      return `${file.path} must be at most ${STAGED_SKILL_FILE_MAX_BYTES / 1024}KB; it is ${formatKb(bytes)}. Split it into more references/<topic>.md files.`;
    }
  }
  if (new Set(references.map((file) => file.path)).size !== references.length) {
    return "each references/<topic>.md file may appear only once";
  }
  if (references.length > MAX_SKILL_REFERENCES) {
    return `a learned skill may have at most ${MAX_SKILL_REFERENCES} references/<topic>.md files; it would have ${references.length}. Merge related topics.`;
  }
  return null;
}

/** Null when the directory holds anything review could not have produced. */
export function readReferenceFiles(directory: string): Array<{ path: string; content: string }> | null {
  const references = join(directory, "references");
  if (directoryEntryState(references) !== "directory") return null;
  const names = readdirSync(references).sort();
  if (!names.length || names.length > MAX_SKILL_REFERENCES) return null;
  const files: Array<{ path: string; content: string }> = [];
  for (const name of names) {
    const path = `references/${name}`;
    if (!isSkillReferencePath(path)) return null;
    const stat = lstatSync(join(references, name));
    if (!stat.isFile() || stat.size > STAGED_SKILL_FILE_MAX_BYTES) return null;
    files.push({ path, content: readFileSync(join(references, name), "utf8") });
  }
  return files;
}

export function learnedSkillDirectoryMatches(directory: string, sha256: string, referencesSha256?: string): boolean {
  if (directoryEntryState(directory) !== "directory") return false;
  try {
    const entries = readdirSync(directory).sort();
    const expected = referencesSha256 ? ["SKILL.md", "references"] : ["SKILL.md"];
    if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) return false;
    const file = join(directory, "SKILL.md");
    if (!lstatSync(file).isFile()) return false;
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== sha256) return false;
    if (!referencesSha256) return true;
    const references = readReferenceFiles(directory);
    return references !== null && skillReferencesSha256(references) === referencesSha256;
  } catch {
    return false;
  }
}

function directoryIdentity(path: string): { dev: number; ino: number } | null {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(path: string, expected: { dev: number; ino: number }): boolean {
  const current = directoryIdentity(path);
  return current?.dev === expected.dev && current.ino === expected.ino;
}

/** The manifest selects this revision in a separate atomic write, so a crash never half-replaces a skill. */
export function publishReviewedRevision(
  dirs: { state: string; ensureSkillsRoot: () => string | null },
  stageId: string,
  files: Array<{ path: string; content: string }>,
  sha256: string,
  referencesSha256: string | undefined,
): string {
  // No agent-writable path is opened until the complete directory is published as one rename.
  const state = dirs.state;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (directoryEntryState(state) !== "directory") {
    throw new Error("the protected skill state path is not a real directory");
  }
  const preparedRoot = join(state, "reviewed-revisions");
  const preparedRootState = directoryEntryState(preparedRoot);
  if (preparedRootState === "unsafe") {
    throw new Error("the protected revision path is not a real directory");
  }
  if (preparedRootState === "missing") mkdirSync(preparedRoot, { mode: 0o700 });
  const revision = createHash("sha256").update(stageId).digest("hex");
  const prepared = join(preparedRoot, revision);
  if (!learnedSkillDirectoryMatches(prepared, sha256, referencesSha256)) {
    if (entryExistsWithoutFollowing(prepared)) {
      if (directoryEntryState(prepared) !== "directory") {
        throw new Error("the protected reviewed revision is not a real directory");
      }
      rmSync(prepared, { recursive: true, force: true });
    }
    const temporary = join(preparedRoot, `.prepare-${revision}-${randomUUID()}`);
    try {
      mkdirSync(temporary, { mode: 0o700 });
      for (const file of files) {
        const path = join(temporary, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileAtomic(path, file.content, { mode: 0o600 });
      }
      if (!learnedSkillDirectoryMatches(temporary, sha256, referencesSha256)) {
        throw new Error("the protected reviewed bytes do not match the approval card");
      }
      renameSync(temporary, prepared);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  const root = dirs.ensureSkillsRoot();
  if (!root) throw new Error("the workspace skills path must be a real directory, not a symlink or file");
  const rootIdentity = directoryIdentity(root);
  if (!rootIdentity) throw new Error("the workspace skills path changed during update");
  const revisions = join(root, ".revisions");
  const revisionsState = directoryEntryState(revisions);
  if (revisionsState === "unsafe") throw new Error("the skill revisions path is not a real directory");
  if (revisionsState === "missing") mkdirSync(revisions, { mode: 0o700 });
  const revisionsIdentity = directoryIdentity(revisions);
  if (!revisionsIdentity) throw new Error("the skill revisions path could not be created safely");

  const target = join(revisions, revision);
  if (learnedSkillDirectoryMatches(target, sha256, referencesSha256)) {
    try {
      rmSync(prepared, { recursive: true, force: true });
    } catch {}
    return revision;
  }
  if (entryExistsWithoutFollowing(target)) {
    throw new Error("the reviewed revision path already exists with different content");
  }
  if (!sameDirectoryIdentity(root, rootIdentity) || !sameDirectoryIdentity(revisions, revisionsIdentity)) {
    throw new Error("the workspace skills path changed during update");
  }

  renameSync(prepared, target);
  if (
    !sameDirectoryIdentity(root, rootIdentity) ||
    !sameDirectoryIdentity(revisions, revisionsIdentity) ||
    !learnedSkillDirectoryMatches(target, sha256, referencesSha256)
  ) {
    throw new Error("the reviewed revision changed while it was being published");
  }
  return revision;
}
