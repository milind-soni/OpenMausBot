// MausBot's Codex turns run in Codex homes of its own. A ChatGPT-plan instance signs in there, so its login never mixes
// with the person's; a turn on the person's own Codex sign-in links their login in. Everything else the person set up for
// Codex (config.toml, skills, plugins, MCP sign-ins) is linked in from their own home, so a turn works like their own
// Codex, but MausBot's chats stay in its own home: the Codex and ChatGPT apps list every session in the person's home as
// their history. Company Codex homes never come here: they stay fully separate.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { DATA_DIR } from "../config.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";
import { codexHome } from "./codex-identity.ts";

/** Made in the person's home first, so a turn shares them from its first run. */
const SHARED_FOLDERS = ["worktrees", "skills", "plugins", "cache", "logs", "mcp-oauth-locks"];
/** A plan's own sign-in and model list: always real files in its own home, never links. */
const PRIVATE = new Set(["auth.json", "auth.lock", "models_cache.json"]);
/** Where Codex keeps its chats and the list the apps show (codex-cli 0.167.2): never linked, so each home has its own. */
const CHATS = new Set(["sessions", "archived_sessions", "sqlite", "shell_snapshots", "thread-writer-locks", "history.jsonl",
  "session_index.jsonl", "session_index.jsonl.lock", ".sqlite-maintenance.lock"]);
/** Codex's databases (state_5.sqlite holds the chat list) sit in the home unless config.toml moves them. */
const DATABASE = /\.sqlite$/;
/** Kept per home. */
const LOCAL = new Set(["log", "memories", "tmp", ".DS_Store"]);
/** Locks that guard shared state: a home's own copy gives way to the shared one once no lock in it is held. */
const RUNTIME_LOCKS = new Set(["mcp-oauth-locks"]);
/** What Codex writes into a folder by itself and rebuilds: a folder holding nothing else gives way to a link. */
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

/** A real entry the home made itself that holds nothing of its own, or only locks no one holds any more. */
function givesWay(path: string, name: string): boolean {
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return RUNTIME_LOCKS.has(name);
  const names = readdirSync(path);
  if (RUNTIME_LOCKS.has(name)) return !names.some(entry => entry.endsWith(".lock") && entry !== ".coordination.lock");
  return names.every(entry => REBUILT.has(entry));
}

/** Links one entry; false when the home keeps a real one of its own. */
function linkEntry(target: string, link: string, name: string): boolean {
  let stats;
  try { stats = lstatSync(link); } catch { stats = null; }
  if (stats?.isSymbolicLink()) {
    try { if (realpathSync(link) === realpathSync(target)) return true; } catch {}
    unlinkSync(link);
  } else if (stats) {
    // Earlier turns kept their own files here: never delete them, keep using them.
    if (!givesWay(link, name)) return false;
    rmSync(link, { recursive: true, force: true });
  }
  const folder = statSync(target).isDirectory();
  try {
    symlinkSync(target, link, process.platform === "win32" ? (folder ? "junction" : "file") : undefined);
  } catch (error) {
    // Another turn of the same instance linked it first.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return true;
}

/** Whose login a MausBot home uses: its own (a ChatGPT plan's) or the person's, linked in. */
export type CodexHomeLogin = "own" | "person";

/** Makes MausBot's Codex home and links the person's own Codex home into it. Linking never fails the turn: an entry
 * that cannot be linked (a file link Windows refuses without Developer Mode) stays as the home had it. True when the
 * home has the login it should: its own, or the person's (none when they have none). */
export function linkSharedCodexHome(sharedHome: string | null, mausHome: string, login: CodexHomeLogin = "own"): boolean {
  mkdirSync(mausHome, { recursive: true, mode: 0o700 });
  if (!isAbsolute(mausHome)) return false;
  const own = resolve(mausHome);
  const apart = (name: string) => CHATS.has(name) || DATABASE.test(name) || (login === "own" && PRIVATE.has(name));
  // A link from before chats were kept apart goes, even when sharing fails below, so no new chat is written through it;
  // the person's own files behind it stay as they are.
  for (const name of readdirSync(own)) {
    const path = join(own, name);
    if (apart(name)) try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path); } catch {}
  }
  if (!sharedHome || !isAbsolute(sharedHome)) return false;
  const shared = resolve(sharedHome);
  if (inside(shared, own) || inside(own, shared)) return false;
  let names: string[];
  try {
    for (const name of SHARED_FOLDERS) mkdirSync(join(shared, name), { recursive: true, mode: 0o700 });
    names = readdirSync(shared);
  } catch (error) {
    note(shared, `could not share your Codex home with MausBot's: ${(error as Error).message}`);
    return false;
  }
  const kept: string[] = [];
  for (const name of new Set([...SHARED_FOLDERS, ...names])) {
    if (apart(name) || LOCAL.has(name) || SQLITE_JOURNAL.test(name)) continue;
    try {
      if (!linkEntry(join(shared, name), join(own, name), name)) kept.push(name);
    } catch (error) {
      note(join(own, name), `could not link ${JSON.stringify(name)} of your Codex home into MausBot's: ${(error as Error).message}`);
    }
  }
  if (kept.length) note(own, `MausBot's Codex home keeps its own ${kept.join(", ")} from earlier turns; the rest of your Codex home is shared`);
  return login === "own" || personLogin(shared, own);
}

/** The home reads the person's login file itself, or, like the person's home, has none. */
function personLogin(shared: string, own: string): boolean {
  const real = (home: string) => { try { return realpathSync(join(home, "auth.json")); } catch { return null; } };
  const person = real(shared);
  if (person) return real(own) === person;
  try { return lstatSync(join(own, "auth.json")).isSymbolicLink(); } catch { return true; }
}

/** System-wide Codex settings an administrator can use to choose where logins are kept (codex-cli 0.167.2). */
const MANAGED_CODEX_CONFIGS = process.platform === "win32" ? [] : ["/etc/codex/managed_config.toml", "/etc/codex/requirements.toml"];

/** `cli_auth_credentials_store = "keyring"` or `"auto"`: Codex may keep the login in the system keyring under a name made
 * from the home's path, which another home cannot reach, and a refresh there could leave the person's own copy stale.
 * Any system-wide setting about the login store counts too: it can choose the keyring without the home saying so. */
function keyringLogin(home: string, managedConfigs: readonly string[]): boolean {
  const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
  if (managedConfigs.some(path => read(path).includes("credentials_store"))) return true;
  const topLevel = read(join(home, "config.toml")).split(/^\s*\[/m)[0] ?? "";
  return /^\s*cli_auth_credentials_store\s*=\s*["'](?:keyring|auto)["']/m.test(topLevel);
}

/** A turn on the person's own Codex sign-in runs in MausBot's Codex home for this instance, so its chats stay out of their
 * Codex and ChatGPT apps. It keeps their home when that is MausBot's already (a Team Cloud's engine homes, anything in
 * the data folder), when their home has no login file or their login may be in the keyring, or when their login cannot
 * be linked or MausBot's home cannot be made: the turn still runs. */
export function keepChatsOutOfCodexHistory(env: Record<string, string | undefined>, instanceId: string, dataDir = DATA_DIR,
  teamCloud = engineHomes.active(), managedConfigs: readonly string[] = MANAGED_CODEX_CONFIGS): void {
  const person = codexHome(env);
  if (!person || teamCloud || inside(resolve(dataDir), person) || !existsSync(join(person, "auth.json")) || keyringLogin(person, managedConfigs)) return;
  const home = join(resolve(dataDir), "providers", "codex-own", createHash("sha256").update(instanceId).digest("hex"), "codex");
  try {
    if (!linkSharedCodexHome(person, home, "person")) return;
  } catch (error) {
    note(home, `could not make MausBot's Codex home, so this turn uses yours: ${(error as Error).message}`);
    return;
  }
  env.CODEX_HOME = home;
  // Codex keeps its databases here too unless config.toml names another folder.
  env.CODEX_SQLITE_HOME = home;
}
