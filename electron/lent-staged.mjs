// Bots' changes to a lent folder, made on My Cloud while this computer was away (server/lent-copies.ts), applied here
// once it is back, under the same rules as a live write (electron/shared-computer-access.mjs): only a folder lent with
// editing, never through a link, never inside .git or a protected place. A file the person did not touch since takes
// the bot's version, and the one it replaces goes to the Recycle Bin first; a file they changed or removed meanwhile
// keeps theirs, and the bot's version lands beside it, "report (new from My Cloud, 27 Oct 2026).md". Nothing here is
// ever deleted.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clashPath, validWirePath, windowsProblem } from "./cloud-sync-rules.mjs";
import { sha256File } from "./cloud-sync-scan.mjs";
import { assertOutsideProtected, insideGitInternals, protectedIdentities, sharedPath } from "./shared-computer-access.mjs";

export const BESIDE_LABEL = "new from My Cloud";

const same = (a, b) => a && b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

/** Windows refuses a rename for a moment while anything (a virus scanner, the indexer) holds the file, as EPERM, EACCES or
 * EBUSY that would succeed shortly: those are tried again (about 155 ms at most, as server/atomic.ts does); anything else
 * throws. */
const RENAME_RETRY_MS = [5, 10, 20, 40, 80];
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
export function renameWithRetry(from, to, rename = fs.renameSync, wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  for (let attempt = 0; ; attempt++) {
    try { return rename(from, to); } catch (error) {
      if (!TRANSIENT.has(error?.code) || attempt >= RENAME_RETRY_MS.length) throw error;
      wait(RENAME_RETRY_MS[attempt]);
    }
  }
}

/** The file's own permissions on the bot's version, once it is in place: a script stays runnable, a read-only file stays
 * read-only. Set after the rename, never on the half-written file, so a read-only one never lingers where Files cleans up
 * (Windows can't remove a read-only file). Best effort: the change has landed either way. */
function keepPermissions(file, before) {
  if (!before?.isFile()) return;
  try { fs.chmodSync(file, before.mode & 0o777); } catch {}
}

/**
 * Applies the changes waiting on My Cloud for one lent folder (`folder`: as lent, with its path). A change for a folder
 * no longer lent with editing stays waiting there. `stopper(error)`: an error that stops the whole pass (signed out,
 * offline), thrown on. Answers how many changes landed and, for each one kept beside the person's own version, both
 * names.
 */
export async function applyStaged({ client, folderId, folder, protectedPaths = [], now = Date.now, trashItem, markDownloaded = async () => {}, platform = process.platform, stopper = () => false }) {
  const outcome = { applied: 0, kept: [], problem: null };
  if (folder.write !== true) return outcome;
  const changes = await client.staged(folderId);
  const protectedRoots = await protectedIdentities(protectedPaths);
  for (const change of changes) {
    try {
      const landed = await applyOne({ client, folderId, folder, change, protectedRoots, now, trashItem, markDownloaded, platform });
      if (!landed) continue;
      await client.stagedDone(folderId, change.id, change.sha256);
      if (landed.beside) outcome.kept.push({ path: change.path, beside: landed.beside, at: now() });
      else outcome.applied++;
    } catch (error) {
      if (stopper(error)) throw error;
      outcome.problem ??= `${change.path}: ${error?.message ?? error}`;
    }
  }
  return outcome;
}

async function applyOne({ client, folderId, folder, change, protectedRoots, now, trashItem, markDownloaded, platform }) {
  if (!validWirePath(change.path) || (platform === "win32" && windowsProblem(change.path))) throw new Error("This computer can't hold that name.");
  if (insideGitInternals(folder.path, change.path)) throw new Error("Files inside .git are never changed from My Cloud.");
  const target = await sharedPath(folder, change.path);
  await assertOutsideProtected(protectedRoots, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Named like Files' own half-downloaded files, so a crash leaves nothing a scan would carry.
  const tag = createHash("sha256").update(`${folderId}\n${change.id}`).digest("hex").slice(0, 8);
  const temporary = path.join(path.dirname(target), `.${path.basename(target).slice(0, 180)}.omb-sync-${tag}`);
  try {
    await client.stagedFile(folderId, change.id, temporary);
    if (await sha256File(temporary) !== change.sha256) throw new Error("The change was damaged on its way; it will be fetched again.");
    await markDownloaded(temporary);
    const before = fs.lstatSync(target, { throwIfNoEntry: false });
    if (before?.isFile() && before.nlink === 1) {
      const sha256 = await sha256File(target);
      const after = fs.lstatSync(target, { throwIfNoEntry: false });
      if (same(before, after) && sha256 === change.sha256) return { applied: true };
      // Untouched since the bot read it: the bot's version, with the file's own permissions (a script stays runnable, as
      // a live write in place keeps them), and the one it replaces to the Recycle Bin.
      if (same(before, after) && sha256 === change.baseSha256) {
        await trashItem(target);
        renameWithRetry(temporary, target);
        keepPermissions(target, before);
        return { applied: true };
      }
    } else if (!before && change.baseSha256 === null) {
      renameWithRetry(temporary, target);
      return { applied: true };
    }
    // The person changed it, removed it, or something else is there now: theirs stays, the bot's lands beside it.
    const beside = clashPath(change.path, now(), (candidate) => fs.existsSync(path.join(folder.path, ...candidate.split("/"))), BESIDE_LABEL);
    const besideFile = await sharedPath(folder, beside);
    await assertOutsideProtected(protectedRoots, besideFile);
    renameWithRetry(temporary, besideFile);
    keepPermissions(besideFile, before);
    return { applied: true, beside };
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
