import { constants, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DATA_DIR } from "./config.ts";

/**
 * Without the bot box (or outside a conversation's own folder) a turn names the person's upload by its place in the
 * attachment store, and an engine with file tools can save its edit over it, in place or by renaming a new file over
 * it. So each document the person uploads is copied once, as it arrives and before any turn can see it, into this
 * private folder that no turn is told about. The person's own message and the original side of a comparison read the
 * copy, which is exactly what they sent. Only documents a bot might edit, up to KEEP_MAX_BYTES each; when the folder
 * reaches KEPT_TOTAL_MAX_BYTES the oldest copies make room. A copy goes when its upload does.
 */
export const keptOriginalsDir = (dataDir: string) => join(dataDir, "attachment-originals");
export const KEPT_ORIGINALS_DIR = keptOriginalsDir(DATA_DIR);
export const KEEP_MAX_BYTES = 4 * 1024 * 1024;
export const KEPT_TOTAL_MAX_BYTES = 256 * 1024 * 1024;

const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.([a-z0-9]+)$/i;
const DOCUMENT = new Set(["md", "txt", "csv", "tsv", "json", "rtf", "doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp"]);

export function isKeptDocumentName(name: string): boolean {
  const match = STORED_NAME.exec(name);
  return Boolean(match && DOCUMENT.has(match[1]!.toLowerCase()));
}

/** What the folder holds, for Settings › General's storage figure. */
export function keptOriginalsBytes(keptDir = KEPT_ORIGINALS_DIR): number {
  let total = 0;
  let names: string[] = [];
  try { names = readdirSync(keptDir); } catch { return 0; }
  for (const name of names) {
    try { total += statSync(join(keptDir, name)).size; } catch { /* gone meanwhile */ }
  }
  return total;
}

/** Oldest copies first, until `size` more bytes fit under the total. */
async function makeRoom(keptDir: string, size: number, total: number): Promise<void> {
  const files = (await Promise.all((await readdir(keptDir).catch(() => [] as string[])).map(async (name) => {
    const info = await stat(join(keptDir, name)).catch(() => null);
    return info?.isFile() ? { name, size: info.size, at: info.mtimeMs } : null;
  }))).filter((file): file is { name: string; size: number; at: number } => file !== null);
  let used = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.at - b.at)) {
    if (used + size <= total) return;
    await rm(join(keptDir, file.name), { force: true }).catch(() => undefined);
    used -= file.size;
  }
}

/** Keeps a copy of an upload the person just sent, before any turn names it. Never throws into the upload. */
export async function keepUploadedOriginal(path: string, keptDir = KEPT_ORIGINALS_DIR, total = KEPT_TOTAL_MAX_BYTES): Promise<void> {
  const name = basename(path);
  if (!isKeptDocumentName(name)) return;
  const target = join(keptDir, name);
  const partial = `${target}.${process.pid}.partial`;
  try {
    if (existsSync(target)) return;
    const { size } = await stat(path);
    if (size > KEEP_MAX_BYTES) return;
    await mkdir(keptDir, { recursive: true, mode: 0o700 });
    await makeRoom(keptDir, size, total);
    // A clone where the file system has them (APFS, Btrfs): no bytes are copied until one side changes.
    await copyFile(path, partial, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    await rename(partial, target);
  } catch {
    // The upload stands; it simply has no kept copy, and a comparison says so.
  } finally {
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

/** The kept copy of a stored upload, or null when there is none. */
export function keptOriginal(path: string, attachmentsDir: string, keptDir = KEPT_ORIGINALS_DIR): string | null {
  const name = basename(path);
  if (resolve(dirname(path)) !== resolve(attachmentsDir) || !isKeptDocumentName(name)) return null;
  const target = join(keptDir, name);
  return existsSync(target) ? target : null;
}

export function dropKeptOriginals(names: readonly string[], keptDir = KEPT_ORIGINALS_DIR): void {
  for (const name of names) {
    if (!isKeptDocumentName(name)) continue;
    try {
      rmSync(join(keptDir, name), { force: true });
    } catch { /* a busy file on Windows stays until the next removal */ }
  }
}

/** Copies whose upload is gone (removed outside the app, or while a copy was busy): Settings' Clear removes them. */
export function dropOrphanKeptOriginals(attachmentsDir: string, keptDir = KEPT_ORIGINALS_DIR): number {
  let names: string[] = [];
  try { names = readdirSync(keptDir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (name.endsWith(".partial") || existsSync(join(attachmentsDir, name))) continue;
    try {
      rmSync(join(keptDir, name), { force: true });
      removed += 1;
    } catch { /* tried again at the next clear */ }
  }
  return removed;
}
