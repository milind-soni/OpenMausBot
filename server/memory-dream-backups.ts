import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { indexedMemoryFiles, removeMemoryFile } from "./message-db.ts";
import { recordMemoryChange } from "./memory-journal.ts";
import { syncMemoryIndex, workspaceDir } from "./workspace.ts";

export const DREAM_BACKUPS = ".dream-backups";
export type DreamErrorCode = "busy" | "paused" | "changed" | "backup" | "disabled";
export class DreamMemoryError extends Error {
  readonly code: DreamErrorCode;
  readonly currentHash?: string;
  constructor(code: DreamErrorCode, currentHash?: string) { super(code); this.code = code; this.currentHash = currentHash; }
}
export interface DreamProfile { read(): string; write(text: string): void }
const backedUp = (path: string) => path === "MEMORY.md" || path === "About me" || /^memory\/(?:log\/)?[^/.][^/]*\.md$/.test(path);
const pathSchema = z.string().refine(backedUp);
const manifestSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), at: z.number(),
  files: z.array(z.object({ path: pathSchema, size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  absent: z.array(z.literal("MEMORY.md")),
});
export type DreamBackup = z.infer<typeof manifestSchema>;
type Snapshot = Map<string, Buffer>;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (files: Snapshot) => digest(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, digest(bytes)])));

function plain(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw new DreamMemoryError("backup");
}
function readPlain(path: string): Buffer {
  plain(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new DreamMemoryError("backup");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function root(botId: string): string {
  mkdirSync(workspaceDir(botId), { recursive: true, mode: 0o700 });
  plain(workspaceDir(botId), true);
  const dir = join(workspaceDir(botId), DREAM_BACKUPS);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  plain(dir, true);
  return dir;
}
function snapshot(botId: string, aboutMe?: string): Snapshot {
  const files: Snapshot = new Map();
  const dir = workspaceDir(botId);
  plain(dir, true);
  const read = (path: string) => {
    const full = join(dir, path);
    plain(full);
    files.set(path, readPlain(full));
  };
  if (present(join(dir, "MEMORY.md"))) read("MEMORY.md");
  const notes = join(dir, "memory");
  if (present(notes)) {
    plain(notes, true);
    for (const file of readdirSync(notes)) {
      if (file === "log") {
        plain(join(notes, file), true);
        for (const log of readdirSync(join(notes, file))) if (backedUp(`memory/log/${log}`)) read(`memory/log/${log}`);
      } else if (backedUp(`memory/${file}`)) read(`memory/${file}`);
    }
  }
  if (aboutMe !== undefined) files.set("About me", Buffer.from(aboutMe));
  return files;
}
function save(dir: string, files: Snapshot): DreamBackup {
  const id = randomUUID();
  const stage = join(dir, `stage-${id}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    const entries = [...files];
    entries.forEach(([, bytes], i) => writeFileAtomic(join(stage, String(i)), bytes, { mode: 0o600 }));
    const manifest: DreamBackup = { version: 1, id, at: Date.now(), files: entries.map(([path, bytes]) => ({ path, size: bytes.length, sha256: digest(bytes) })), absent: files.has("MEMORY.md") ? [] : ["MEMORY.md"] };
    writeFileAtomic(join(stage, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    renameSync(stage, join(dir, id));
    return manifest;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
function verified(dir: string, id: string): { manifest: DreamBackup; files: Snapshot } {
  if (!z.string().uuid().safeParse(id).success) throw new DreamMemoryError("backup");
  const folder = join(dir, id);
  plain(folder, true);
  plain(join(folder, "manifest.json"));
  const manifest = manifestSchema.parse(JSON.parse(readPlain(join(folder, "manifest.json")).toString("utf8")));
  if (manifest.id !== id) throw new DreamMemoryError("backup");
  const files: Snapshot = new Map();
  manifest.files.forEach((file, i) => {
    if (files.has(file.path)) throw new DreamMemoryError("backup");
    const path = join(folder, String(i));
    plain(path);
    const bytes = readPlain(path);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new DreamMemoryError("backup");
    files.set(file.path, bytes);
  });
  if (files.has("MEMORY.md") === manifest.absent.includes("MEMORY.md")) throw new DreamMemoryError("backup");
  return { manifest, files };
}
export function listDreamBackups(botId: string): DreamBackup[] {
  const dir = root(botId);
  return readdirSync(dir).filter((id) => z.string().uuid().safeParse(id).success)
    .map((id) => verified(dir, id).manifest).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}
export function backupDreamMemory(botId: string, aboutMe?: string): DreamBackup {
  const dir = root(botId);
  if (present(join(dir, "restore.json"))) throw new DreamMemoryError("backup");
  const saved = save(dir, snapshot(botId, aboutMe));
  for (const old of listDreamBackups(botId).filter((item) => item.id !== saved.id).slice(4)) rmSync(join(dir, old.id), { recursive: true });
  return saved;
}
function apply(botId: string, desired: Snapshot, current: Snapshot, profile?: DreamProfile): void {
  for (const path of new Set([...current.keys(), ...desired.keys()])) {
    const bytes = desired.get(path);
    if (path === "About me") {
      if (!profile || !bytes) throw new DreamMemoryError("backup");
      profile.write(bytes.toString("utf8"));
    } else {
      const full = join(workspaceDir(botId), path);
      if (bytes) {
        const parent = path.startsWith("memory/log/") ? "memory/log" : path.startsWith("memory/") ? "memory" : "";
        if (parent) mkdirSync(join(workspaceDir(botId), parent), { recursive: true, mode: 0o700 });
        writeFileAtomic(full, bytes, { mode: 0o600 });
      } else if (existsSync(full)) unlinkSync(full);
    }
  }
}
function reindex(botId: string): void {
  for (const file of indexedMemoryFiles(botId)) removeMemoryFile(botId, file.path);
  syncMemoryIndex(botId);
}

export function recoverDreamRestore(botId: string, profile?: DreamProfile): void {
  const pending = join(workspaceDir(botId), DREAM_BACKUPS, "restore.json");
  if (!existsSync(pending)) return;
  const dir = root(botId);
  plain(pending);
  const recovery = z.object({ id: z.string().uuid() }).parse(JSON.parse(readFileSync(pending, "utf8")));
  const { files } = verified(dir, recovery.id);
  const current = snapshot(botId, profile?.read());
  apply(botId, files, current, profile);
  reindex(botId);
  unlinkSync(pending);
}

export function restoreDreamMemory(botId: string, options: { id?: string; expectedHash?: string }, profile?: DreamProfile): void {
  const dir = root(botId);
  if (present(join(dir, "restore.json"))) throw new DreamMemoryError("backup");
  const id = options.id ?? listDreamBackups(botId)[0]?.id;
  if (!id) throw new DreamMemoryError("backup");
  const { files } = verified(dir, id);
  if (files.has("About me") && !profile) throw new DreamMemoryError("backup");
  const current = snapshot(botId, profile?.read());
  const hash = fingerprint(current);
  if (hash !== fingerprint(files) && options.expectedHash !== hash) throw new DreamMemoryError("changed", hash);
  const recovery = save(dir, current);
  const pending = join(dir, "restore.json");
  writeFileAtomic(pending, JSON.stringify({ id: recovery.id }), { mode: 0o600 });
  try {
    apply(botId, files, current, profile);
  } catch (error) {
    apply(botId, current, files, profile);
    unlinkSync(pending);
    throw error;
  } finally {
    reindex(botId);
  }
  unlinkSync(pending);
  for (const path of new Set([...current.keys(), ...files.keys()])) {
    const entry = recordMemoryChange(botId, { path, actor: "person", via: "dream-restore", before: current.get(path)?.toString("utf8") ?? null, after: files.get(path)?.toString("utf8") ?? null });
    if (path === "About me" && entry) entry.canRevert = false;
  }
  for (const old of listDreamBackups(botId).filter((item) => item.id !== recovery.id).slice(4)) rmSync(join(dir, old.id), { recursive: true });
}
