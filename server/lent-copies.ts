// Lent folders while the computer that lends them is away (docs/files.md, "Lent folders while the computer is away").
// The desktop keeps a copy of each lent folder here through Files and says what it lends (`report`); while that computer
// is away, shared_computer's folder actions are answered from the copy instead of failing. A write to a folder lent with
// editing waits here (staged) until the desktop is back and applies it there (electron/lent-staged.mjs). Nothing here
// writes the copy itself: the person's computer stays the authority for its files.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { validWirePath } from "../electron/cloud-sync-rules.mjs";
import { SyncError } from "./cloud-sync.ts";
import { SyncPathError, insideFolder } from "./cloud-sync-paths.ts";
import { readFolders } from "./cloud-sync-store.ts";
import { LENT_PLATFORMS, deviceWord } from "./lent-computers.ts";
import { lentGit } from "./lent-clone.ts";

/** The same limits as a live read and write (electron/shared-computer-access.mjs). */
const READ_LIMIT = 2 * 1024 * 1024;
const WRITE_LIMIT = 256 * 1024;
const LIST_LIMIT = 200;
/** Changes waiting for the computer: at most this many, and this many bytes, on one Cloud. */
const STAGED_MAX = 500;
const STAGED_MAX_BYTES = 64 * 1024 * 1024;
const STAGED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** On a Cloud home every lent computer is the owner's, under this one name (index.ts CLOUD_HOME_LENDER). */
const OWNER = "cloud-home";
const GIT_INTERNALS = "Files inside .git cannot be changed through a shared folder: git runs commands from its configuration and hooks";
const SHA = /^[0-9a-f]{64}$/;
const SYNC_ID = /^[\w-]{1,200}$/;

const lentFolder = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), write: z.boolean(),
  /** Its copy here (a Files folder id), or null: kept only on the computer ("too-big" for the copy, "refused" by Files' rules). */
  syncId: z.string().regex(SYNC_ID).nullable(), live: z.enum(["too-big", "refused"]).optional(),
  /** A GitHub repository: bots return code work as a branch and a pull request. */
  git: lentGit.optional(),
}).strict();
export const lentReport = z.object({
  computerId: z.string().uuid(), lendingId: z.string().uuid(), name: z.string().min(1).max(120),
  platform: z.enum(LENT_PLATFORMS).optional(), folders: z.array(lentFolder).max(20),
}).strict();
type Report = z.infer<typeof lentReport> & { at: number };
type LentFolder = z.infer<typeof lentFolder>;
export interface StagedChange { id: string; syncId: string; path: string; sha256: string; size: number; base: string | null; at: number }
interface State { version: 1; computers: Record<string, Report>; synced: Record<string, number>; staged: StagedChange[] }

type Operation = { action: string; computer_id?: string; folder_id?: string; path?: string; content?: string; encoding?: "utf8" | "base64"; expected_sha256?: string };
type Result = { content: Array<{ type: "text"; text: string }>; isError?: true };
const text = (value: unknown): Result => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const refusal = (message: string): Result => ({ ...text(message), isError: true });
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** How fresh a copy is, the way a bot says it: "from 2 h ago". */
export function copyAge(at: number | null | undefined, now: number): string {
  if (typeof at !== "number") return "still being copied, so some files may be missing";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 2) return "from just now";
  if (minutes < 60) return `from ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `from ${hours} h ago` : `from ${Math.round(hours / 24)} days ago`;
}

/** A bot's relative path as a wire path ("" for the folder itself), or null when it is not one inside the folder. */
function wirePath(value: string | undefined): string | null {
  const raw = (value ?? "").trim();
  if (/[\\:\0]/.test(raw) || raw.startsWith("/")) return null;
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return null;
  const joined = parts.join("/").normalize("NFC");
  return joined === "" || validWirePath(joined) ? joined : null;
}

export function createLentCopies(options: { dataDir: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const dir = join(options.dataDir, "sync");
  const file = join(dir, "lent.json");
  const blobs = join(dir, "staged");
  const blob = (id: string) => join(blobs, id);

  const read = (): State => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as State;
      if (value?.version === 1 && value.computers && value.synced && Array.isArray(value.staged)) return value;
    } catch {}
    return { version: 1, computers: {}, synced: {}, staged: [] };
  };
  const write = (state: State) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(state), { mode: 0o600 });
  };
  const change = (work: (state: State) => void) => { const state = read(); work(state); write(state); };

  /** The lent folder a bot names, with the computer lending it; the newest report wins. */
  const lent = (folderId: string | undefined): { computer: Report; folder: LentFolder } | null => {
    if (!folderId) return null;
    for (const computer of Object.values(read().computers).sort((a, b) => b.at - a.at)) {
      const folder = computer.folders.find((entry) => entry.id === folderId);
      if (folder) return { computer, folder };
    }
    return null;
  };
  const copyOf = (syncId: string) => {
    const folder = readFolders(options.dataDir).find((entry) => entry.id === syncId);
    return folder && lstatSync(folder.cloudPath, { throwIfNoEntry: false })?.isDirectory() ? folder.cloudPath : null;
  };
  const pending = (state: State, syncId: string, path: string) => state.staged.find((entry) => entry.syncId === syncId && entry.path === path);
  /** The file at `path` in the copy, or null; never through a link. */
  const inCopy = (root: string, path: string): { file: string; size: number } | null => {
    const target = insideFolder(root, path);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    return stat?.isFile() && stat.nlink === 1 ? { file: target, size: stat.size } : null;
  };

  function list(root: string, path: string, syncId: string, state: State, said: Record<string, string>): Result {
    const target = path ? insideFolder(root, path) : root;
    let entries: Array<{ name: string; type: string; changes_waiting?: true }> = [];
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      entries = readdirSync(target, { withFileTypes: true }).map((entry) => ({ name: entry.name, type: entry.isSymbolicLink() ? "blocked-link" : entry.isDirectory() ? "directory" : "file" }));
    } else if (stat) return refusal("That is a file, not a folder.");
    const prefix = path ? `${path}/` : "";
    for (const change of state.staged) {
      if (change.syncId !== syncId || !change.path.startsWith(prefix) || change.path.slice(prefix.length).includes("/")) continue;
      const name = change.path.slice(prefix.length), known = entries.find((entry) => entry.name === name);
      if (known) known.changes_waiting = true; else entries.push({ name, type: "file", changes_waiting: true });
    }
    if (!stat && !entries.length) return refusal(said.missing!);
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return text({ entries: entries.slice(0, LIST_LIMIT), truncated: entries.length > LIST_LIMIT, ...said.about ? { from: said.about } : {}, note: said.note });
  }

  function readFile(root: string, path: string, syncId: string, state: State, operation: Operation, said: Record<string, string>): Result {
    const change = pending(state, syncId, path);
    let data: Buffer;
    if (change) data = readFileSync(blob(change.id));
    else {
      const found = inCopy(root, path);
      if (!found) return refusal(lstatSync(insideFolder(root, path), { throwIfNoEntry: false }) ? "Only regular, single-link files up to 2 MiB can be shared" : said.missing!);
      if (found.size > READ_LIMIT) return refusal("Only regular, single-link files up to 2 MiB can be shared");
      data = readFileSync(found.file);
    }
    const encoding = operation.encoding ?? "utf8";
    return text({ content: data.toString(encoding === "base64" ? "base64" : "utf8"), encoding, bytes: data.length, sha256: hash(data),
      from: change ? "your change saved on the Cloud, still waiting for their computer" : said.about, note: said.note });
  }

  function writeFile(root: string, path: string, syncId: string, folder: LentFolder, operation: Operation, said: Record<string, string>): Result {
    if (!folder.write) return refusal("This folder is read-only.");
    if (!path) return refusal("Give the path of a file inside the folder.");
    if (path.split("/").some((part) => part.normalize("NFC").toLowerCase() === ".git")) return refusal(GIT_INTERNALS);
    if (typeof operation.content !== "string") return refusal("Give file content to write");
    const data = Buffer.from(operation.content, operation.encoding === "base64" ? "base64" : "utf8");
    if (data.length > WRITE_LIMIT) return refusal("A file written here is limited to 256 KiB");
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const stat = lstatSync(insideFolder(root, parts.slice(0, index).join("/")), { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) return refusal(`${parts.slice(0, index).join("/")} is a file, not a folder.`);
    }
    if (lstatSync(insideFolder(root, path), { throwIfNoEntry: false })?.isDirectory()) return refusal("That is a folder, not a file.");
    const state = read();
    const change = pending(state, syncId, path);
    const found = change ? null : inCopy(root, path);
    // A file too big to read can't be overwritten either: never hashed whole for nothing.
    if (found && found.size > READ_LIMIT) return refusal("Only regular, single-link files up to 2 MiB can be shared");
    const current = change ? change.sha256 : found ? hash(readFileSync(found.file)) : null;
    if (current && !operation.expected_sha256) return refusal("That file already exists. Read it first, then pass its sha256 as expected_sha256 to overwrite it.");
    if (operation.expected_sha256 && operation.expected_sha256 !== current) return refusal("File changed. Read it again before overwriting it.");
    const others = state.staged.filter((entry) => entry !== change);
    if (others.length >= STAGED_MAX || others.reduce((sum, entry) => sum + entry.size, 0) + data.length > STAGED_MAX_BYTES) {
      return refusal("Too many changes are already waiting for their computer. Tell them in a few words that the rest has to wait until it's on.");
    }
    const id = change?.id ?? randomUUID();
    mkdirSync(blobs, { recursive: true, mode: 0o700 });
    writeFileSync(blob(id), data, { mode: 0o600 });
    const next: StagedChange = { id, syncId, path, sha256: hash(data), size: data.length, base: change ? change.base : current, at: now() };
    state.staged = [...others, next];
    write(state);
    return text({ written: true, bytes: data.length, sha256: next.sha256, saved: "on the Cloud", note: said.saved });
  }

  return {
    // ── The desktop (through /api/sync, the owner's session only) ──
    /** What a computer lends now, and where each folder's copy is. */
    report(body: unknown): void {
      const parsed = lentReport.safeParse(body);
      if (!parsed.success) throw new SyncError(400, { error: "invalid lent folders" });
      change((state) => { state.computers[parsed.data.computerId] = { ...parsed.data, at: now() }; });
    },
    /** A pass over this copy finished in step with the computer: the copy is as fresh as now. */
    synced(syncId: string): void { change((state) => { state.synced[syncId] = now(); }); },
    staged(syncId: string): Array<{ id: string; path: string; sha256: string; size: number; baseSha256: string | null; at: number }> {
      return read().staged.filter((entry) => entry.syncId === syncId).map(({ id, path, sha256, size, base, at }) => ({ id, path, sha256, size, baseSha256: base, at }));
    },
    stagedCount(syncId: string): number { return read().staged.filter((entry) => entry.syncId === syncId).length; },
    stagedFile(syncId: string, id: string): { file: string; size: number; sha256: string } {
      const found = read().staged.find((entry) => entry.syncId === syncId && entry.id === id);
      if (!found) throw new SyncError(404, { error: "no such change" });
      return { file: blob(found.id), size: found.size, sha256: found.sha256 };
    },
    /** The desktop applied (or set aside) the change with this sha256. A bot that changed it again since keeps its newer
     * version waiting, now based on what the computer has. */
    stagedDone(syncId: string, id: string, body: unknown): void {
      const sha256 = (body as { sha256?: unknown } | null)?.sha256;
      if (typeof sha256 !== "string" || !SHA.test(sha256)) throw new SyncError(400, { error: "invalid change" });
      change((state) => {
        const found = state.staged.find((entry) => entry.syncId === syncId && entry.id === id);
        if (!found) return;
        if (found.sha256 !== sha256) { found.base = sha256; return; }
        state.staged = state.staged.filter((entry) => entry !== found);
        rmSync(blob(found.id), { force: true });
      });
    },
    /** Changes older than a month, or for a copy that is gone, are dropped. */
    sweep(): void {
      const known = new Set(readFolders(options.dataDir).map((folder) => folder.id));
      const state = read();
      const kept = state.staged.filter((entry) => known.has(entry.syncId) && entry.at + STAGED_KEEP_MS > now());
      if (kept.length === state.staged.length) return;
      for (const entry of state.staged) if (!kept.includes(entry)) rmSync(blob(entry.id), { force: true });
      state.staged = kept;
      write(state);
    },

    // ── Bots (SharedComputers, for the owner's turns) ──
    /** list_shared_computers' addition while a lending computer is away: its folders, how fresh each copy is, and what to say. */
    away(principal: string | null, online: ReadonlyArray<{ id: string; name: string }>): { away_computers?: unknown[]; say?: string } {
      if (principal !== OWNER) return {};
      const state = read();
      const away = Object.values(state.computers)
        .filter((computer) => computer.folders.length && !online.some((entry) => entry.id === computer.lendingId || entry.name === computer.name))
        .sort((a, b) => b.at - a.at);
      if (!away.length) return {};
      const at = now();
      const away_computers = away.map((computer) => ({
        computer_id: computer.lendingId, name: computer.name, device: deviceWord(computer.platform), away: true,
        folders: computer.folders.map((folder) => {
          const waiting = folder.syncId ? state.staged.filter((entry) => entry.syncId === folder.syncId).length : 0;
          return { folder_id: folder.id, name: folder.name, write: folder.write, copy: folder.syncId ? copyAge(state.synced[folder.syncId], at) : null, ...(waiting ? { changes_waiting: waiting } : {}),
            ...(folder.git ? { github: folder.git.repo, ...(folder.git.branch ? { branch: folder.git.branch } : {}) } : {}) };
        }),
      }));
      const device = deviceWord(away[0]!.platform);
      return { away_computers, say: `Their ${device} ${away[0]!.name} is away, but the folders it lends still work from the Cloud's copy: list and read them with shared_computer as usual, with the computer_id and folder_id in away_computers (each answer says how fresh it is, like "from 2 h ago"). A change to a folder lent with editing is saved on the Cloud and reaches the ${device} when it's on: say so in a few words. A folder whose copy is null is only on the ${device}.${away.some((computer) => computer.folders.some((folder) => folder.git)) ? " A folder with github is that GitHub repository: return code changes there as a new branch and a pull request with your GitHub tools when you have them, not as writes to the folder." : ""} Apps and screen and the terminal need the ${device} on.` };
    },
    /** A folder action for a computer that is away, answered from its copy; null when there is no copy to answer from. */
    answer(operation: Operation, principal: string | null, online: ReadonlyArray<{ id: string; name: string }> = []): Promise<Result> | null {
      if (principal !== OWNER || !["list_files", "read_file", "write_file"].includes(operation.action)) return null;
      const found = lent(operation.folder_id);
      if (!found) return null;
      const { computer, folder } = found;
      const device = deviceWord(computer.platform);
      // Back with a new grant (lending changed meanwhile): the live folder, not the copy.
      if (online.some((entry) => entry.name === computer.name)) return Promise.resolve(refusal(`Their ${device} is on again: call list_shared_computers for its current computer_id and folder_id, then try again.`));
      // A folder only ever with the computer that lends it.
      if (operation.computer_id !== computer.lendingId) return Promise.resolve(refusal(`That folder is lent by ${computer.name}: use its computer_id from list_shared_computers.`));
      const later = `Tell them in a few words that you'll get it when their ${device} is on.`;
      if (!folder.syncId) return Promise.resolve(refusal(`${folder.name} is only on their ${device}${folder.live === "too-big" ? ": it is too big to keep a copy on the Cloud" : ""}. ${later}`));
      const root = copyOf(folder.syncId);
      if (!root) return Promise.resolve(refusal(`${folder.name} is still being copied to the Cloud. ${later}`));
      const path = wirePath(operation.path);
      if (path === null) return Promise.resolve(refusal("Use a relative path inside the shared folder"));
      const state = read();
      const age = copyAge(state.synced[folder.syncId], now());
      const said = {
        about: `the Cloud's copy, ${age}`,
        note: `Their ${device} is away, so this comes from the Cloud's copy (${age}). Say so if it matters.`,
        missing: `That one isn't in the Cloud's copy (${age}): it is only on their ${device}, or new since. ${later}`,
        saved: `Their ${device} is away. This change is saved on the Cloud and reaches their ${device} when it's on: tell them so in a few words ("saved; it'll reach your ${device} when it's on").`,
      };
      try {
        if (operation.action === "list_files") return Promise.resolve(list(root, path, folder.syncId, state, said));
        if (!path) return Promise.resolve(refusal("Give the path of a file inside the folder."));
        if (operation.action === "read_file") return Promise.resolve(readFile(root, path, folder.syncId, state, operation, said));
        return Promise.resolve(writeFile(root, path, folder.syncId, folder, operation, said));
      } catch (error) {
        if (error instanceof SyncPathError) return Promise.resolve(refusal("Symbolic links cannot be followed in shared folders"));
        throw error;
      }
    },
  };
}

export type LentCopies = ReturnType<typeof createLentCopies>;
