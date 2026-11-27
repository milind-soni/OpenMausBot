// An in-memory My Cloud with createSyncClient's surface, for the Files engine and service tests.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const GB = 1024 ** 3;

export function fakeCloud({ freeBytes = 100 * GB } = {}) {
  const folders = new Map();
  const calls = [];
  const missing = new Set();
  // Lent folders (server/lent-copies.ts): the last report, each copy's last pass in step, and bots' changes waiting.
  const lent = { reports: [], synced: new Map(), staged: [] };
  let ids = 0;
  let bots = { bots: [], groups: [] };
  const state = { freeBytes, lentCopies: true };
  const files = (id) => folders.get(id).files;
  const info = (path, bytes) => ({ path, size: bytes.length, mtimeMs: 1, sha256: sha(bytes) });
  const client = {
    summary: async () => ({ ...(state.lentCopies ? { lentCopies: true } : {}), folders: [...folders.values()].map((entry) => (entry.folder.kind === "pc" ? { ...entry.folder, staged: lent.staged.filter((change) => change.syncId === entry.folder.id).length, ...(entry.cloning ? { cloning: true } : {}) } : entry.folder)), cursor: 1, disk: { totalBytes: 10 * GB, freeBytes: state.freeBytes, syncedBytes: 0, botFileBytes: 0, trashBytes: 0, reserveBytes: GB } }),
    register: async (input) => {
      calls.push(["register", input.pcPath]);
      const existing = [...folders.values()].find((entry) => entry.folder.pcPath === input.pcPath && entry.folder.computerId === input.computerId);
      if (existing) return existing.folder;
      const folder = { id: `pc-${++ids}`, kind: "pc", computerId: input.computerId, computerName: input.computerName, pcPath: input.pcPath, cloudPath: `/data/Synced/PC/${input.name}` };
      // Like My Cloud with git that can reach the repository: a lent GitHub repository's copy starts as a clone.
      const cloning = Boolean(state.clones && input.lent && input.git);
      folders.set(folder.id, { folder, files: new Map(), cloning, git: input.git ?? null });
      return cloning ? { ...folder, cloning: true } : folder;
    },
    unregister: async (id, keep) => { calls.push(["unregister", id, keep]); folders.delete(id); },
    files: async (id) => {
      if (missing.has(id)) throw Object.assign(new Error("missing"), { status: 410 });
      return [...files(id)].map(([path, bytes]) => info(path, bytes));
    },
    upload: async ({ folderId, path, file, size, sha256, baseSha256 }) => {
      calls.push(["upload", path]);
      if (state.freeBytes - size < GB) return { full: true, neededBytes: size + GB, freeBytes: state.freeBytes };
      const current = files(folderId).get(path);
      if ((current ? sha(current) : null) !== baseSha256) return { conflict: true, current: current ? info(path, current) : null };
      const bytes = readFileSync(file);
      if (sha(bytes) !== sha256) throw new Error("hash mismatch");
      files(folderId).set(path, bytes);
      state.freeBytes -= size;
      return { ok: true };
    },
    download: async (folderId, path, temporary) => {
      calls.push(["download", path]);
      const bytes = files(folderId).get(path);
      writeFileSync(temporary, bytes);
      return { sha256: sha(bytes) };
    },
    ops: async (folderId, ops) => ops.map((op) => {
      const list = files(folderId);
      if (op.op === "delete") {
        calls.push(["delete", op.path]);
        const current = list.get(op.path);
        if (current && sha(current) !== op.baseSha256) return { conflict: true, current: info(op.path, current) };
        list.delete(op.path);
        return { ok: true };
      }
      throw new Error(`unknown op ${op.op}`);
    }),
    // Like the real long poll, answers only when told to stop: a loop over it must not spin.
    changes: (_cursor, _waitMs, signal) => new Promise((resolve) => {
      if (signal?.aborted) return resolve({ cursor: 1, folderIds: [] });
      signal?.addEventListener("abort", () => resolve({ cursor: 1, folderIds: [] }), { once: true });
    }),
    trash: async () => [],
    restore: async () => ({}),
    bots: async () => bots,
    lent: async (report) => { calls.push(["lent"]); lent.reports.push(report); return { ok: true }; },
    synced: async (id) => { lent.synced.set(id, (lent.synced.get(id) ?? 0) + 1); return { ok: true }; },
    staged: async (id) => lent.staged.filter((change) => change.syncId === id).map(({ id: changeId, path, bytes, base }) => ({ id: changeId, path, sha256: sha(bytes), size: bytes.length, baseSha256: base, at: 1 })),
    stagedFile: async (id, changeId, temporary) => {
      const change = lent.staged.find((entry) => entry.syncId === id && entry.id === changeId);
      writeFileSync(temporary, change.damaged ?? change.bytes);
      return { sha256: sha(change.bytes) };
    },
    stagedDone: async (id, changeId, sha256) => {
      calls.push(["staged-done", changeId]);
      lent.staged = lent.staged.filter((entry) => !(entry.syncId === id && entry.id === changeId && sha(entry.bytes) === sha256));
      return { ok: true };
    },
  };
  return {
    client, folders, missing, calls, state,
    addFolder(folder) { folders.set(folder.id, { folder, files: new Map() }); return folder; },
    put(folderId, path, text) { files(folderId).set(path, Buffer.from(text)); },
    get(folderId, path) { return files(folderId).get(path)?.toString(); },
    setBots(value) { bots = value; },
    lent,
    /** The clone landed: these files are in the copy now. */
    cloned(folderId, files) { const entry = folders.get(folderId); entry.cloning = false; for (const [path, text] of Object.entries(files)) entry.files.set(path, Buffer.from(text)); },
    /** A bot's change while the computer was away: `base` is the sha256 it was read at, null for a new file. */
    stage(syncId, path, text, base = null) { const change = { id: `change-${++ids}`, syncId, path, bytes: Buffer.from(text), base }; lent.staged.push(change); return change; },
  };
}
