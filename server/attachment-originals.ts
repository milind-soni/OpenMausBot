import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { decodeAttachmentAttribute } from "../src/lib/composer-attachments.ts";
import { DATA_DIR } from "./config.ts";

/**
 * Without the bot box a turn names the person's upload by its place in the attachment store, and an engine with file tools
 * can save its edit over it (the store is writable, and some engines replace a file by renaming over it). Before such a
 * turn, each document it names is copied once into this private folder, which no turn is told about: the person's own
 * message and the comparison of an edit read the copy, so what they sent is never lost. Copies are made only of
 * documents a bot might edit, up to KEEP_MAX_BYTES each and KEPT_TOTAL_MAX_BYTES together, and go when the upload does.
 */
export const keptOriginalsDir = (dataDir: string) => join(dataDir, "attachment-originals");
export const KEPT_ORIGINALS_DIR = keptOriginalsDir(DATA_DIR);
export const KEEP_MAX_BYTES = 10 * 1024 * 1024;
export const KEPT_TOTAL_MAX_BYTES = 256 * 1024 * 1024;

const TAG = /<attached-file[\t ]+path="([^"\r\n]*)"/g;
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.([a-z0-9]+)$/i;
const DOCUMENT = new Set(["md", "txt", "csv", "tsv", "json", "rtf", "doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp"]);

let kept: { dir: string; bytes: number } | null = null;

function usedBytes(dir: string): number {
  if (kept?.dir === dir) return kept.bytes;
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      try { total += statSync(join(dir, name)).size; } catch { /* gone meanwhile */ }
    }
  } catch { /* no folder yet */ }
  kept = { dir, bytes: total };
  return total;
}

export function isKeptDocumentName(name: string): boolean {
  const match = STORED_NAME.exec(name);
  return Boolean(match && DOCUMENT.has(match[1]!.toLowerCase()));
}

/** Keeps a copy of each stored document the text names, the first time a turn names it. Never throws into the turn. */
export function keepAttachedOriginals(text: string, attachmentsDir: string, keptDir = KEPT_ORIGINALS_DIR): void {
  if (!text.includes("<attached-file")) return;
  const store = resolve(attachmentsDir);
  for (const match of text.matchAll(TAG)) {
    const path = decodeAttachmentAttribute(match[1]!), name = basename(path);
    if (resolve(dirname(path)) !== store || !isKeptDocumentName(name)) continue;
    const target = join(keptDir, name);
    if (existsSync(target)) continue;
    try {
      const size = statSync(path).size, used = usedBytes(keptDir);
      if (size > KEEP_MAX_BYTES || used + size > KEPT_TOTAL_MAX_BYTES) continue;
      mkdirSync(keptDir, { recursive: true, mode: 0o700 });
      const partial = `${target}.${process.pid}.partial`;
      try {
        // A clone where the file system has them (APFS, Btrfs): no bytes are copied until one side changes.
        copyFileSync(path, partial, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
        renameSync(partial, target);
        kept = { dir: keptDir, bytes: used + size };
      } finally {
        rmSync(partial, { force: true });
      }
    } catch { /* the turn goes ahead; this upload simply has no kept copy */ }
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
  if (names.length) kept = null;
}

export function __resetKeptOriginalsForTests(): void {
  kept = null;
}
