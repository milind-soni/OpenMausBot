// Move to Cloud (docs/cloud-pro.md): a person's one-time copy of their local
// workspace onto their OMB Cloud home. The desktop exports the ordinary
// encrypted workspace backup (workspace-backup.ts) and uploads it here in
// parts; this machine then previews and restores it like any other backup,
// so everything that backup policy keeps out (credentials, sign-ins, pairing
// and sessions, runtime state) stays where it is on both sides.
//
// What this file adds: the workspace's size and contents, a resumable upload
// slot, the space check for the machine's fixed-size volume, a backup of the
// Cloud's own workspace taken before it is replaced ("Restore previous Cloud"
// swaps it back), and the tidying that keeps that backup the only copy left
// behind. Everything lives under `.backups`, which no snapshot includes and
// no restore replaces.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./atomic.ts";
import {
  MAX_WORKSPACE_BACKUP_FILES, MAX_WORKSPACE_BACKUP_UPLOAD_BYTES, omittedFromWorkspaceBackup, removeWorkspaceBackupJob,
  stageWorkspaceBackup, type WorkspaceBackupSummary,
} from "./workspace-backup.ts";

/** The part size the desktop sends; a part may be at most CLOUD_MOVE_MAX_PART_BYTES. */
export const CLOUD_MOVE_PART_BYTES = 16 * 1024 ** 2;
export const CLOUD_MOVE_MAX_PART_BYTES = 64 * 1024 ** 2;
export const CLOUD_MOVE_MAX_BYTES = MAX_WORKSPACE_BACKUP_UPLOAD_BYTES;
export const CLOUD_MOVE_MAX_FILES = MAX_WORKSPACE_BACKUP_FILES;
/** Headroom kept free on the volume after a move's own files. */
export const CLOUD_MOVE_SPACE_MARGIN = 256 * 1024 ** 2;
// Encrypted header plus tag: anything smaller cannot be a backup.
const MIN_BYTES = 60;
const SHA256 = /^[a-f0-9]{64}$/;
// An upload nobody has touched for a day is abandoned, not resumable.
const UPLOAD_STALE_MS = 24 * 3600_000;

const fail = (message: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export interface WorkspaceContents { bots: number; rooms: number; chats: number }

function rosterLength(path: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.length : 0;
  } catch { return 0; }
}

/** What the person would call their work: bots, rooms, and the conversations
 * they took part in (a starter bot's greeting is not a chat). */
export function workspaceContents(dataDir: string): WorkspaceContents {
  let chats = 0;
  const database = join(dataDir, "messages.db");
  if (existsSync(database)) {
    const db = new DatabaseSync(database, { timeout: 5_000 });
    try {
      const columns = db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((row) => String(row.name));
      if (columns.length) {
        const who = columns.includes("role") ? "role" : "json_extract(json, '$.role')";
        chats = Number(db.prepare(`SELECT COUNT(DISTINCT thread_id) AS chats FROM messages WHERE ${who} = 'user'`).get()?.chats ?? 0);
      }
    } finally { db.close(); }
  }
  return { bots: rosterLength(join(dataDir, "bots.json")), rooms: rosterLength(join(dataDir, "groups.json")), chats };
}

/** A fresh machine: its one starter bot at most, no rooms, nobody has chatted. */
export function isEmptyWorkspace(contents: WorkspaceContents): boolean {
  return contents.bots <= 1 && contents.rooms === 0 && contents.chats === 0;
}

/** Bytes and files a backup of this workspace would carry, by the export's
 * own rules. An estimate: live files can change before the export. */
export function workspaceMoveSize(dataDir: string): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (omittedFromWorkspaceBackup(path)) continue;
      const stat = lstatSync(join(directory, name));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(join(directory, name), path);
      else if (stat.isFile()) { bytes += stat.size; files++; }
      if (files > CLOUD_MOVE_MAX_FILES) return;
    }
  };
  if (existsSync(dataDir)) walk(dataDir, "");
  return { bytes, files };
}

export function freeVolumeBytes(path: string): number {
  const disk = statfsSync(path, { bigint: true });
  const free = disk.bavail * disk.bsize;
  return free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free);
}

/** The whole volume, so the app can tell how far a disk that grows may still grow. */
export function totalVolumeBytes(path: string): number {
  const disk = statfsSync(path, { bigint: true });
  const total = disk.blocks * disk.bsize;
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
}

/** Routines switched on in this workspace. A move brings them paused, so the
 * app says how many to turn on there. */
export function enabledRoutineCount(dataDir: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8"));
    const routines = value && typeof value === "object" ? (value as { routines?: unknown }).routines : undefined;
    return Array.isArray(routines) ? routines.filter((routine) => routine && typeof routine === "object" && (routine as { enabled?: unknown }).enabled !== false).length : 0;
  } catch { return 0; }
}

/** Peak extra space a move of `upload` bytes needs: the upload, its decrypted
 * copy and its staged files exist together while it is checked; the restore
 * then installs from the staged copy. Replacing a workspace first backs it up
 * (a snapshot and its archive, briefly both). */
export function moveSpaceNeeded(upload: number, current: number, replacing: boolean): number {
  return 3 * upload + (replacing ? 2 * current : 0) + CLOUD_MOVE_SPACE_MARGIN;
}

function privateFolder(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("Backup storage must be a real folder, not a link.", 500);
  return path;
}
const backupsRoot = (dataDir: string) => privateFolder(join(dataDir, ".backups"));

// ── The upload slot ─────────────────────────────────────────────────────
// One upload at a time, named by the archive's SHA-256, so the same file can
// continue where a dropped connection left it and a repeated part is a no-op.

interface UploadMeta { sha256: string; bytes: number; updatedAt: number }
export interface UploadStatus { sha256: string; bytes: number; received: number }

// Reads never create the folder; beginUpload does.
const uploadFolder = (dataDir: string) => join(dataDir, ".backups", "cloud-move");
const uploadMetaPath = (dataDir: string) => join(uploadFolder(dataDir), "upload.json");
const uploadPartPath = (dataDir: string) => join(uploadFolder(dataDir), "upload.part");

function readUploadMeta(dataDir: string): UploadMeta | null {
  try {
    const value: unknown = JSON.parse(readFileSync(uploadMetaPath(dataDir), "utf8"));
    if (record(value) && typeof value.sha256 === "string" && SHA256.test(value.sha256) && Number.isSafeInteger(value.bytes) && Number.isSafeInteger(value.updatedAt)) {
      return value as unknown as UploadMeta;
    }
  } catch { /* none, or unreadable: a fresh upload replaces it */ }
  return null;
}

function receivedBytes(dataDir: string): number {
  try {
    const stat = lstatSync(uploadPartPath(dataDir));
    return stat.isFile() ? stat.size : 0;
  } catch { return 0; }
}

export function uploadStatus(dataDir: string): UploadStatus | null {
  const meta = readUploadMeta(dataDir);
  return meta ? { sha256: meta.sha256, bytes: meta.bytes, received: Math.min(receivedBytes(dataDir), meta.bytes) } : null;
}

export function discardUpload(dataDir: string): void {
  rmSync(uploadPartPath(dataDir), { force: true });
  rmSync(uploadMetaPath(dataDir), { force: true });
}

/** Check a declared upload: its size, file count and SHA-256. */
export function validUploadDeclaration(input: { sha256: unknown; bytes: unknown; files?: unknown }): { sha256: string; bytes: number } {
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) throw fail("This is not a workspace backup.", 400);
  if (!Number.isSafeInteger(input.bytes) || (input.bytes as number) < MIN_BYTES) throw fail("This is not a workspace backup.", 400);
  if ((input.bytes as number) > CLOUD_MOVE_MAX_BYTES) throw fail("This workspace is larger than the 10 GB a move can carry.", 413);
  if (input.files !== undefined && (!Number.isSafeInteger(input.files) || (input.files as number) < 0 || (input.files as number) > CLOUD_MOVE_MAX_FILES)) {
    throw fail("This workspace has more than the 100,000 files a move can carry.", 413);
  }
  return { sha256: input.sha256, bytes: input.bytes as number };
}

/** Start an upload, or continue the same file's upload where it stopped. */
export function beginUpload(dataDir: string, declared: { sha256: string; bytes: number }, now = Date.now()): UploadStatus {
  const existing = readUploadMeta(dataDir);
  if (existing && existing.sha256 === declared.sha256 && existing.bytes === declared.bytes && existing.updatedAt + UPLOAD_STALE_MS > now && receivedBytes(dataDir) <= declared.bytes) {
    writeFileAtomic(uploadMetaPath(dataDir), JSON.stringify({ ...existing, updatedAt: now }), { mode: 0o600 });
    return { ...declared, received: receivedBytes(dataDir) };
  }
  discardUpload(dataDir);
  backupsRoot(dataDir);
  privateFolder(uploadFolder(dataDir));
  writeFileSync(uploadPartPath(dataDir), "", { mode: 0o600, flag: "wx" });
  writeFileAtomic(uploadMetaPath(dataDir), JSON.stringify({ ...declared, updatedAt: now }), { mode: 0o600 });
  return { ...declared, received: 0 };
}

/** Store one part at `offset`. A part already stored is accepted again
 * without writing; any other offset than the next one answers where the
 * upload stands (409, `received`). A failed part is cut back off. */
export async function writeUploadPart(dataDir: string, sha256: string, offset: number, length: number, body: AsyncIterable<Buffer>, now = Date.now()): Promise<number> {
  const meta = readUploadMeta(dataDir);
  if (!meta || meta.sha256 !== sha256) throw fail("This upload is not in progress on your Cloud. Start the move again.", 404);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > CLOUD_MOVE_MAX_PART_BYTES) {
    throw fail("Invalid upload part.", 400);
  }
  if (offset + length > meta.bytes) throw fail("The upload is larger than the file it declared.", 413);
  const received = receivedBytes(dataDir);
  const drain = async () => { for await (const _chunk of body) { /* already stored */ } };
  if (offset + length <= received) { await drain(); return received; }
  if (offset !== received) { await drain(); throw fail("The upload continues from another point.", 409, { received }); }
  const handle = await open(uploadPartPath(dataDir), "r+");
  let written = 0;
  try {
    for await (const chunk of body) {
      if (written + chunk.length > length) throw fail("The upload part is larger than it declared.", 413);
      let done = 0;
      while (done < chunk.length) done += (await handle.write(chunk, done, chunk.length - done, offset + written + done)).bytesWritten;
      written += chunk.length;
    }
    if (written !== length) throw fail("The upload part was incomplete.", 400);
    await handle.sync();
  } catch (error) {
    await handle.truncate(received).catch(() => {});
    throw error;
  } finally { await handle.close(); }
  writeFileAtomic(uploadMetaPath(dataDir), JSON.stringify({ ...meta, updatedAt: now }), { mode: 0o600 });
  return received + length;
}

/** The complete upload's path, once its size and SHA-256 match what was declared. */
export async function completedUpload(dataDir: string, sha256: string): Promise<string> {
  const status = uploadStatus(dataDir);
  if (!status || status.sha256 !== sha256) throw fail("This upload is not in progress on your Cloud. Start the move again.", 404);
  if (status.received !== status.bytes) throw fail("The upload is not complete yet.", 409, { received: status.received });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(uploadPartPath(dataDir), { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== sha256) {
    discardUpload(dataDir);
    throw fail("The uploaded file was damaged on the way. Start the move again.", 400);
  }
  return uploadPartPath(dataDir);
}

// ── The previous Cloud ──────────────────────────────────────────────────
// Before a move replaces the Cloud's workspace, and before Restore previous
// Cloud swaps it back, the workspace about to be replaced is backed up. That
// one archive is the only undo point kept: once startup has installed the
// restore, the restore's own safety copy and staged files are deleted
// (tidyCloudMoveStorage). The archive's random password sits beside it: this
// is the machine's own data on its own volume.
//
// The new backup waits in `cloud-previous.next` until startup has installed
// the restore it was made for; a restore that never commits or rolls back
// leaves the previous Cloud as it was.

interface PreviousMeta { password: string; createdAt: string; contents: WorkspaceContents; forRestore?: string }
export interface PreviousCloud { createdAt: string; bots: number; rooms: number; chats: number; bytes: number }

const previousFolder = (dataDir: string) => join(dataDir, ".backups", "cloud-previous");
const nextPreviousFolder = (dataDir: string) => join(dataDir, ".backups", "cloud-previous.next");
const moveRestoresPath = (dataDir: string) => join(dataDir, ".backups", "cloud-move-restores.json");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readPrevious(folder: string): PreviousMeta | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(folder, "previous.json"), "utf8"));
    if (!record(value) || typeof value.password !== "string" || typeof value.createdAt !== "string" || !record(value.contents)) return null;
    if (!lstatSync(join(folder, "workspace.ombbackup")).isFile()) return null;
    return value as unknown as PreviousMeta;
  } catch { return null; }
}

/** The previous Cloud that can be put back, never its password. A fresh
 * Cloud's (its starter bot, nothing else) is kept but not offered. */
export function previousCloud(dataDir: string): PreviousCloud | null {
  const previous = readPrevious(previousFolder(dataDir));
  if (!previous || isEmptyWorkspace(previous.contents)) return null;
  return { createdAt: previous.createdAt, ...previous.contents, bytes: lstatSync(join(previousFolder(dataDir), "workspace.ombbackup")).size };
}

/** Back up this workspace as the next previous Cloud, for the restore
 * `restoreId`. `create` is createWorkspaceBackup, run by the caller inside
 * the maintenance gate. It becomes the previous Cloud only once startup has
 * installed that restore. */
export async function prepareNextPreviousCloud(dataDir: string, restoreId: string, create: (password: string) => Promise<{ id: string; path: string }>): Promise<Omit<PreviousCloud, "bytes">> {
  const password = randomBytes(32).toString("base64url");
  const contents = workspaceContents(dataDir);
  const created = await create(password);
  const next = nextPreviousFolder(dataDir);
  try {
    backupsRoot(dataDir);
    rmSync(next, { recursive: true, force: true });
    privateFolder(next);
    renameSync(created.path, join(next, "workspace.ombbackup"));
    const meta: PreviousMeta = { password, createdAt: new Date().toISOString(), contents, forRestore: restoreId };
    writeFileAtomic(join(next, "previous.json"), JSON.stringify(meta), { mode: 0o600 });
    return { createdAt: meta.createdAt, ...contents };
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    throw error;
  } finally {
    try { removeWorkspaceBackupJob(dataDir, created.id); } catch { /* The export job expires with the others. */ }
  }
}

/** Drop a next previous Cloud whose restore did not commit. */
export function discardNextPreviousCloud(dataDir: string): void {
  rmSync(nextPreviousFolder(dataDir), { recursive: true, force: true });
}

/** Stage the previous Cloud for an ordinary restore; its archive stays. */
export async function stagePreviousCloud(dataDir: string, appVersion: string): Promise<{ id: string; summary: WorkspaceBackupSummary; bytes: number }> {
  const previous = readPrevious(previousFolder(dataDir));
  if (!previous || isEmptyWorkspace(previous.contents)) throw fail("There is no previous Cloud to restore.", 404);
  const archive = join(previousFolder(dataDir), "workspace.ombbackup");
  const staged = await stageWorkspaceBackup(dataDir, archive, { password: previous.password, currentAppVersion: appVersion });
  return { ...staged, bytes: lstatSync(archive).size };
}

/** The archive size of the previous Cloud (0 without one), for space checks. */
export function previousCloudArchiveBytes(dataDir: string): number {
  try { return lstatSync(join(previousFolder(dataDir), "workspace.ombbackup")).size; } catch { return 0; }
}

function readMoveRestores(dataDir: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(moveRestoresPath(dataDir), "utf8"));
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && UUID.test(id)) : [];
  } catch { return []; }
}
function writeMoveRestores(dataDir: string, ids: string[]): void {
  backupsRoot(dataDir);
  if (ids.length) writeFileAtomic(moveRestoresPath(dataDir), JSON.stringify([...new Set(ids)]), { mode: 0o600 });
  else rmSync(moveRestoresPath(dataDir), { force: true });
}
/** Remember a restore made by a move or a swap back, before it commits, so
 * its safety copy and staged files are tidied once it is installed. */
export function noteMoveRestore(dataDir: string, restoreId: string): void {
  writeMoveRestores(dataDir, [...readMoveRestores(dataDir), restoreId]);
}
export function forgetMoveRestore(dataDir: string, restoreId: string): void {
  writeMoveRestores(dataDir, readMoveRestores(dataDir).filter((id) => id !== restoreId));
}

/** Delete a staged job, and its safety copy, by id: guarded paths only. */
export function removeMoveFiles(dataDir: string, id: string): void {
  if (!UUID.test(id)) return;
  for (const name of [id, `safety-${id}`]) {
    const path = join(dataDir, ".backups", name);
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(path, { recursive: true, force: true });
    } catch { /* already gone */ }
  }
}

function pendingRestoreId(dataDir: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, ".backups", "pending-restore.json"), "utf8"));
    return record(value) && typeof value.id === "string" ? value.id : null;
  } catch { return null; }
}

/** At a Cloud home's startup, after any pending restore was applied:
 * - a next previous Cloud becomes the previous Cloud once its restore is
 *   installed, and is dropped otherwise;
 * - moves' and swaps' restores, once settled, keep no safety copy or staged
 *   files (the previous Cloud is the one undo point);
 * - an upload nobody has touched for a day is deleted.
 * Never touches a restore still waiting to be applied. */
export function tidyCloudMoveStorage(dataDir: string, restored: { id?: string; restored?: boolean; rolledBack?: boolean; safetyCopyPath?: string }, now = Date.now()): void {
  if (!existsSync(join(dataDir, ".backups"))) return;
  const pending = pendingRestoreId(dataDir);
  const next = readPrevious(nextPreviousFolder(dataDir));
  if (next && next.forRestore !== pending) {
    if (restored.restored && restored.id === next.forRestore) {
      rmSync(previousFolder(dataDir), { recursive: true, force: true });
      renameSync(nextPreviousFolder(dataDir), previousFolder(dataDir));
    } else discardNextPreviousCloud(dataDir);
  } else if (!next && existsSync(nextPreviousFolder(dataDir)) && !pending) discardNextPreviousCloud(dataDir);
  const settled = readMoveRestores(dataDir).filter((id) => id !== pending);
  for (const id of settled) removeMoveFiles(dataDir, id);
  writeMoveRestores(dataDir, readMoveRestores(dataDir).filter((id) => id === pending));
  if (restored.id && settled.includes(restored.id)) {
    // The receipt must not point at a safety copy that is gone.
    delete restored.safetyCopyPath;
    try {
      const receipt = join(dataDir, ".backups", "last-restore.json");
      const value: unknown = JSON.parse(readFileSync(receipt, "utf8"));
      if (record(value) && value.id === restored.id && "safetyCopyPath" in value) {
        delete value.safetyCopyPath;
        writeFileAtomic(receipt, JSON.stringify(value), { mode: 0o600 });
      }
    } catch { /* no receipt */ }
  }
  const upload = readUploadMeta(dataDir);
  if ((upload && upload.updatedAt + UPLOAD_STALE_MS <= now) || (!upload && existsSync(uploadPartPath(dataDir)))) discardUpload(dataDir);
}

/** Bytes under `.backups`: what backups, safety copies and moves hold on the volume. */
export function backupsBytes(dataDir: string): number {
  let bytes = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const stat = lstatSync(join(directory, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(join(directory, name));
      else if (stat.isFile()) bytes += stat.size;
    }
  };
  try { walk(join(dataDir, ".backups")); } catch { /* none yet */ }
  return bytes;
}
