// Optional disk archive of each compact recap. The live inject is still
// only the latest vector; these files are for the user to compare.
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export const VECTOR_ARCHIVE_DIRNAME = "state-vectors";
export const VECTOR_ARCHIVE_KEEP = 40;
export const VECTOR_ARCHIVE_PATH_MAX = 1024;

export function forbiddenArchiveDir(dir: string): boolean {
  let resolved: string;
  try {
    resolved = resolve(dir.trim());
  } catch {
    return true;
  }
  // Normalize to posix-ish lower case so Windows drive letters and slash style
  // do not bypass the same system-folder checks as Unix ("/Applications" → "D:\\Applications").
  const asPosix = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const unix = asPosix(resolved);
  const home = asPosix(resolve(homedir()));
  // Unix root, Windows drive roots (C:), or the user's home directory itself.
  if (unix === "/" || /^[a-z]:$/.test(unix) || unix === home) return true;
  // Strip "d:" so "d:/applications" is checked like "/applications".
  const segments = unix.replace(/^[a-z]:/, "").split("/").filter(Boolean);
  if (segments.length === 0) return true;
  // Exact top-level user/volume mounts — children like /Users/max/project stay allowed.
  if (segments.length === 1 && ["users", "home", "volumes"].includes(segments[0]!)) return true;
  const first = segments[0]!;
  return [
    "applications",
    "system",
    "usr",
    "bin",
    "sbin",
    "etc",
    "private",
    "cores",
    "opt",
    "library",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
  ].includes(first);
}

export function isUsableArchiveDir(dir: string | null | undefined): dir is string {
  if (!dir || typeof dir !== "string") return false;
  const trimmed = dir.trim();
  if (!trimmed || trimmed.length > VECTOR_ARCHIVE_PATH_MAX) return false;
  if (!isAbsolute(trimmed)) return false;
  return !forbiddenArchiveDir(trimmed);
}

function safeLabel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "bot";
}

function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

export function vectorArchiveFilename(botLabel: string, at = new Date()): string {
  return `compact_${safeLabel(botLabel)}_${stamp(at)}.md`;
}

export function defaultVectorArchiveDir(privateWorkspace: string): string {
  return join(resolve(privateWorkspace), VECTOR_ARCHIVE_DIRNAME);
}

export function resolveVectorArchiveDir(input: {
  customDir?: string | null;
  fallbackDir: string;
}): string | null {
  const custom = input.customDir?.trim() || null;
  if (custom) return isUsableArchiveDir(custom) ? resolve(custom) : null;
  const fallback = input.fallbackDir.trim();
  if (!fallback) return null;
  const dir = defaultVectorArchiveDir(fallback);
  return forbiddenArchiveDir(dir) ? null : dir;
}

function pruneArchive(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^compact_.*\.md$/i.test(name));
  } catch {
    return;
  }
  if (names.length <= VECTOR_ARCHIVE_KEEP) return;
  const ranked = names
    .map((name) => {
      try {
        return { name, path: join(dir, name) };
      } catch {
        return null;
      }
    })
    .filter((row): row is { name: string; path: string } => Boolean(row))
    .sort((a, b) => a.name.localeCompare(b.name));
  const extra = ranked.length - VECTOR_ARCHIVE_KEEP;
  for (const row of ranked.slice(0, extra)) {
    try {
      unlinkSync(row.path);
    } catch {
      /* ignore */
    }
  }
}

/** Write one recap. Returns the path, or null when the folder is unusable.
 * Never throws — compact must not fail because the archive disk hiccuped. */
export function archiveStateVector(input: {
  summary: string;
  fallbackDir: string;
  customDir?: string | null;
  botLabel: string;
  at?: Date;
}): string | null {
  const body = input.summary.trim();
  if (!body) return null;
  const dir = resolveVectorArchiveDir({ customDir: input.customDir, fallbackDir: input.fallbackDir });
  if (!dir) return null;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, vectorArchiveFilename(input.botLabel, input.at ?? new Date()));
    writeFileAtomic(path, `${body}\n`, { mode: 0o600 });
    pruneArchive(dir);
    return path;
  } catch {
    return null;
  }
}
