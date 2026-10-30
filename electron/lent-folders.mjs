// Lent folders on My Cloud while this computer is away (docs/files.md): every folder lent to My Cloud also gets a copy
// there through Files when it fits, so its bots still read it, and change it when it is lent with editing, while this
// computer sleeps. Nobody chooses anything: what fits is copied, the rest stays live only. Pure, apart from
// `lendingForFiles`, main's handle on lending; cloud-sync.mjs carries the plan out.
import { randomUUID } from "node:crypto";
import { existingFolders } from "./computer-sharing.mjs";
import { cloudReserveBytes } from "./cloud-sync-rules.mjs";

/** A folder's path as its file system compares it: "/" between parts, no trailing one, and on Windows and macOS (whose
 * usual disks ignore case) one case, so "C:\Users\Ash\Notes\" and "c:/users/ash/notes" are one folder there. */
export function folderKey(value, platform) {
  const slashed = String(value).replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}

/** Whether two paths are one folder on `platform`. */
export const sameFolderOn = (platform) => (a, b) => folderKey(a, platform) === folderKey(b, platform);

/** A lent folder bigger than this keeps no copy on My Cloud: bots use it live, while this computer is on. */
export const COPY_MAX_BYTES = 3 * 1024 ** 3;
/** A folder lent without a copy is counted again after this long, in case it shrank. */
export const RECHECK_MS = 6 * 60 * 60_000;

/**
 * Which lent folders have a copy on My Cloud. One copied already (`copied`) keeps it. A new one gets one when Files may
 * share it (`checks`: its check, refusal null), it was counted in full (not `partial`) at COPY_MAX_BYTES or less, and it
 * fits the room left on My Cloud's disk, which grows by itself up to the plan's size (`planDisk.maxBytes`), less what
 * My Cloud keeps free for itself: smallest first, so one big folder never keeps the small ones out.
 * @returns {Map<string, { copy: true } | { copy: false, live: "too-big" | "refused" }>}
 */
export function planLentCopies({ folders, checks, copied, disk, planDisk = null }) {
  const plan = new Map();
  const size = Math.max(disk?.totalBytes ?? 0, planDisk?.maxBytes ?? 0);
  let room = disk ? size - (disk.totalBytes - disk.freeBytes) - cloudReserveBytes(size) : 0;
  const candidates = [];
  for (const folder of folders) {
    if (copied.has(folder.id)) { plan.set(folder.id, { copy: true }); continue; }
    const check = checks.get(folder.id);
    if (!check || check.refusal) plan.set(folder.id, { copy: false, live: "refused" });
    else if (check.partial || check.bytes > COPY_MAX_BYTES) plan.set(folder.id, { copy: false, live: "too-big" });
    else candidates.push({ folder, bytes: check.bytes });
  }
  for (const { folder, bytes } of candidates.sort((a, b) => a.bytes - b.bytes)) {
    if (bytes > room) { plan.set(folder.id, { copy: false, live: "too-big" }); continue; }
    room -= bytes;
    plan.set(folder.id, { copy: true });
  }
  return plan;
}

/** The lent folders a Files entry already copies: linked to it, or a folder the Files page shared at that path. */
export function copiedLent(shared, folders, sameFolder) {
  return new Set(folders.filter((folder) => shared.some((entry) => entry.lentId === folder.id || (!entry.lentId && sameFolder(entry.pcPath, folder.path)))).map((folder) => folder.id));
}

/**
 * Files' list once lending changed: each lent folder with a copy has its entry (a folder the Files page shared at the
 * same path becomes it, keeping its copy and records), and an entry whose folder is no longer lent goes (`dropped`: its
 * copy goes to My Cloud's trash). An entry the Files page shared that lending never took stays as it was.
 */
export function reconcileLent({ shared, folders, plan, sameFolder, now, newKey = randomUUID }) {
  const lent = new Set(folders.filter((folder) => plan.get(folder.id)?.copy).map((folder) => folder.id));
  const next = shared.filter((entry) => !entry.lentId || lent.has(entry.lentId));
  const dropped = shared.filter((entry) => entry.lentId && !lent.has(entry.lentId));
  for (const folder of folders) {
    if (!lent.has(folder.id)) continue;
    const index = next.findIndex((entry) => entry.lentId === folder.id);
    const legacy = index >= 0 ? -1 : next.findIndex((entry) => !entry.lentId && sameFolder(entry.pcPath, folder.path));
    if (index >= 0 || legacy >= 0) {
      const at = index >= 0 ? index : legacy;
      next[at] = { ...next[at], lentId: folder.id, write: folder.write === true };
      continue;
    }
    next.push({ key: newKey(), id: null, pcPath: folder.path, name: folder.name, lentId: folder.id, write: folder.write === true, deletes: null, addedAt: now });
  }
  return { shared: next, dropped };
}

/** What My Cloud is told: this computer's lent folders, each with its copy there, or why it has none. */
export function lentReport({ computerId, lendingId, name, platform, folders, plan, shared, git = new Map() }) {
  return {
    computerId, lendingId, name: String(name).slice(0, 120) || "Computer", ...(["darwin", "win32", "linux"].includes(platform) ? { platform } : {}),
    folders: folders.slice(0, 20).map((folder) => {
      const entry = shared.find((candidate) => candidate.lentId === folder.id);
      const live = plan.get(folder.id)?.copy === false ? plan.get(folder.id).live : null;
      return { id: folder.id, name: String(folder.name).slice(0, 120) || "Folder", write: folder.write === true, syncId: entry?.id ?? null, ...(live ? { live } : {}), ...(git.get(folder.id) ? { git: git.get(folder.id) } : {}) };
    }),
  };
}

/**
 * Lending to My Cloud as Files sees it, from main's pieces: `environment()` the saved server that is My Cloud,
 * `sharing()` the computer-sharing controller, `validate` validateSharedFolders.
 */
export function lendingForFiles({ environment, sharing, validate }) {
  const current = () => {
    const env = environment();
    return env ? { env, sharing: sharing() } : null;
  };
  const kept = (state) => ({ screen: state.screen === true, internet: state.internet === true, chrome: state.chrome === true, terminal: state.terminal === true });
  /** What is lent now, the home folder keeping its editing (My Cloud is the person's own). */
  const stillLent = (folders) => existingFolders(folders, (list) => validate(list, { homeEdits: true }));
  return {
    /** `{ lendingId, folders, protectedPaths }` while it lends, `{ off: true }` while it does not, null when unknown. */
    now() {
      const found = current();
      return found ? found.sharing.lentToCloud(found.env) : null;
    },
    /** One more folder, read only, on top of what is lent; lending turns on with just it when it was off. The folder as
     * lent, or null when it wasn't (a change of what is lent overtook it). */
    async lend(pcPath) {
      const found = current();
      if (!found) return null;
      const state = found.sharing.cloudState(found.env);
      const [folder] = await validate([{ id: randomUUID(), path: pcPath, write: false }]);
      if (!folder) return null;
      // A lent folder deleted since is left out, as lending itself does, so it never stops the rest.
      const lent = state.enabled ? await stillLent(state.folders) : [];
      const already = lent.find((entry) => entry.path === folder.path);
      if (already) return already;
      const saved = await found.sharing.saveCloud(found.env, { folders: [...lent, folder], ...(state.enabled ? kept(state) : {}) });
      return saved.folders.find((entry) => entry.path === folder.path) ?? null;
    },
    /** That folder is no longer lent; lending stops when it was all that was lent. */
    async unlend(folderId) {
      const found = current();
      if (!found) return;
      const state = found.sharing.cloudState(found.env);
      if (!state.enabled || !state.folders.some((folder) => folder.id === folderId)) return;
      const folders = await stillLent(state.folders.filter((folder) => folder.id !== folderId));
      const rest = kept(state);
      if (!folders.length && !Object.values(rest).some(Boolean)) { found.sharing.revoke(found.env); return; }
      await found.sharing.saveCloud(found.env, { folders, ...rest });
    },
  };
}
