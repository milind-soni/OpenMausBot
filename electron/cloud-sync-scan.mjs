// Reads a folder on this computer for Files: every regular file as a wire path with its size, modified time and sha256,
// hashing only what changed since the base. A file still being written, or open in Office, is unsettled and waits. A link
// or a hard-linked file is `kept`: there, but never carried, so it can never read as deleted; a linked folder keeps
// everything under it (`keptDirs`).
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { QUIET_MS, skipped, validWirePath } from "./cloud-sync-rules.mjs";

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

function* walkPc(root, wire = "", real = []) {
  let entries;
  // Only a folder that is not there reads as empty; anything else stops the scan, so nothing reads as deleted unproven.
  try { entries = readdirSync(join(root, ...real), { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const names = entries.map((entry) => entry.name);
  const syncNames = new Map();
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = join(root, ...real, entry.name);
    if (/\.omb-sync-[0-9a-f]+$/.test(entry.name)) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isFile()) yield { temp: true, file, mtimeMs: stat.mtimeMs };
      continue;
    }
    const name = entry.name.normalize("NFC");
    const path = wire ? `${wire}/${name}` : name;
    if (skipped(entry.name, entry.isDirectory()) || !validWirePath(path)) continue;
    const previous = syncNames.get(name);
    if (previous !== undefined && previous !== entry.name) {
      throw new Error(`${JSON.stringify(previous)} and ${JSON.stringify(entry.name)} have the same sync name. Rename one before syncing.`);
    }
    syncNames.set(name, entry.name);
    if (entry.isDirectory()) { yield* walkPc(root, path, [...real, entry.name]); continue; }
    if (entry.isSymbolicLink()) { yield { path, kept: true, dir: statSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false }; continue; }
    if (!entry.isFile()) continue;
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    if (stat.nlink !== 1) { yield { path, kept: true, dir: false }; continue; }
    const locked = names.some((other) => other.startsWith("~$") && other.length > 2 && entry.name.endsWith(other.slice(2)));
    yield { path, file, size: stat.size, mtimeMs: stat.mtimeMs, locked };
  }
}

export async function scanPc(root, base, { now = Date.now, hash = sha256File } = {}) {
  const entries = new Map();
  const temps = [], keptDirs = [];
  for (const item of walkPc(root)) {
    if (item.temp) { temps.push({ file: item.file, mtimeMs: item.mtimeMs }); continue; }
    if (item.kept) { if (item.dir) keptDirs.push(item.path); else entries.set(item.path, { kept: true }); continue; }
    const known = base.get(item.path);
    if (known && known.size === item.size && known.mtimeMs === item.mtimeMs) {
      entries.set(item.path, { sha256: known.sha256, size: item.size, mtimeMs: item.mtimeMs, file: item.file });
      continue;
    }
    if (item.locked || now() - item.mtimeMs < QUIET_MS) { entries.set(item.path, { unsettled: true }); continue; }
    let sha256;
    try { sha256 = await hash(item.file); } catch { entries.set(item.path, { unsettled: true }); continue; }
    const after = lstatSync(item.file, { throwIfNoEntry: false });
    if (!after || after.size !== item.size || after.mtimeMs !== item.mtimeMs) { entries.set(item.path, { unsettled: true }); continue; }
    entries.set(item.path, { sha256, size: item.size, mtimeMs: item.mtimeMs, file: item.file });
  }
  return { entries, temps, keptDirs };
}

/** True when the folder's file system treats "A.txt" and "a.txt" as one file. */
export function caseInsensitive(root, platform = process.platform) {
  if (platform === "win32") return true;
  const flipped = root.replace(/[A-Za-z](?=[^/]*$)/, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
  if (flipped === root) return platform === "darwin";
  try {
    const a = statSync(root), b = statSync(flipped);
    return a.ino === b.ino && a.dev === b.dev;
  } catch { return false; }
}

export function watchFolder(root, onChange, { debounceMs = 1_000, watchImpl = watch } = {}) {
  let timer = null;
  let watcher;
  try {
    watcher = watchImpl(root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
      timer.unref?.();
    });
    watcher.on?.("error", () => {});
  } catch { return () => {}; }
  return () => { clearTimeout(timer); watcher.close(); };
}
