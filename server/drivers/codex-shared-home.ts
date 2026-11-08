// A ChatGPT-plan instance signs in on a Codex home of its own, so its login never mixes with the person's. Everything
// else the person set up for Codex (config.toml, skills, plugins, sessions, MCP sign-ins) is linked in from their own
// home, so a plan turn works like their own Codex. Company Codex homes never come here: they stay fully separate.
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Made in the person's home first, so a plan shares them from its first turn. */
const SHARED_FOLDERS = ["sessions", "archived_sessions", "sqlite", "shell_snapshots", "worktrees", "skills", "plugins", "cache",
  "logs", "mcp-oauth-locks", "thread-writer-locks"];
/** The plan's own sign-in and model list: always real files in its own home, never links. */
const PRIVATE = new Set(["auth.json", "auth.lock", "models_cache.json"]);
/** Kept per home. */
const LOCAL = new Set(["log", "memories", "tmp", ".DS_Store"]);
/** Locks that guard shared state: a plan's own copy gives way to the shared one once no lock in it is held. */
const RUNTIME_LOCKS = new Set(["mcp-oauth-locks", "thread-writer-locks", ".sqlite-maintenance.lock"]);
/** What Codex writes into a folder by itself and rebuilds: a plan folder holding nothing else gives way to a link. */
const REBUILT = new Set([".system", ".DS_Store"]);
// SQLite opens a database through its link and keeps -wal and -shm beside the real file; a journal linked on its own
// would pair one home's journal with the other home's database.
const SQLITE_JOURNAL = /-(?:wal|shm|journal)$/;

const noted = new Set<string>();
function note(path: string, message: string): void {
  if (noted.has(path)) return;
  noted.add(path);
  console.error(`codex: ${message}`);
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** A real entry the plan made itself that holds nothing of its own, or only locks no one holds any more. */
function givesWay(path: string, name: string): boolean {
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return RUNTIME_LOCKS.has(name);
  const names = readdirSync(path);
  if (RUNTIME_LOCKS.has(name)) return !names.some(entry => entry.endsWith(".lock") && entry !== ".coordination.lock");
  return names.every(entry => REBUILT.has(entry));
}

/** Links one entry; false when the plan keeps a real one of its own. */
function linkEntry(target: string, link: string, name: string): boolean {
  let stats;
  try { stats = lstatSync(link); } catch { stats = null; }
  if (stats?.isSymbolicLink()) {
    try { if (realpathSync(link) === realpathSync(target)) return true; } catch {}
    unlinkSync(link);
  } else if (stats) {
    // Earlier plan turns kept their own sessions and history here: never delete them, keep using them.
    if (!givesWay(link, name)) return false;
    rmSync(link, { recursive: true, force: true });
  }
  const folder = statSync(target).isDirectory();
  try {
    symlinkSync(target, link, process.platform === "win32" ? (folder ? "junction" : "file") : undefined);
  } catch (error) {
    // Another turn of the same plan linked it first.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return true;
}

/** Makes the plan's Codex home and links the person's own Codex home into it. Linking never fails the turn: an entry
 * that cannot be linked (a file link Windows refuses without Developer Mode) stays as the plan had it. */
export function linkSharedCodexHome(sharedHome: string | null, planHome: string): void {
  mkdirSync(planHome, { recursive: true, mode: 0o700 });
  if (!sharedHome || !isAbsolute(sharedHome) || !isAbsolute(planHome)) return;
  const shared = resolve(sharedHome), own = resolve(planHome);
  if (inside(shared, own) || inside(own, shared)) return;
  let names: string[];
  try {
    for (const name of SHARED_FOLDERS) mkdirSync(join(shared, name), { recursive: true, mode: 0o700 });
    names = readdirSync(shared);
  } catch (error) {
    return note(shared, `could not share your Codex home with the ChatGPT plan: ${(error as Error).message}`);
  }
  for (const name of PRIVATE) {
    const path = join(own, name);
    try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path); } catch {}
  }
  const kept: string[] = [];
  for (const name of new Set([...SHARED_FOLDERS, ...names])) {
    if (PRIVATE.has(name) || LOCAL.has(name) || SQLITE_JOURNAL.test(name)) continue;
    try {
      if (!linkEntry(join(shared, name), join(own, name), name)) kept.push(name);
    } catch (error) {
      note(join(own, name), `could not link ${JSON.stringify(name)} of your Codex home for the ChatGPT plan: ${(error as Error).message}`);
    }
  }
  if (kept.length) note(own, `the ChatGPT plan's Codex home keeps its own ${kept.join(", ")} from earlier turns; the rest of your Codex home is shared`);
}
