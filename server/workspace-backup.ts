// An encrypted filesystem snapshot, not an additive import. The caller must
// quiesce writers before create/commit. Restore runs before config/store load.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import {
  chmodSync, closeSync, constants, cpSync, createReadStream, createWriteStream, existsSync,
  fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { isAbsolute, join, parse, posix, relative, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { backup, DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { fromMarkdown } from "mdast-util-from-markdown";
import { writeFileAtomic } from "./atomic.ts";
import { escapeAttribute, splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import { WORKSPACE_BACKUP_CLIENT_KEYS } from "../shared/workspace-backup-client.ts";
import { excludedWorkspaceAuthPath, portableWorkspaceConfig, restoredWorkspaceConfig } from "./workspace-backup-policy.ts";
import type { WorkspaceBackupClientState, WorkspaceBackupPrivateMetadata, WorkspaceBackupSummary } from "../shared/workspace-backup.ts";

export type { WorkspaceBackupSummary, WorkspaceBackupPrivateMetadata } from "../shared/workspace-backup.ts";
export const MAX_WORKSPACE_BACKUP_BYTES = 10 * 1024 ** 3;
export const MAX_WORKSPACE_BACKUP_FILES = 100_000;
export const MAX_WORKSPACE_BACKUP_UPLOAD_BYTES = MAX_WORKSPACE_BACKUP_BYTES + 256 * 1024 ** 2;
const MAX_METADATA_BYTES = 16 * 1024 ** 2;
const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const HEADER_BYTES = MAGIC.length + 16 + 12;
const TAG_BYTES = 16;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXCLUDED = new Set([
  ".backups", "tools", "cache", ".cache", "tmp", ".tmp", "dist-native", "tunnel-runtime",
  ".openmausbot-server-child", "environment-id", "sessions.json", "tunnel-account.json",
  "openmausbot-server.lease", "box-create-requests.lock", "messages.db-wal", "messages.db-shm",
]);
const EXCLUSION_NOTES = [
  "Device pairing, server identity, live leases and runtime files (existing destination identities are preserved).",
  "Saved credentials, provider and MCP connections, managed provider login homes and browser login profiles are not transferred. Destination connections are preserved; reconnect on a new device.",
  "Downloaded tools and caches; these can be installed again.",
  "External project folders, CLI login homes, browser session homes, OS keychains, companion devices and other servers.",
  "VM/container disk layers and remote cloud data; durable files inside this workspace are included.",
];
const RESTORE_WARNING = "Restoring pauses routines, webhooks and calendar calls, and does not resume pending delegations, queued chat messages or queued runs. Definitions and historical receipts are retained; review before enabling them again.";

type Entry = { path: string; type: "file" | "directory"; size: number; mode: number; sha256?: string };
interface Manifest extends WorkspaceBackupPrivateMetadata {
  sourceDataDir: string;
  entries: Entry[];
}
interface RestoreJournal {
  id: string;
  phase: "applying" | "committed" | "rolled-back";
  existing: string[];
  incoming: string[];
}
export interface CreateWorkspaceBackupOptions {
  password: string;
  clientState?: WorkspaceBackupClientState;
  appVersion?: string;
}
export interface WorkspaceRestoreResult {
  restored: boolean;
  rolledBack?: boolean;
  id?: string;
  safetyCopyPath?: string;
  summary?: WorkspaceBackupSummary;
  clientState?: WorkspaceBackupClientState;
}
export type LastWorkspaceRestore = WorkspaceRestoreResult & { restored: true; id: string };

function excluded(name: string): boolean {
  return EXCLUDED.has(name) || excludedWorkspaceAuthPath(name) || name.startsWith("openmausbot-server.lease.") || name.startsWith("box-create-requests.lock.") || /^perm-[A-Za-z0-9_-]+\.sock$/.test(name);
}
function forbiddenArchivePath(path: string): boolean {
  const folded = path.toLowerCase();
  return excluded(folded.split("/")[0]) || excludedWorkspaceAuthPath(folded) ||
    (path !== folded && ["config.json", "webhooks.json"].includes(folded));
}
function preserved(name: string): boolean {
  // Existing WAL/SHM belong to the old database and must move into safety,
  // never accompany a different restored main database.
  const folded = name.toLowerCase();
  return excluded(folded) && folded !== "messages.db-wal" && folded !== "messages.db-shm";
}
function folder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The backup directory must be a real directory, not a symbolic link.");
  chmodSync(path, 0o700);
}
function backupRoot(dataDir: string): string {
  const root = resolve(dataDir);
  if (root === parse(root).root) throw new Error("A filesystem root cannot be a workspace backup target.");
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The workspace data directory must not be a symbolic link.");
  const path = join(root, ".backups");
  folder(path);
  return path;
}
function jobPath(dataDir: string, id: string): string {
  if (!ID.test(id)) throw new Error("Invalid workspace backup identifier.");
  const path = join(backupRoot(dataDir), id);
  if (entryExists(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe workspace backup job directory.");
  }
  return path;
}
function newJob(dataDir: string): { id: string; directory: string } {
  const id = randomUUID();
  const directory = jobPath(dataDir, id);
  mkdirSync(directory, { mode: 0o700 });
  return { id, directory };
}
function validRelative(path: string): boolean {
  return !!path && path.length <= 4096 && !isAbsolute(path) && !/[\\\0:]/.test(path) &&
    path.split("/").every((part) => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function entryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function privateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new Error("Workspace backup metadata is too large or is not a regular file.");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
function writeJson(path: string, value: unknown): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error("Workspace backup metadata exceeds the size limit.");
  writeFileAtomic(path, text, { mode: 0o600 });
}
function privateMetadata(manifest: Manifest): WorkspaceBackupPrivateMetadata {
  return { summary: manifest.summary, clientState: manifest.clientState };
}
function assertLocalAuthOutsideSnapshot(dataDir: string): void {
  const configPath = join(dataDir, "config.json");
  const config = existsSync(configPath) ? privateJson(configPath) : {};
  const instances = record(config) && record(config.instances) ? config.instances : {};
  // These are the concrete auth/home overrides read by current CLI drivers,
  // not a recursive guess at which arbitrary user settings contain secrets.
  const fields = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "KIMI_CODE_HOME", "HERMES_HOME", "FACTORY_HOME_OVERRIDE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "LOCALAPPDATA"];
  const check = (value: unknown, field: string, home: string) => {
    if (typeof value !== "string" || !value.trim()) return;
    const text = value.trim();
    const expanded = text.startsWith("~/") || text.startsWith("~\\") ? join(home, text.slice(2)) : text;
    const resolved = resolve(expanded);
    const exists = entryExists(resolved);
    const path = relative(exists ? realpathSync(dataDir) : resolve(dataDir), exists ? realpathSync(resolved) : resolved).replaceAll("\\", "/");
    if (path === ".." || path.startsWith("../") || isAbsolute(path)) return;
    if (path && (excluded(path.split("/")[0]) || excludedWorkspaceAuthPath(path))) return;
    throw new Error(`Provider authentication storage (${field}) is inside backed-up workspace files. Move that login storage into the excluded providers folder or outside this workspace before backing up or restoring.`);
  };
  const environments = [process.env, ...Object.values(instances).filter(record).map((instance) => ({ ...process.env, ...(record(instance.environment) ? instance.environment : {}) }))];
  for (const environment of environments) {
    const home = String(environment.HOME || environment.USERPROFILE || homedir());
    for (const field of fields) check(environment[field], field, home);
  }
  for (const instance of Object.values(instances)) {
    if (!record(instance) || instance.driver !== "claudeAgent" || !record(instance.config)) continue;
    const environment = { ...process.env, ...(record(instance.environment) ? instance.environment : {}) };
    check(instance.config.configDir, "config.configDir", String(environment.HOME || environment.USERPROFILE || homedir()));
  }
}
function passwordKey(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error("Use a backup password of at least 12 characters (at most 1024 bytes).");
  }
  return new Promise((resolveKey, reject) => {
    scrypt(password, salt, 32, { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 }, (error, key) => {
      if (error) reject(error); else resolveKey(key);
    });
  });
}

// Open without following links and copy synchronously so this server cannot
// interleave a mutation. External writers are detected where stat permits.
function copyRegular(source: string, destination: string): { size: number; mode: number; sha256: string } {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const before = fstatSync(input);
    if (!before.isFile() || before.size > MAX_WORKSPACE_BACKUP_BYTES) throw new Error("A workspace file is not regular or exceeds the 10 GB backup limit.");
    const mode = before.mode & 0o100 ? 0o700 : 0o600;
    output = openSync(destination, "wx", mode);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      const count = readSync(input, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > before.size) throw new Error("A workspace file changed during backup. Stop its writer and retry.");
      hash.update(chunk.subarray(0, count));
      let offset = 0;
      while (offset < count) offset += writeSync(output, chunk, offset, count - offset);
    }
    const after = fstatSync(input);
    const current = lstatSync(source);
    if (size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) {
      throw new Error("A workspace file changed during backup. Stop its writer and retry.");
    }
    fsyncSync(output);
    return { size, mode, sha256: hash.digest("hex") };
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}
function hashFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("The workspace archive contains an unsafe file.");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) return hash.digest("hex");
      hash.update(chunk.subarray(0, count));
    }
  } finally { closeSync(fd); }
}
function countJsonArray(path: string): number {
  if (!existsSync(path)) return 0;
  const value = privateJson(path);
  if (!Array.isArray(value)) throw new Error("A workspace roster is not a valid JSON array.");
  const ids = new Set<string>();
  for (const item of value) {
    if (!record(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || ids.has(item.id)) throw new Error("A workspace roster contains an invalid or duplicate identifier.");
    ids.add(item.id);
    if (item.threadId !== undefined && (typeof item.threadId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.threadId))) throw new Error("A workspace roster contains an invalid thread identifier.");
    if (item.tasks !== undefined && (!Array.isArray(item.tasks) || !item.tasks.every((task) => record(task) && typeof task.threadId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(task.threadId)))) throw new Error("A workspace roster contains invalid task records.");
  }
  return value.length;
}
function databaseCounts(path: string): { threads: number; messages: number } {
  if (!existsSync(path)) return { threads: 0, messages: 0 };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw new Error("The message database failed its integrity check.");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages', 'thread_state')").all();
    if (tables.length !== 2) throw new Error("The backup does not contain a supported message database.");
    const counts = db.prepare("SELECT COUNT(*) AS messages, COUNT(DISTINCT thread_id) AS threads FROM messages").get()!;
    return { threads: Number(counts.threads), messages: Number(counts.messages) };
  } finally { db.close(); }
}

export async function createWorkspaceBackup(dataDir: string, options: CreateWorkspaceBackupOptions) {
  if (Object.hasOwn(options, "credentials")) throw new Error("Workspace backups do not transfer credentials.");
  assertLocalAuthOutsideSnapshot(dataDir);
  const salt = randomBytes(16);
  const key = await passwordKey(options.password, salt);
  const job = newJob(dataDir);
  const snapshot = join(job.directory, "snapshot");
  folder(join(snapshot, "data"));
  const entries: Entry[] = [];
  const warnings = ["Stop external editors and managed desktops before exporting; files written outside this server cannot be frozen by the backup gate.", "Conversation text and user files are not redacted and may contain secrets you pasted. Keep the encrypted backup private.", RESTORE_WARNING];
  let bytes = 0;
  let skippedLinks = 0;
  try {
    const root = realpathSync(dataDir);
    const sourceDb = join(root, "messages.db");
    // The caller closes its message handle after flushing, while maintenance
    // remains held. The native snapshot includes any committed WAL records.
    if (existsSync(sourceDb)) {
      if (lstatSync(sourceDb).isSymbolicLink()) throw new Error("The message database must not be a symbolic link.");
      const db = new DatabaseSync(sourceDb, { readOnly: true });
      // Node 26's native backup completion can wait for unrelated event-loop
      // activity after an async scrypt. A scoped pulse prevents an idle server
      // from waiting indefinitely; it owns no data and always stops here.
      const completionPulse = setInterval(() => {}, 25);
      try { await backup(db, join(snapshot, "messages-snapshot.db")); }
      finally { clearInterval(completionPulse); db.close(); }
      const snapshotDb = new DatabaseSync(join(snapshot, "messages-snapshot.db"));
      try { snapshotDb.exec("PRAGMA journal_mode = DELETE"); } finally { snapshotDb.close(); }
    }
    const walk = (directory: string, prefix = "") => {
      for (const name of readdirSync(directory).sort()) {
        if (!prefix && excluded(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (excludedWorkspaceAuthPath(path)) continue;
        // Do not silently skip noncanonical source spellings: reject them so
        // a case-sensitive host cannot export auth paths active on Windows/Mac.
        if (forbiddenArchivePath(path)) throw new Error("A workspace filename conflicts with a protected authentication or runtime path.");
        if (!validRelative(path)) throw new Error("A workspace filename cannot be safely restored on supported platforms.");
        const source = join(directory, name);
        const stat = lstatSync(source);
        if (stat.isSymbolicLink()) {
          let target: string;
          try { target = realpathSync(source); } catch { throw new Error(`Cannot back up dangling symbolic link: ${path}`); }
          const rel = relative(root, target);
          if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
            throw new Error(`Cannot back up symbolic link outside the workspace: ${path}`);
          }
          // Only the app's disposable native-discovery links may be omitted.
          // An arbitrary user link represents user data, even inside the root.
          if (!/^workspaces\/[^/]+\/\.(?:claude|agents|grok)\/skills\/[^/]+$/.test(path) ||
            !rel.replaceAll("\\", "/").startsWith(`workspaces/${path.split("/")[1]}/skills/`)) {
            throw new Error(`Cannot back up user-created symbolic link; replace it with regular files first: ${path}`);
          }
          skippedLinks++;
          continue;
        }
        if (entries.length >= MAX_WORKSPACE_BACKUP_FILES) throw new Error("The workspace exceeds the 100,000-entry backup limit.");
        const destination = join(snapshot, "data", path);
        if (stat.isDirectory()) {
          folder(destination);
          entries.push({ path, type: "directory", size: 0, mode: 0o700 });
          walk(source, path);
        } else if (stat.isFile()) {
          let copied: { size: number; mode: number; sha256: string };
          if (path === "config.json" || path === "webhooks.json") {
            const value = privateJson(source);
            if (path === "config.json") writeJson(destination, portableWorkspaceConfig(value));
            else {
              if (!record(value)) throw new Error("Invalid webhook definitions in workspace backup.");
              if (Array.isArray(value.webhooks)) for (const webhook of value.webhooks) if (record(webhook)) delete webhook.secretHash;
              writeJson(destination, value);
            }
            copied = { size: lstatSync(destination).size, mode: 0o600, sha256: hashFile(destination) };
          } else copied = copyRegular(path === "messages.db" ? join(snapshot, "messages-snapshot.db") : source, destination);
          bytes += copied.size;
          if (bytes > MAX_WORKSPACE_BACKUP_BYTES) throw new Error("The workspace exceeds the 10 GB backup limit.");
          entries.push({ path, type: "file", ...copied });
        } else throw new Error(`Cannot back up special or live runtime file: ${path}`);
      }
    };
    walk(root);
    if (skippedLinks) warnings.push(`${skippedLinks} managed skill discovery link(s) were omitted and are recreated by the app.`);
    const summary: WorkspaceBackupSummary = {
      format: "openmaus.workspace-backup", version: 1, id: job.id, createdAt: new Date().toISOString(),
      appVersion: options.appVersion ?? "unknown", files: entries.filter((entry) => entry.type === "file").length,
      directories: entries.filter((entry) => entry.type === "directory").length, bytes,
      bots: countJsonArray(join(snapshot, "data", "bots.json")), groups: countJsonArray(join(snapshot, "data", "groups.json")),
      ...databaseCounts(join(snapshot, "data", "messages.db")),
      exclusions: EXCLUSION_NOTES, warnings,
    };
    const manifest: Manifest = {
      summary, sourceDataDir: resolve(dataDir), clientState: options.clientState ?? {}, entries,
    };
    writeJson(join(snapshot, "manifest.json"), manifest);
    // Validate our own output too: JSON serialization must never silently
    // discard metadata or produce a backup the importer cannot read.
    validateManifest(privateJson(join(snapshot, "manifest.json")));
    const path = join(job.directory, "workspace.ombbackup");
    const iv = randomBytes(12);
    const header = Buffer.concat([MAGIC, salt, iv]);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(header);
    writeFileSync(path, header, { mode: 0o600, flag: "wx" });
    await pipeline(tar.c({ cwd: snapshot, portable: true, strict: true }, ["manifest.json", "data"]), cipher, createWriteStream(path, { flags: "a", mode: 0o600 }));
    const fd = openSync(path, "a");
    try { writeSync(fd, cipher.getAuthTag()); fsyncSync(fd); } finally { closeSync(fd); }
    rmSync(snapshot, { recursive: true, force: true });
    return { id: job.id, path, summary };
  } catch (error) {
    rmSync(job.directory, { recursive: true, force: true });
    throw error;
  } finally { key.fill(0); }
}

function validateManifest(value: unknown): Manifest {
  if (!record(value) || !record(value.summary) || value.summary.format !== "openmaus.workspace-backup" || value.summary.version !== 1 ||
    typeof value.summary.id !== "string" || !ID.test(value.summary.id) || typeof value.summary.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.summary.createdAt)) || typeof value.summary.appVersion !== "string" ||
    typeof value.sourceDataDir !== "string" || !(posix.isAbsolute(value.sourceDataDir) || win32.isAbsolute(value.sourceDataDir)) ||
    value.sourceDataDir.length > 4096 || value.sourceDataDir.includes("\0") ||
    value.sourceDataDir === posix.parse(value.sourceDataDir).root || value.sourceDataDir === win32.parse(value.sourceDataDir).root ||
    value.sourceDataDir.replaceAll("\\", "/").split("/").some((part) => part === "." || part === "..") ||
    Object.keys(value).some((key) => !["summary", "sourceDataDir", "clientState", "entries"].includes(key)) ||
    Object.keys(value.summary).some((key) => !["format", "version", "id", "createdAt", "appVersion", "files", "directories", "bytes", "bots", "groups", "threads", "messages", "exclusions", "warnings"].includes(key)) || !record(value.clientState) ||
    !Object.values(value.clientState).every((item) => typeof item === "string") || !Array.isArray(value.entries) ||
    value.entries.length > MAX_WORKSPACE_BACKUP_FILES) throw new Error("Invalid or unsupported workspace backup metadata.");
  if (Object.keys(value.clientState).some((key) => !WORKSPACE_BACKUP_CLIENT_KEYS.includes(key as typeof WORKSPACE_BACKUP_CLIENT_KEYS[number])) ||
    Buffer.byteLength(JSON.stringify(value.clientState)) > 2 * 1024 ** 2) throw new Error("Invalid or oversized workspace client preferences.");
  for (const key of ["files", "directories", "bytes", "bots", "groups", "threads", "messages"] as const) {
    if (!Number.isSafeInteger(value.summary[key]) || (value.summary[key] as number) < 0) throw new Error("Invalid workspace backup summary.");
  }
  for (const key of ["exclusions", "warnings"] as const) {
    if (!Array.isArray(value.summary[key]) || !value.summary[key].every((item) => typeof item === "string")) throw new Error("Invalid workspace backup summary.");
  }
  const names = new Map<string, string>();
  let bytes = 0;
  let files = 0;
  for (const raw of value.entries) {
    if (!record(raw) || typeof raw.path !== "string" || !validRelative(raw.path) || forbiddenArchivePath(raw.path) ||
      Object.keys(raw).some((key) => !["path", "type", "size", "mode", "sha256"].includes(key)) ||
      !["file", "directory"].includes(String(raw.type)) || !Number.isSafeInteger(raw.size) || (raw.size as number) < 0 ||
      ![0o600, 0o700].includes(raw.mode as number) || names.has(raw.path.toLowerCase())) throw new Error("Unsafe or duplicate workspace backup entry.");
    names.set(raw.path.toLowerCase(), String(raw.type));
    if (raw.type === "file") {
      if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) throw new Error("A backup file has no valid checksum.");
      bytes += raw.size as number;
      files++;
    } else if (raw.size !== 0) throw new Error("A backup directory has an invalid size.");
  }
  if (bytes > MAX_WORKSPACE_BACKUP_BYTES || bytes !== value.summary.bytes || files !== value.summary.files ||
    names.size - files !== value.summary.directories) {
    throw new Error("Workspace backup contents do not match their summary or exceed the limit.");
  }
  for (const path of names.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (names.get(parts.slice(0, i).join("/")) !== "directory") throw new Error("A backup entry has an unsafe parent.");
  }
  return value as unknown as Manifest;
}

async function decryptArchive(inputPath: string, plaintext: string, password: string): Promise<void> {
  const fd = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key: Buffer | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < HEADER_BYTES + TAG_BYTES || stat.size > MAX_WORKSPACE_BACKUP_UPLOAD_BYTES) throw new Error("Invalid or oversized workspace backup file.");
    const header = Buffer.alloc(HEADER_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || !header.subarray(0, MAGIC.length).equals(MAGIC) ||
      readSync(fd, tag, 0, tag.length, stat.size - TAG_BYTES) !== tag.length) throw new Error("This is not a supported encrypted workspace backup.");
    key = await passwordKey(password, header.subarray(MAGIC.length, MAGIC.length + 16));
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length + 16));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    try {
      await pipeline(createReadStream(inputPath, { fd, autoClose: false, start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 }), decipher,
        createWriteStream(plaintext, { flags: "wx", mode: 0o600 }));
    } catch {
      throw new Error("The backup password is incorrect, or the backup file is damaged. Nothing was restored.");
    }
  } finally { key?.fill(0); closeSync(fd); }
}

async function inspectTar(path: string): Promise<Map<string, { type: string; size: number }>> {
  const fd = openSync(path, "r");
  const signature = Buffer.alloc(2);
  try { readSync(fd, signature, 0, 2, 0); } finally { closeSync(fd); }
  // This format is uncompressed tar. Reject auto-detected gzip before tar's
  // parser can inflate an authenticated but malicious decompression bomb.
  if (signature[0] === 0x1f && signature[1] === 0x8b) throw new Error("Compressed payloads are not supported in this workspace backup version.");
  const entries = new Map<string, { type: string; size: number }>();
  const names = new Set<string>();
  let bytes = 0;
  let problem = "";
  await tar.t({ file: path, strict: true, onReadEntry(entry) {
    const name = entry.type === "Directory" ? entry.path.replace(/\/$/, "") : entry.path;
    const expectedRoot = name === "manifest.json" || name === "data" || name.startsWith("data/");
    // ReadEntry normalizes backslashes on Windows; inspect the raw header too
    // so the same hostile archive is rejected before extraction on every OS.
    if (entry.header.path?.includes("\\") || !validRelative(name) || !expectedRoot || !["File", "Directory"].includes(entry.type) ||
      names.has(name.toLowerCase()) || entries.size >= MAX_WORKSPACE_BACKUP_FILES + 2 ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || (entry.type === "Directory" && entry.size !== 0)) {
      problem ||= "The archive contains unsafe, duplicate or unsupported entries.";
      return;
    }
    if (name === "manifest.json" && (entry.type !== "File" || entry.size > MAX_METADATA_BYTES)) problem ||= "Invalid backup metadata file.";
    bytes += entry.size;
    if (bytes > MAX_WORKSPACE_BACKUP_BYTES + MAX_METADATA_BYTES) problem ||= "The archive exceeds the extracted size limit.";
    names.add(name.toLowerCase());
    entries.set(name, { type: entry.type, size: entry.size });
  } });
  if (problem) throw new Error(problem);
  if (entries.get("data")?.type !== "Directory" || entries.get("manifest.json")?.type !== "File") throw new Error("The archive has no workspace data or manifest.");
  for (const name of entries.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) if (entries.get(parts.slice(0, i).join("/"))?.type !== "Directory") throw new Error("An archive entry has an unsafe parent.");
  }
  return entries;
}
function validateStaged(directory: string, expected?: Map<string, { type: string; size: number }>): Manifest {
  const manifest = validateManifest(privateJson(join(directory, "manifest.json")));
  if (expected && expected.size !== manifest.entries.length + 2) throw new Error("Archive entries do not match the backup manifest.");
  const declared = new Set(manifest.entries.map((entry) => entry.path));
  const inspect = (root: string, prefix = "") => {
    for (const name of readdirSync(root)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!declared.has(path)) throw new Error("Staged workspace contains files absent from its manifest.");
      const stat = lstatSync(join(root, name));
      if (stat.isSymbolicLink()) throw new Error("Staged workspace contains a symbolic link.");
      if (stat.isDirectory()) inspect(join(root, name), path);
    }
  };
  inspect(join(directory, "data"));
  for (const entry of manifest.entries) {
    const path = join(directory, "data", entry.path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (entry.type === "file" ? !stat.isFile() || stat.size !== entry.size : !stat.isDirectory())) {
      throw new Error("Staged workspace files do not match the backup manifest.");
    }
    if (expected) {
      const archive = expected.get(`data/${entry.path}`);
      if (!archive || archive.type !== (entry.type === "file" ? "File" : "Directory") || archive.size !== entry.size) throw new Error("Archive contents do not match the backup manifest.");
    }
    if (entry.type === "file" && hashFile(path) !== entry.sha256) throw new Error("A workspace backup file failed its checksum.");
    chmodSync(path, entry.mode);
  }
  const data = join(directory, "data");
  if (countJsonArray(join(data, "bots.json")) !== manifest.summary.bots || countJsonArray(join(data, "groups.json")) !== manifest.summary.groups) throw new Error("The backup roster does not match its summary.");
  if (existsSync(join(data, "config.json"))) {
    const config = privateJson(join(data, "config.json"));
    if (JSON.stringify(config) !== JSON.stringify(portableWorkspaceConfig(config))) throw new Error("Workspace backup contains non-portable connection settings.");
  }
  if (existsSync(join(data, "webhooks.json"))) {
    const value = privateJson(join(data, "webhooks.json"));
    if (!record(value) || Array.isArray(value.webhooks) && value.webhooks.some((webhook) => record(webhook) && Object.hasOwn(webhook, "secretHash"))) throw new Error("Workspace backup contains webhook credentials.");
  }
  const counts = databaseCounts(join(data, "messages.db"));
  if (counts.messages !== manifest.summary.messages || counts.threads !== manifest.summary.threads) throw new Error("The message database does not match the backup summary.");
  return manifest;
}

export async function stageWorkspaceBackup(dataDir: string, archivePath: string, options: { password: string; currentAppVersion?: string }) {
  const job = newJob(dataDir);
  const plaintext = join(job.directory, "archive.tar");
  try {
    // No extraction, parser or metadata processing occurs until GCM final()
    // authenticates the complete encrypted file.
    await decryptArchive(archivePath, plaintext, options.password);
    const expected = await inspectTar(plaintext);
    const staged = join(job.directory, "staged");
    folder(staged);
    await tar.x({ file: plaintext, cwd: staged, strict: true, preservePaths: false, umask: 0o077, noChmod: true });
    const manifest = validateStaged(staged, expected);
    const versions = [manifest.summary.appVersion, options.currentAppVersion ?? ""].map((version) => /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)?.slice(1).map(Number));
    if (versions[0] && versions[1]) {
      for (let i = 0; i < 3; i++) {
        if (versions[0][i] > versions[1][i]) throw new Error("This backup was made by a newer OpenMausBot version. Update the app before restoring it.");
        if (versions[0][i] < versions[1][i]) break;
      }
    }
    rmSync(plaintext);
    writeJson(join(job.directory, "ready.json"), { id: job.id, summary: manifest.summary });
    return { id: job.id, summary: manifest.summary };
  } catch (error) {
    rmSync(job.directory, { recursive: true, force: true });
    throw error;
  }
}

export function readStagedWorkspaceBackup(dataDir: string, id: string): WorkspaceBackupPrivateMetadata & { id: string } {
  const directory = jobPath(dataDir, id);
  const ready = privateJson(join(directory, "ready.json"));
  if (!record(ready) || ready.id !== id) throw new Error("This workspace backup is not ready to restore.");
  const manifest = validateManifest(privateJson(join(directory, "staged", "manifest.json")));
  return { id, ...privateMetadata(manifest) };
}

export function commitPendingWorkspaceRestore(dataDir: string, id: string) {
  const root = backupRoot(dataDir);
  if (existsSync(join(root, "pending-restore.json"))) throw new Error("A workspace restore is already waiting for restart.");
  if (existsSync(join(root, `safety-${id}`))) throw new Error("This restore was already attempted. Preview the backup again to create a fresh restore attempt.");
  const metadata = readStagedWorkspaceBackup(dataDir, id);
  const manifest = validateStaged(join(jobPath(dataDir, id), "staged"));
  // Discover adaptation errors before persisting a restart request. A broken
  // legacy transcript or scheduler file must not trap subsequent app boots.
  prepareRestore(dataDir, id, manifest);
  writeJson(join(root, "pending-restore.json"), { id });
  return { id, restartRequired: true as const, summary: metadata.summary };
}

export function readPendingWorkspaceRestoreMetadata(dataDir: string): (WorkspaceBackupPrivateMetadata & { id: string }) | null {
  const root = backupRoot(dataDir);
  const path = join(root, "pending-restore.json");
  if (!existsSync(path)) return null;
  const pending = privateJson(path);
  if (!record(pending) || typeof pending.id !== "string") throw new Error("Invalid pending workspace restore.");
  return readStagedWorkspaceBackup(dataDir, pending.id);
}

function readJournal(path: string): RestoreJournal {
  const raw = privateJson(path);
  if (!record(raw) || typeof raw.id !== "string" || !ID.test(raw.id) || !["applying", "committed", "rolled-back"].includes(String(raw.phase))) throw new Error("Invalid restore recovery journal. Original data was preserved; recovery needs attention.");
  for (const key of ["existing", "incoming"] as const) {
    if (!Array.isArray(raw[key]) || !raw[key].every((name) => typeof name === "string" && validRelative(name) && !name.includes("/") && !preserved(name)) || new Set(raw[key]).size !== raw[key].length) throw new Error("Invalid restore recovery paths.");
  }
  return raw as unknown as RestoreJournal;
}
function rollback(dataDir: string, journal: RestoreJournal): void {
  const stage = join(jobPath(dataDir, journal.id), "apply", "data");
  const saved = join(backupRoot(dataDir), `safety-${journal.id}`, "data");
  // Existence on both sides resolves a crash between rename and journal I/O.
  // New data is moved back, never deleted; originals remain recoverable.
  for (const name of journal.incoming) {
    const live = join(dataDir, name);
    const staged = join(stage, name);
    const originalMoved = !journal.existing.includes(name) || entryExists(join(saved, name));
    if (originalMoved && !entryExists(staged) && entryExists(live)) renameSync(live, staged);
  }
  for (const name of journal.existing) {
    const original = join(saved, name);
    if (!entryExists(original)) continue;
    const live = join(dataDir, name);
    if (entryExists(live)) throw new Error("Restore rollback found conflicting files. Both copies are preserved for recovery.");
    renameSync(original, live);
  }
  const root = backupRoot(dataDir);
  const previousReceipt = join(root, `safety-${journal.id}`, "previous-restore.json");
  const last = join(root, "last-restore.json");
  if (existsSync(previousReceipt)) writeJson(last, privateJson(previousReceipt));
  else if (existsSync(last)) {
    const value = privateJson(last);
    if (record(value) && value.id === journal.id) rmSync(last);
  }
}

function rebasePath(value: string, source: string, destination: string): string {
  // Explicit old-root prefix, not a free-form text replacement. Normalize
  // Windows separators without interpreting unrelated external paths.
  const normalized = value.replaceAll("\\", "/");
  const original = source.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalized !== original && !normalized.startsWith(`${original}/`)) return value;
  const suffix = normalized.slice(original.length).replace(/^\//, "");
  if (suffix && !validRelative(suffix)) return value;
  return suffix ? join(destination, suffix) : destination;
}
const PATH_KEYS = new Set(["cwd", "pinnedCwd", "workspace", "configDir", "profileDirectory", "agentDir", "dataDir", "home", "cli", "path", "filePath", "localPath"]);
function rebaseFields(value: unknown, source: string, destination: string): void {
  if (Array.isArray(value)) { for (const item of value) rebaseFields(item, source, destination); }
  else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (PATH_KEYS.has(key) && typeof item === "string") value[key] = rebasePath(item, source, destination);
      else if (typeof item === "object") rebaseFields(item, source, destination);
    }
  }
}
function rebaseMessage(message: unknown, source: string, destination: string): void {
  if (!record(message)) return;
  for (const field of ["attachments", "images", "fileAttachments", "file", "card"]) rebaseFields(message[field], source, destination);
  if (typeof message.text !== "string") return;
  // Only actual top-level attachment markup is rewritten. Quoted prose,
  // code fences, pasted text and arbitrary mentions of the old path stay exact.
  const text = message.text;
  const edits: Array<{ from: number; to: number; text: string }> = [];
  // A tag after a single newline remains inline HTML within a Markdown
  // paragraph, even though the app's attachment parser treats its whole line
  // as a card. Do not descend into quotes/lists/code or arbitrary HTML blocks.
  const candidates = fromMarkdown(text).children.flatMap((node) => node.type === "html" ? [node] :
    node.type === "paragraph" ? node.children.filter((child) => child.type === "html") : []);
  for (const node of candidates) {
    if (node.position?.start.offset === undefined || node.position.end.offset === undefined || node.position.start.column !== 1) continue;
    const lineEnd = text.indexOf("\n", node.position.end.offset);
    if (text.slice(node.position.end.offset, lineEnd < 0 ? text.length : lineEnd).trim()) continue;
    const parsed = splitTranscriptAttachments(node.value, false);
    if (parsed.display.trim() || !parsed.images.length && !parsed.files.length) continue;
    const next = node.value.replace(/(<attached-(?:image|file)[\t ]+path=")([^"\r\n]*)(")/g, (whole, before: string, encoded: string, after: string) => {
      const attachment = [...parsed.images, ...parsed.files].find((item) => escapeAttribute(item.path) === encoded);
      return attachment ? `${before}${escapeAttribute(rebasePath(attachment.path, source, destination))}${after}` : whole;
    });
    if (next !== node.value) edits.push({ from: node.position.start.offset, to: node.position.end.offset, text: next });
  }
  let next = text;
  for (const edit of edits.reverse()) next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
  message.text = next;
}
function prepareRestore(dataDir: string, id: string, manifest: Manifest): string {
  assertLocalAuthOutsideSnapshot(dataDir);
  const job = jobPath(dataDir, id);
  const prepared = join(job, "apply", "data");
  if (existsSync(join(job, "apply"))) rmSync(join(job, "apply"), { recursive: true, force: true });
  folder(prepared);
  // Keep the authenticated original staging tree intact for reinspection and
  // recovery. Only this installation copy has paths/scheduling adapted.
  for (const entry of manifest.entries.filter((entry) => entry.type === "directory")) folder(join(prepared, entry.path));
  for (const entry of manifest.entries) {
    const destination = join(prepared, entry.path);
    if (entry.type === "file") copyRegular(join(job, "staged", "data", entry.path), destination);
  }
  const changeJson = (name: string, change: (value: unknown) => void) => {
    const path = join(prepared, name);
    if (!existsSync(path)) return;
    const value = privateJson(path);
    change(value);
    writeJson(path, value);
  };
  for (const name of ["bots.json", "groups.json", "config.json", "routines.json", "calendar-calls.json"]) {
    changeJson(name, (value) => rebaseFields(value, manifest.sourceDataDir, resolve(dataDir)));
  }
  // Never install source connection settings. Destination keys, endpoints,
  // driver environments and MCP configuration remain paired and unchanged.
  const oldConfig = join(dataDir, "config.json");
  const newConfig = join(prepared, "config.json");
  if (existsSync(oldConfig) || existsSync(newConfig)) {
    writeJson(newConfig, restoredWorkspaceConfig(existsSync(newConfig) ? privateJson(newConfig) : {}, existsSync(oldConfig) ? privateJson(oldConfig) : {}));
  }
  // Browser authentication lives alongside ordinary VM files. Copy only the
  // destination's excluded subtrees into the install copy, never the archive.
  // They then participate in the same top-level swap and crash rollback.
  const browserHomes = ["vm-home"];
  const vmHomes = join(dataDir, "vm-homes");
  if (entryExists(vmHomes)) {
    if (!lstatSync(vmHomes).isDirectory()) throw new Error("Stop managed desktops and repair the VM home directory before restoring.");
    for (const name of readdirSync(vmHomes)) if (validRelative(name)) browserHomes.push(`vm-homes/${name}`);
  }
  for (const home of browserHomes) {
    const homePath = join(dataDir, home);
    if (!entryExists(homePath)) continue;
    if (!lstatSync(homePath).isDirectory()) throw new Error("Stop managed desktops and repair the VM home directory before restoring.");
    const source = join(dataDir, home, ".browser-profiles");
    if (!entryExists(source)) continue;
    folder(join(prepared, home));
    cpSync(source, join(prepared, home, ".browser-profiles"), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
  }
  changeJson("routines.json", (value) => {
    if (!record(value)) throw new Error("Invalid routine definitions in workspace backup.");
    if (Array.isArray(value.routines)) for (const routine of value.routines) if (record(routine)) routine.enabled = false;
    if (Array.isArray(value.runs)) for (const run of value.runs) {
      if (record(run) && ["queued", "running", "waiting"].includes(String(run.status))) {
        run.status = "failed";
        run.error = "This queued or active run was not resumed after workspace restore.";
        run.finishedAt = Date.now();
        if (run.target === "room-goal") run.goalStatus = "failed";
      }
    }
  });
  changeJson("webhooks.json", (value) => {
    if (!record(value)) throw new Error("Invalid webhook definitions in workspace backup.");
    const destination = existsSync(join(dataDir, "webhooks.json")) ? privateJson(join(dataDir, "webhooks.json")) : {};
    const oldHooks = record(destination) && Array.isArray(destination.webhooks) ? destination.webhooks : [];
    if (Array.isArray(value.webhooks)) for (const webhook of value.webhooks) if (record(webhook)) {
      webhook.enabled = false;
      webhook.verificationPending = false;
      const previous = oldHooks.find((old) => record(old) && old.id === webhook.id && old.endpointId === webhook.endpointId);
      // Unknown random hashes cannot authenticate a caller. A migrated hook
      // needs an explicit secret rotation before it can receive anything.
      webhook.secretHash = record(previous) && typeof previous.secretHash === "string" && /^[a-f0-9]{64}$/.test(previous.secretHash) ? previous.secretHash : randomBytes(32).toString("hex");
    }
  });
  changeJson("calendar-calls.json", (value) => {
    if (!record(value)) throw new Error("Invalid calendar definitions in workspace backup.");
    if (Array.isArray(value.calls)) for (const call of value.calls) if (record(call)) call.nextRunAt = null;
  });
  if (existsSync(join(prepared, "delegations.json"))) writeJson(join(prepared, "delegations.json"), {});
  if (existsSync(join(prepared, "browser-cleanups.json"))) writeJson(join(prepared, "browser-cleanups.json"), []);
  for (const entry of manifest.entries) {
    if (/^messages-[^/]+\.json$/.test(entry.path)) changeJson(entry.path, (value) => {
      if (Array.isArray(value)) for (const message of value) rebaseMessage(message, manifest.sourceDataDir, resolve(dataDir));
      else if (record(value) && Array.isArray(value.messages)) for (const message of value.messages) rebaseMessage(message, manifest.sourceDataDir, resolve(dataDir));
    });
  }
  const dbPath = join(prepared, "messages.db");
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("BEGIN");
      if (manifest.sourceDataDir !== resolve(dataDir)) {
        const update = db.prepare("UPDATE messages SET json = ?, text = ? WHERE thread_id = ? AND id = ?");
        for (const row of db.prepare("SELECT thread_id, id, json FROM messages").iterate()) {
          const message: unknown = JSON.parse(String(row.json));
          rebaseMessage(message, manifest.sourceDataDir, resolve(dataDir));
          const json = JSON.stringify(message);
          if (json !== row.json) update.run(json, record(message) && typeof message.text === "string" ? message.text : null, row.thread_id, row.id);
        }
      }
      // Import is not a server restart: the source may still be running.
      // Keep accepted words/receipts for review, but never execute a copy of
      // its pending work (including when restoring to the original home).
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_followups'").get()) {
        const pause = db.prepare("UPDATE chat_followups SET status = 'interrupted', payload = ? WHERE id = ?");
        for (const row of db.prepare("SELECT id, payload FROM chat_followups WHERE status IN ('pending', 'dispatching', 'interrupted')").iterate()) {
          const payload: unknown = JSON.parse(String(row.payload));
          rebaseMessage(payload, manifest.sourceDataDir, resolve(dataDir));
          if (record(payload)) delete payload.prompt;
          pause.run(JSON.stringify(payload), row.id);
        }
      }
      db.exec("COMMIT");
    } finally { db.close(); }
  }
  return prepared;
}

export function readLastWorkspaceRestore(dataDir: string): LastWorkspaceRestore | null {
  const root = backupRoot(dataDir);
  const path = join(root, "last-restore.json");
  if (!existsSync(path)) return null;
  const raw = privateJson(path);
  if (!record(raw) || raw.restored !== true || typeof raw.id !== "string" || !ID.test(raw.id)) throw new Error("Invalid workspace restore receipt.");
  return raw as unknown as LastWorkspaceRestore;
}
function finishRestore(dataDir: string, id: string, consumePending = true): LastWorkspaceRestore {
  const root = backupRoot(dataDir);
  const { summary, clientState } = readStagedWorkspaceBackup(dataDir, id);
  const draftAttachments = clientState["omb-draft-attachments"];
  if (draftAttachments) {
    try {
      const value: unknown = JSON.parse(draftAttachments);
      const manifest = validateManifest(privateJson(join(jobPath(dataDir, id), "staged", "manifest.json")));
      rebaseFields(value, manifest.sourceDataDir, resolve(dataDir));
      clientState["omb-draft-attachments"] = JSON.stringify(value);
    } catch { /* A malformed client draft must not jeopardize durable server data. */ }
  }
  const result: LastWorkspaceRestore = { restored: true, id, safetyCopyPath: join(root, `safety-${id}`), summary, clientState };
  writeJson(join(root, "last-restore.json"), result);
  if (consumePending) rmSync(join(root, "pending-restore.json"), { force: true });
  return result;
}

/** Called after the data-directory lease, before anything reads app state.
 * The DATA_DIR itself and all destination identity/session/lease files stay
 * in place. The previous durable tree is retained under .backups/safety-ID. */
export function applyPendingWorkspaceRestore(dataDir: string): WorkspaceRestoreResult {
  const root = backupRoot(dataDir);
  const journalFile = join(root, "restore-journal.json");
  const pendingFile = join(root, "pending-restore.json");
  if (existsSync(journalFile)) {
    const previous = readJournal(journalFile);
    if (previous.phase === "applying") {
      rollback(dataDir, previous);
      writeJson(journalFile, { ...previous, phase: "rolled-back" });
      rmSync(pendingFile, { force: true });
      return { restored: false, rolledBack: true, id: previous.id, safetyCopyPath: join(root, `safety-${previous.id}`) };
    }
    if (previous.phase === "committed" && existsSync(pendingFile)) {
      const pending = privateJson(pendingFile);
      if (record(pending) && pending.id === previous.id) {
        return finishRestore(dataDir, previous.id);
      }
    }
  }
  const pending = readPendingWorkspaceRestoreMetadata(dataDir);
  if (!pending) return { restored: false };
  const staged = join(jobPath(dataDir, pending.id), "staged");
  const manifest = validateStaged(staged);
  const prepared = prepareRestore(dataDir, pending.id, manifest);
  const safetyCopyPath = join(root, `safety-${pending.id}`);
  if (existsSync(safetyCopyPath)) throw new Error("A safety copy already exists for this restore. Original files have not been changed.");
  folder(join(safetyCopyPath, "data"));
  const journal: RestoreJournal = {
    id: pending.id, phase: "applying",
    existing: readdirSync(dataDir).filter((name) => !preserved(name)).sort(),
    incoming: readdirSync(prepared).sort(),
  };
  // Top-level source and destination names are checked before recording any
  // move; a restored root never traverses an archive-controlled directory.
  for (const name of [...journal.existing, ...journal.incoming]) {
    if (!validRelative(name) || name.includes("/") || preserved(name)) throw new Error("Unsafe workspace restore target.");
  }
  writeJson(join(safetyCopyPath, "manifest.json"), { id: pending.id, createdAt: new Date().toISOString(), originalEntries: journal.existing });
  if (existsSync(join(root, "last-restore.json"))) writeJson(join(safetyCopyPath, "previous-restore.json"), privateJson(join(root, "last-restore.json")));
  writeJson(journalFile, journal);
  try {
    for (const name of journal.existing) renameSync(join(dataDir, name), join(safetyCopyPath, "data", name));
    for (const name of journal.incoming) if (entryExists(join(prepared, name))) renameSync(join(prepared, name), join(dataDir, name));
    finishRestore(dataDir, pending.id, false);
    writeJson(journalFile, { ...journal, phase: "committed" });
  } catch (error) {
    rollback(dataDir, journal);
    writeJson(journalFile, { ...journal, phase: "rolled-back" });
    rmSync(pendingFile, { force: true });
    throw new Error("The workspace restore failed and the previous workspace was recovered.", { cause: error });
  }
  return finishRestore(dataDir, pending.id);
}

/** Delete only an unreferenced upload/export/staging job, never a safety copy
 * or a job needed by a pending restore or its latest recovery receipt. */
export function removeWorkspaceBackupJob(dataDir: string, id: string): void {
  const path = jobPath(dataDir, id);
  const root = backupRoot(dataDir);
  for (const name of ["pending-restore.json", "restore-journal.json", "last-restore.json"]) {
    if (!existsSync(join(root, name))) continue;
    const value = privateJson(join(root, name));
    if (record(value) && value.id === id) throw new Error("This backup is still needed for restore or recovery and cannot be removed.");
  }
  if (existsSync(join(root, `safety-${id}`))) throw new Error("This backup has a recovery copy and cannot be removed.");
  if (!entryExists(path)) return;
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("Unsafe workspace backup cleanup target.");
  rmSync(path, { recursive: true, force: true });
}
