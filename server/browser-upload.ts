import { randomUUID } from "node:crypto";
import { copyFileSync, linkSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

import { safeFileName } from "./browser/cdp/downloads.ts";

const MAX_FILES = 10;
const NAMED_COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function realRoot(root: string): string | null {
  try { return realpathSync(root); } catch { return null; }
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** A page may receive only the person's attachments and the bot's own folders; symlinks are followed before the check. */
export function uploadableFiles(files: unknown, roots: readonly string[]): { files: string[] } | { error: string } {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES || !files.every((file) => typeof file === "string" && file)) {
    return { error: `files must list 1 to ${MAX_FILES} absolute file paths.` };
  }
  const allowed = roots.flatMap((root) => realRoot(root) ?? []);
  const resolved: string[] = [];
  for (const file of files as string[]) {
    const path = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
    if (!isAbsolute(path)) return { error: `${file} is not an absolute path.` };
    let real: string;
    try { real = realpathSync(path); } catch { return { error: `${file} does not exist.` }; }
    if (!allowed.some((root) => inside(root, real))) {
      return { error: `${file} is not one of this conversation's attachments or in your working folder, so it cannot be uploaded. Ask the person to attach the file.` };
    }
    if (!statSync(real).isFile()) return { error: `${file} is not a file.` };
    resolved.push(real);
  }
  return { files: resolved };
}

/** Chrome names an uploaded file after its file on disk and reads it only when the form is sent, so an attachment stored
 * under a random id gets a link with the person's own name that outlives the call. `everyFile`: a boxed Chrome sees only
 * `folder`, so each file gets a link there. */
export function namedUploadPaths(files: ReadonlyArray<{ file: string; name: string | null }>, folder: string, now = Date.now(), { everyFile = false } = {}): string[] {
  sweepNamedCopies(folder, now);
  return files.map(({ file, name: given }) => {
    const name = given && basename(given) === given ? given : everyFile ? basename(file) : null;
    if (!name || (name === basename(file) && !everyFile)) return file;
    const dir = join(folder, randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const named = join(dir, name);
    try { linkSync(file, named); } catch { copyFileSync(file, named); }
    return named;
  });
}

/** Files a person picked on their own device for a page's file picker, kept under their own names for a day. */
export function storeUploads(files: ReadonlyArray<{ name: string; bytes: Uint8Array }>, folder: string, now = Date.now()): string[] {
  sweepNamedCopies(folder, now);
  return files.map(({ name, bytes }) => {
    const dir = join(folder, randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, safeFileName(name));
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  });
}

function sweepNamedCopies(folder: string, now: number): void {
  let entries: string[];
  try { entries = readdirSync(folder); } catch { return; }
  for (const entry of entries) {
    const dir = join(folder, entry);
    try { if (now - statSync(dir).mtimeMs > NAMED_COPY_MAX_AGE_MS) rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
