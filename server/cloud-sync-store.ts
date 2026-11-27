// The Cloud side of folder sync's records: which PC folders sync (folders.json), what each synced folder holds with
// hashes cached by size and modified time (index.db), and the trash. Bot output folders are not stored: they are the
// conversation folders under task-workspaces that hold a file.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./atomic.ts";
import { TRASH_DAYS, foldKey, safeFolderName, skipped, validWirePath } from "../electron/cloud-sync-rules.mjs";
import { lentRoot, syncRoot } from "./cloud-sync-paths.ts";

export interface SyncFolder {
  id: string;
  kind: "pc" | "bot";
  cloudPath: string;
  computerId?: string;
  computerName?: string;
  pcPath?: string;
  botId?: string;
  threadId?: string;
  /** A bot folder: when it last changed (the folder and what sits directly in it). */
  newestMs?: number;
  /** A copy of a folder lent to My Cloud: kept in the data folder, out of every bot's box, so only shared_computer
   * reaches it, with lending's own rules (server/lent-copies.ts). */
  lent?: boolean;
  createdAt?: number;
}

export interface SyncFile { path: string; size: number; mtimeMs: number; sha256: string }
export interface TrashEntry { id: string; folderId: string; path: string; size: number; deletedAt: number }

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

type FileRow = { path: string; size: number; mtime: number; sha256: string };
type TrashRow = { id: string; folder: string; path: string; size: number; deleted_at: number; cloud_path: string | null };
const trashEntryOf = (row: TrashRow): TrashEntry => ({ id: row.id, folderId: row.folder, path: row.path, size: row.size, deletedAt: row.deleted_at });

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const pcKey = (path: string) => WINDOWS_PATH.test(path) ? path.replaceAll("\\", "/").toLowerCase() : path;

/** Every name in `dir`, of any kind: a new folder's name must not take one a file or link already has. */
function names(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function directories(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return []; }
}

const gone = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Regular, singly linked files under `root` as wire paths. Skips links, sync's skip list and names that cannot travel.
 * Only a folder that is not there reads as empty: any other error is thrown, so nothing reads as deleted unproven. */
export function* walk(root: string, prefix = ""): Generator<{ path: string; size: number; mtimeMs: number }> {
  let entries;
  try { entries = readdirSync(prefix ? join(root, ...prefix.split("/")) : root, { withFileTypes: true }); } catch (error) {
    if (gone(error)) return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (skipped(entry.name, entry.isDirectory()) || !validWirePath(path)) continue;
    if (entry.isDirectory()) { yield* walk(root, path); continue; }
    if (!entry.isFile()) continue;
    const stat = lstatSync(join(root, ...path.split("/")), { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1) continue;
    yield { path, size: stat.size, mtimeMs: stat.mtimeMs };
  }
}

export function readFolders(dataDir: string): SyncFolder[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, "sync", "folders.json"), "utf8"));
    return Array.isArray(value)
      ? value.filter((folder): folder is SyncFolder => typeof folder?.id === "string" && folder.kind === "pc" && typeof folder.cloudPath === "string")
      : [];
  } catch { return []; }
}

/** For the Cloud prompt: each synced PC folder bots read where it is, and where that is here. A lent folder's copy is not
 * one: bots reach it through shared_computer. */
export function syncedFolders(dataDir: string): Array<{ computerName: string; pcPath: string; cloudPath: string }> {
  return readFolders(dataDir).filter((folder) => folder.lent !== true)
    .map((folder) => ({ computerName: folder.computerName ?? "", pcPath: folder.pcPath ?? "", cloudPath: folder.cloudPath }));
}

export class CloudSyncStore {
  dataDir: string;
  root: string;
  now: () => number;
  db: DatabaseSync;

  constructor(options: { dataDir: string; root?: string; now?: () => number }) {
    this.dataDir = options.dataDir;
    this.root = options.root ?? syncRoot(options.dataDir);
    this.now = options.now ?? Date.now;
    for (const dir of [this.syncDir(), join(this.syncDir(), "uploads"), join(this.syncDir(), "trash"), this.root, this.lentRoot()]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.syncDir(), "index.db"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS files(folder TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(folder, path));
      CREATE TABLE IF NOT EXISTS trash(id TEXT PRIMARY KEY, folder TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, deleted_at INTEGER NOT NULL, cloud_path TEXT);`);
    const columns = (this.db.prepare("PRAGMA table_info(trash)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes("cloud_path")) this.db.exec("ALTER TABLE trash ADD COLUMN cloud_path TEXT");
  }

  syncDir(): string { return join(this.dataDir, "sync"); }
  lentRoot(): string { return lentRoot(this.dataDir); }
  close(): void { this.db.close(); }

  pcFolders(): SyncFolder[] { return readFolders(this.dataDir); }

  botFolders(): SyncFolder[] {
    const base = join(this.dataDir, "task-workspaces");
    const folders: SyncFolder[] = [];
    for (const botId of directories(base)) {
      for (const threadId of directories(join(base, botId))) {
        const cloudPath = join(base, botId, threadId);
        if (!ID.test(botId) || !ID.test(threadId)) continue;
        let holdsFile = true;
        try { holdsFile = !walk(cloudPath).next().done; } catch {}
        if (!holdsFile) continue;
        // When it last changed, cheaply: the folder and what sits directly in it (the desktop takes only recent work).
        let newestMs = 0;
        try {
          newestMs = lstatSync(cloudPath).mtimeMs;
          for (const name of readdirSync(cloudPath)) newestMs = Math.max(newestMs, lstatSync(join(cloudPath, name), { throwIfNoEntry: false })?.mtimeMs ?? 0);
        } catch {}
        folders.push({ id: `bot-${botId}-${threadId}`, kind: "bot", botId, threadId, cloudPath, newestMs });
      }
    }
    return folders;
  }

  folders(): SyncFolder[] { return [...this.pcFolders(), ...this.botFolders()]; }
  folder(id: string): SyncFolder | undefined { return this.folders().find((folder) => folder.id === id); }

  register(input: { computerId: string; computerName: string; pcPath: string; name: string; lent?: boolean }): SyncFolder {
    let folders = this.pcFolders();
    const existing = folders.find((folder) => folder.computerId === input.computerId && pcKey(folder.pcPath ?? "") === pcKey(input.pcPath));
    if (existing && lstatSync(existing.cloudPath, { throwIfNoEntry: false })?.isDirectory()) return existing;
    if (existing) {
      // Its copy is gone (or a link replaced it): a new id, so no record of what the old copy held applies to an empty one.
      folders = folders.filter((folder) => folder.id !== existing.id);
      this.db.prepare("DELETE FROM files WHERE folder = ?").run(existing.id);
    }
    // A copy kept already (shared from the Files page before it was lent) stayed where it is, above: nothing is sent again.
    const lent = input.lent === true;
    const root = lent ? this.lentRoot() : this.root;
    const sibling = [existing, ...folders].find((folder) => folder?.computerId === input.computerId && folder.cloudPath.startsWith(root + sep));
    const computerDir = sibling
      ? relative(root, sibling.cloudPath).split(sep)[0]!
      : safeFolderName(input.computerName, new Set(names(root).map(foldKey)));
    const name = safeFolderName(input.name, new Set(names(join(root, computerDir)).map(foldKey)));
    const folder: SyncFolder = {
      id: randomUUID(), kind: "pc", computerId: input.computerId, computerName: input.computerName, pcPath: input.pcPath,
      cloudPath: join(root, computerDir, name), createdAt: this.now(), ...(lent ? { lent: true } : {}),
    };
    mkdirSync(folder.cloudPath, { recursive: true, mode: 0o700 });
    this.saveFolders([...folders, folder]);
    return folder;
  }

  unregister(id: string): SyncFolder | null {
    const folders = this.pcFolders();
    const folder = folders.find((entry) => entry.id === id) ?? null;
    if (!folder) return null;
    this.saveFolders(folders.filter((entry) => entry.id !== id));
    this.db.prepare("DELETE FROM files WHERE folder = ?").run(id);
    return folder;
  }

  saveFolders(folders: SyncFolder[]): void {
    writeFileAtomic(join(this.syncDir(), "folders.json"), JSON.stringify(folders), { mode: 0o600 });
  }

  /** What a folder holds now. Rescans, and hashes only files whose size or modified time changed since last time. */
  async list(folder: SyncFolder): Promise<SyncFile[]> {
    const cached = new Map<string, SyncFile>();
    for (const row of this.db.prepare("SELECT path, size, mtime, sha256 FROM files WHERE folder = ?").all(folder.id) as FileRow[]) {
      cached.set(row.path, { path: row.path, size: row.size, mtimeMs: row.mtime, sha256: row.sha256 });
    }
    const files: SyncFile[] = [];
    for (const entry of walk(folder.cloudPath)) {
      const hit = cached.get(entry.path);
      cached.delete(entry.path);
      if (hit && hit.size === entry.size && hit.mtimeMs === entry.mtimeMs) { files.push(hit); continue; }
      let sha256: string;
      try { sha256 = await sha256File(join(folder.cloudPath, ...entry.path.split("/"))); } catch (error) {
        if (gone(error)) continue;
        throw error;
      }
      const file = { ...entry, sha256 };
      this.remember(folder, file);
      files.push(file);
    }
    for (const path of cached.keys()) this.forget(folder, path);
    return files;
  }

  /** The file at `path` now, hashed through the cache; null when there is none. */
  async current(folder: SyncFolder, path: string): Promise<SyncFile | null> {
    const file = join(folder.cloudPath, ...path.split("/"));
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1) return null;
    const row = this.db.prepare("SELECT path, size, mtime, sha256 FROM files WHERE folder = ? AND path = ?").get(folder.id, path) as FileRow | undefined;
    if (row && row.size === stat.size && row.mtime === stat.mtimeMs) return { path, size: stat.size, mtimeMs: stat.mtimeMs, sha256: row.sha256 };
    const current = { path, size: stat.size, mtimeMs: stat.mtimeMs, sha256: await sha256File(file) };
    this.remember(folder, current);
    return current;
  }

  remember(folder: SyncFolder, file: SyncFile): void {
    this.db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)").run(folder.id, file.path, file.size, file.mtimeMs, file.sha256);
  }

  forget(folder: SyncFolder, path: string): void {
    this.db.prepare("DELETE FROM files WHERE folder = ? AND path = ?").run(folder.id, path);
  }

  bytesByKind(): { pc: number; bot: number } {
    let pc = 0, bot = 0;
    for (const row of this.db.prepare("SELECT folder, SUM(size) AS bytes FROM files GROUP BY folder").all() as Array<{ folder: string; bytes: number }>) {
      if (row.folder.startsWith("bot-")) bot += row.bytes; else pc += row.bytes;
    }
    return { pc, bot };
  }

  toTrash(folder: SyncFolder, path: string, file: string): TrashEntry {
    const entry: TrashEntry = { id: randomUUID(), folderId: folder.id, path, size: lstatSync(file).size, deletedAt: this.now() };
    renameSync(file, join(this.syncDir(), "trash", entry.id));
    this.db.prepare("INSERT INTO trash (id, folder, path, size, deleted_at, cloud_path) VALUES (?, ?, ?, ?, ?, ?)").run(entry.id, entry.folderId, entry.path, entry.size, entry.deletedAt, folder.cloudPath);
    this.forget(folder, path);
    return entry;
  }

  trash(): TrashEntry[] {
    return (this.db.prepare("SELECT * FROM trash ORDER BY deleted_at DESC LIMIT 200").all() as TrashRow[]).map(trashEntryOf);
  }

  /** A deleted file, where it is kept, and the folder it came from (which may no longer sync, or be empty). */
  trashEntry(id: string): { entry: TrashEntry; file: string; cloudPath: string | null } | null {
    const row = this.db.prepare("SELECT * FROM trash WHERE id = ?").get(id) as TrashRow | undefined;
    return row ? { entry: trashEntryOf(row), file: join(this.syncDir(), "trash", row.id), cloudPath: row.cloud_path } : null;
  }

  dropTrash(id: string): void {
    this.db.prepare("DELETE FROM trash WHERE id = ?").run(id);
    rmSync(join(this.syncDir(), "trash", id), { force: true });
  }

  sweepTrash(): void {
    const cutoff = this.now() - TRASH_DAYS * 86_400_000;
    for (const row of this.db.prepare("SELECT id FROM trash WHERE deleted_at < ?").all(cutoff) as Array<{ id: string }>) this.dropTrash(row.id);
  }

  trashBytes(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM trash").get() as { bytes: number }).bytes;
  }
}
