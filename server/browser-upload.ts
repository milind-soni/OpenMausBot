import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, read, readdirSync, readlinkSync, realpathSync, rmSync, statSync, write, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import { BROWSER_UPLOAD_MAX_BYTES, FILE_MAX_BYTES } from "../shared/upload-limits.ts";
import { safeFileName } from "./browser/cdp/downloads.ts";
import { inSecretFolder, SECRET_FILE_REFUSAL } from "./secret-folder.ts";

const MAX_FILES = 10;
const readChunk = promisify(read), writeChunk = promisify(write);
// Node 24 omits Darwin's O_NOFOLLOW_ANY, which rejects symlinks in every path component.
const O_NOFOLLOW_ANY = 0x20000000;
const NAMED_COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class BrowserUploadRefusal extends Error {}

function realRoot(root: string): string | null {
  try { return realpathSync.native(root); } catch { return null; }
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
    try { real = realpathSync.native(path); } catch { return { error: `${file} does not exist.` }; }
    if (!allowed.some((root) => inside(root, real))) {
      return { error: `${file} is not one of this conversation's attachments or in your working folder, so it cannot be uploaded. Ask the person to attach the file.` };
    }
    if (inSecretFolder(real)) return { error: SECRET_FILE_REFUSAL };
    if (!statSync(real).isFile()) return { error: `${file} is not a file.` };
    resolved.push(real);
  }
  return { files: resolved };
}

/** Chrome names an uploaded file after its file on disk and reads it only when the form is sent, so an attachment stored
 * under a random id gets a copy with the person's own name that outlives the call. `everyFile`: stage every file in
 * `folder`, outside the bot's writable workspace. */
export async function namedUploadPaths(files: ReadonlyArray<{ file: string; name: string | null }>, folder: string, now = Date.now(), { everyFile = false } = {}): Promise<string[]> {
  sweepNamedCopies(folder, now);
  const created: string[] = [];
  const opened: Array<{ input: number; size: number }> = [];
  try {
    let total = 0;
    const prepared = files.map(({ file, name: given }) => {
      const name = given && basename(given) === given ? given : everyFile ? basename(file) : null;
      if (!name || (name === basename(file) && !everyFile)) return { file };
      const source = openUpload(file);
      opened.push(source);
      total += source.size;
      if (total > BROWSER_UPLOAD_MAX_BYTES) throw new BrowserUploadRefusal("Uploads are limited to 100 MiB per batch.");
      return { file, name, source };
    });
    const paths: string[] = [];
    for (const entry of prepared) {
      if (!entry.source) { paths.push(entry.file); continue; }
      const dir = join(folder, randomUUID());
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      created.push(dir);
      const named = join(dir, entry.name);
      await copyUpload(entry.source, named, entry.file);
      paths.push(named);
    }
    return paths;
  } catch (error) {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    for (const { input } of opened) closeSync(input);
  }
}

function openUpload(source: string): { input: number; size: number } {
  // Windows has no O_NOFOLLOW: there the copy is read from the path the allowlist just checked, before any wait.
  const flags = process.platform === "win32" ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === "darwin" ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW);
  const input = openSync(source, flags);
  try {
    if (process.platform === "linux" && readlinkSync(`/proc/self/fd/${input}`) !== source) throw new BrowserUploadRefusal(`${source} changed while staging the upload.`);
    const file = fstatSync(input, { bigint: true });
    if (!file.isFile()) throw new BrowserUploadRefusal(`${source} is not a file.`);
    if (file.size > BigInt(FILE_MAX_BYTES)) throw new BrowserUploadRefusal("Uploads are limited to 25 MiB per file.");
    return { input, size: Number(file.size) };
  } catch (error) {
    closeSync(input);
    throw error;
  }
}

async function copyUpload({ input, size }: { input: number; size: number }, destination: string, source: string): Promise<void> {
  const output = openSync(destination, "wx", 0o600);
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let remaining = size; remaining > 0;) {
      const { bytesRead: count } = await readChunk(input, chunk, 0, Math.min(chunk.length, remaining), null);
      if (!count) throw new BrowserUploadRefusal(`${source} changed while staging the upload.`);
      let offset = 0;
      while (offset < count) {
        const { bytesWritten } = await writeChunk(output, chunk, offset, count - offset, null);
        if (!bytesWritten) throw new Error(`Could not stage ${source}.`);
        offset += bytesWritten;
      }
      remaining -= count;
    }
  } finally {
    closeSync(output);
  }
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
