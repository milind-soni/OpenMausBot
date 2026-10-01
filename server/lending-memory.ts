// A bot's memory on an OMB Cloud home, as far as a lent Mac is concerned
// (docs/cloud-pro.md, "Let my Cloud use this Mac").
//
// MEMORY.md is loaded into every turn of a bot, its topic files and daily
// log feed recall, and the instruction files in its working folders
// (CLAUDE.md, AGENTS.md, .mcp.json, .claude/settings.json, skills) are read
// by its engine on every turn, the owner's lending turns among them. So a line put
// there by a conversation the owner did not write (a guest's chat, a room, a
// webhook run) would steer a turn that can reach the Mac. The harness's own
// memory writers already refuse such conversations (server/index.ts); this
// catches everything else, a bot writing the files with its own tools
// included:
//
// - while a turn that is not provably the owner's runs for a bot, that bot's
//   memory is "pending" (whatever the owner changed before it is adopted
//   first);
// - when the files change while pending, the memory is "changed by someone
//   else" and the bot's turns cannot use the Mac until the owner reviews it
//   in the Memory panel: one click, bound to the exact files they were
//   shown;
// - any other change (the owner's own turns, the owner's Memory edits,
//   upkeep and tidy) is adopted as the owner's;
// - a write the harness makes for the owner (trustedWrite) is adopted even
//   while such a turn runs, as long as nothing else changed the memory first.
//   A foreign write racing it within the same moment is the one case this
//   cannot tell apart.
//
// A change is judged by each file's type and content, a link by its target.
// It cannot stop a shell a guest directs from writing later (after the
// pending window), or from editing this record: a guest who can drive a
// Full-access bot on the Cloud already controls the machine.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

/** Instruction files an engine reads from its working folder. */
export const WORKING_FOLDER_FILES = [".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/CLAUDE.md"] as const;
/** Folders of skills, agents and commands an engine discovers in its working
 * folder: each entry, and a skill's SKILL.md. */
export const WORKING_FOLDER_DIRS = [".claude/skills", ".claude/agents", ".claude/commands", ".agents/skills"] as const;
/** Instruction files an engine reads from its working folder and every
 * folder above it (Claude Code's project memory; Codex's AGENTS.md). */
export const ANCESTOR_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md"] as const;
/** At most this many entries of one skills, agents or commands folder are
 * read. A fuller folder is judged as a whole: any entry added, removed or
 * renamed in it is a change (see `listing`), and so is any edit to an entry
 * or its SKILL.md (by identity, size and times: see `fullFolder`). */
export const FOLDER_ENTRY_CAP = 200;
/** A working folder with more top-level entries than this is not listed;
 * its instruction files are looked up by name instead. */
const ROOT_ENTRY_CAP = 5_000;

/** What one path is, for the fingerprint: absent (undefined), a link (by
 * target), a regular file (by content), or something else (by type). Cached
 * by identity, size and change time (which no process can set back), so
 * unchanged logs are not reread. */
const contentCache = new Map<string, { key: string; hash: string }>();
function describe(file: string): string | undefined {
  let stat;
  // No exception for the usual case, an absent file: it costs more than the look-up.
  try { stat = lstatSync(file, { bigint: true, throwIfNoEntry: false }); } catch { return undefined; }
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    try { return `link:${readlinkSync(file)}`; } catch { return "link:"; }
  }
  if (!stat.isFile()) return `other:${stat.mode}`;
  const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const cached = contentCache.get(file);
  if (cached?.key === key) return cached.hash;
  let hash: string;
  try { hash = `file:${createHash("sha256").update(readFileSync(file)).digest("hex")}`; } catch { hash = "file:unreadable"; }
  if (contentCache.size > 50_000) contentCache.clear();
  contentCache.set(file, { key, hash });
  return hash;
}

/** A folder's entry names, read at most once per change of the folder
 * itself: adding, removing or renaming an entry moves its modification and
 * change times (a file edited in place does not, which is why each file is
 * still looked at by `describe`). At most `cap` names are read; `overflow`
 * says there were more, and `key` changes whenever the entries do. A folder
 * that could not be read is not remembered, and reads as too full to list
 * (its files are then looked up by name).
 * undefined: not a folder (absent, never created, a file or a link). With
 * `through`, a link to a folder is listed as the folder it resolves to, and
 * `link` says so. */
type Listing = { key: string; names: ReadonlySet<string>; overflow: boolean; link?: true };
const listingCache = new Map<string, Listing>();
function listing(dir: string, cap: number, through = false): Listing | undefined {
  let stat;
  try { stat = lstatSync(dir, { bigint: true, throwIfNoEntry: false }); } catch { return undefined; }
  if (through && stat?.isSymbolicLink()) {
    let real: string;
    try { real = realpathSync(dir); } catch { return undefined; }
    const target = listing(real, cap);
    return target && { ...target, link: true };
  }
  if (!stat?.isDirectory()) return undefined;
  const key = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const cacheKey = `${cap}\u0000${dir}`;
  const cached = listingCache.get(cacheKey);
  if (cached?.key === key) return cached;
  const names = new Set<string>();
  let overflow = false;
  try {
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (names.size >= cap) { overflow = true; break; }
        names.add(entry.name);
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return { key: `${key}:unreadable`, names: new Set(), overflow: true };
  }
  const listed = { key, names, overflow };
  if (listingCache.size > 50_000) listingCache.clear();
  listingCache.set(cacheKey, listed);
  return listed;
}

function isLink(path: string): boolean {
  try { return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true; } catch { return false; }
}

/** A folder too full to list entry by entry (FOLDER_ENTRY_CAP), as one
 * value: its entries, and the identity, size and times of each entry and its
 * SKILL.md, so an edit in place is a change too. Nothing is read. */
function fullFolder(dir: string): string {
  const all = listing(dir, Infinity, true);
  if (!all) return "absent";
  const hash = createHash("sha256").update(all.key);
  const stamp = (file: string) => {
    let stat;
    try { stat = lstatSync(file, { bigint: true, throwIfNoEntry: false }); } catch { return "!"; }
    return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "-";
  };
  for (const name of [...all.names].sort()) hash.update(`${name}\u0000${stamp(join(dir, name))}\u0000${stamp(join(dir, name, "SKILL.md"))}\n`);
  return hash.digest("hex");
}

/** Every file that shapes a bot's turns, by name, as `describe` sees it:
 * MEMORY.md, memory/*, memory/log/*, and the instruction files in each
 * working folder and the folders above it. Only names that exist are looked
 * at, a folder that was never created costs one failed look-up, and each
 * folder is listed once per change of its entries. */
export function memoryFiles(workspace: string, workingFolders: readonly string[] = [], alsoAbove: readonly string[] = []): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (name: string, file: string) => {
    const described = describe(file);
    if (described !== undefined) files[name] = described;
  };
  add("MEMORY.md", join(workspace, "MEMORY.md"));
  add("memory", join(workspace, "memory"));
  for (const name of [...listing(join(workspace, "memory"), Infinity)?.names ?? []].sort()) if (name !== "log") add(`memory/${name}`, join(workspace, "memory", name));
  add("memory/log", join(workspace, "memory", "log"));
  for (const name of [...listing(join(workspace, "memory", "log"), Infinity)?.names ?? []].sort()) add(`memory/log/${name}`, join(workspace, "memory", "log", name));
  /** The names among `wanted` present in `dir` (all of them, unlisted, when
   * the folder is too full to list). */
  const present = (dir: string, wanted: readonly string[], listed = listing(dir, ROOT_ENTRY_CAP)) =>
    listed ? wanted.filter((name) => listed.overflow || listed.names.has(name)) : [];
  /** A skills, agents or commands folder (or a link to one: its target is
   * recorded too, and its entries are read through it). */
  const capped = (dir: string) => {
    const listed = listing(dir, FOLDER_ENTRY_CAP, true);
    if (!listed || listed.link) add(dir, dir);
    if (!listed) return;
    if (listed.overflow) { files[dir] = `overflow:${fullFolder(dir)}`; return; }
    for (const entry of [...listed.names].sort()) {
      add(join(dir, entry), join(dir, entry));
      add(join(dir, entry, "SKILL.md"), join(dir, entry, "SKILL.md"));
    }
  };
  const listedRoots = new Map<string, Listing>();
  const ancestors = new Set<string>();
  for (const folder of new Set([workspace, ...workingFolders].map((dir) => resolve(dir)))) {
    // A working folder that is a link is read through it.
    const top = listing(folder, ROOT_ENTRY_CAP, true);
    if (top) {
      listedRoots.set(folder, top);
      for (const name of present(folder, [".mcp.json", ".claude", ".agents"], top)) {
        const path = join(folder, name);
        if (name === ".mcp.json") { add(path, path); continue; }
        // A link (or a file) in place of the folder is judged by what it
        // is, and a link's files by name through it.
        const inner = listing(path, ROOT_ENTRY_CAP);
        if (!inner) add(path, path);
        if (!inner && !isLink(path)) continue;
        const wanted = name === ".claude" ? ["settings.json", "settings.local.json", "CLAUDE.md", "skills", "agents", "commands"] : ["skills"];
        for (const entry of inner ? present(path, wanted, inner) : wanted) {
          if (entry === "skills" || entry === "agents" || entry === "commands") capped(join(path, entry));
          else add(join(path, entry), join(path, entry));
        }
      }
    }
    // Up to the first folder already walked: its parents are there too.
    for (let dir = folder; !ancestors.has(dir); dir = dirname(dir)) {
      ancestors.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
  // Folders a conversation will work below once it runs (`alsoAbove`): the
  // instruction files there and above reach its first turn.
  for (const folder of alsoAbove) {
    for (let dir = resolve(folder); !ancestors.has(dir); dir = dirname(dir)) {
      ancestors.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
  for (const dir of ancestors) {
    const top = listedRoots.get(dir);
    for (const name of top ? present(dir, ANCESTOR_FILES, top) : ANCESTOR_FILES) add(join(dir, name), join(dir, name));
  }
  // "memory" and "memory/log" name the folders themselves: only a link
  // swapped in for one counts.
  for (const folder of ["memory", "memory/log"]) if (files[folder]?.startsWith("other:")) delete files[folder];
  return files;
}

/** A bot as the tracker sees it: each conversation's folder is the one its
 * turns use (store.ts pinTaskCwd), pinned when it first runs: before that
 * it has none (the bot's folder, else a task folder not yet created). */
export interface LendingBot {
  id: string;
  cwd?: string | null;
  tasks: readonly { threadId: string; cwd?: string | null }[];
}

/** memoryFiles for one bot: its workspace, its own folder, the folder of
 * every conversation that has run, and the folders above the task folders
 * of those that have not yet. A conversation that never ran has no folder
 * to look in (its first turn creates it). A bot that no longer exists has
 * nothing left to judge, and its workspace must not be recreated to look. */
export function botMemoryFiles(bot: LendingBot | undefined, dirs: { workspace: (botId: string) => string; taskWorkspaces: string }): Record<string, string> {
  if (!bot) return {};
  const folders = bot.tasks.flatMap((task) => typeof task.cwd === "string" ? [task.cwd] : []);
  return memoryFiles(dirs.workspace(bot.id), [...new Set([...(bot.cwd ? [bot.cwd] : []), ...folders])], [join(dirs.taskWorkspaces, bot.id)]);
}

/** One hash over a set of files, for the stored record and the review token. */
export function fingerprintOf(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) hash.update(`${name}\u0000${files[name]}\u0000`);
  return hash.digest("hex");
}

/** Back-compat for callers that only need the hash of one workspace. */
export function memoryFingerprint(workspace: string, workingFolders: readonly string[] = []): string {
  return fingerprintOf(memoryFiles(workspace, workingFolders));
}

/** What the record keeps of each file: enough to say which ones changed. */
function digests(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, described]) => [name, createHash("sha256").update(described).digest("hex").slice(0, 24)]));
}

/** The files that differ between two snapshots (as digests). */
export function changedFiles(before: Record<string, string> | undefined, after: Record<string, string>): string[] {
  if (!before) return Object.keys(after).sort();
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]).sort();
}

const record = z.object({
  trusted: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.record(z.string().max(4096), z.string().regex(/^[a-f0-9]{24}$/)).optional(),
  flagged: z.literal(true).optional(),
  pending: z.literal(true).optional(),
}).strict();
const recordsFile = z.object({
  version: z.literal(1),
  bots: z.record(z.string().max(128), record),
  /** The record could not be read once: the bots that existed then (and
   * have no record since) are flagged. `true` is every bot there is. */
  unknownFlagged: z.union([z.literal(true), z.array(z.string().max(128)).max(100_000)]).optional(),
}).strict();
type Record_ = z.infer<typeof record>;

export interface LendingMemoryDeps {
  file: string;
  /** The bot's files now (memoryFiles). */
  files: (botId: string) => Record<string, string>;
  /** The bots that exist now: the ones a lost record leaves flagged. */
  knownBots: () => readonly string[];
  log?: (line: string) => void;
}

export function createLendingMemory({ file, files: snapshot, knownBots, log = () => {} }: LendingMemoryDeps) {
  let bots: { [botId: string]: Record_ } = {};
  // Fail closed: a damaged, linked or oversized record would otherwise wipe
  // every flag. Every bot that existed when it was found damaged starts
  // flagged instead; a bot created later starts clean.
  let unknownFlagged = new Set<string>();
  // Read on first use, when the fleet it may need to name exists.
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!existsSync(file)) return;
    let damaged = false;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_000_000) throw new Error("unsafe record");
      const parsed = recordsFile.parse(JSON.parse(readFileSync(file, "utf8")));
      bots = parsed.bots;
      if (parsed.unknownFlagged === true) damaged = true;
      else unknownFlagged = new Set(parsed.unknownFlagged ?? []);
    } catch {
      bots = {};
      damaged = true;
    }
    if (damaged) {
      unknownFlagged = new Set(knownBots().filter((botId) => !bots[botId]));
      log("lending: the record of bots' memory could not be read; every bot's memory needs the owner's review before it can use the lent Mac");
      try { save(); } catch { /* flagged in memory for this run; the damaged file says so again next time */ }
    }
  };
  const save = () => writeFileAtomic(file, JSON.stringify({ version: 1, bots, ...(unknownFlagged.size ? { unknownFlagged: [...unknownFlagged] } : {}) }), { mode: 0o600 });
  const set = (botId: string, next: Record_) => {
    const before = JSON.stringify(bots[botId] ?? null);
    bots = { ...bots, [botId]: next };
    const known = unknownFlagged.delete(botId);
    if (known || JSON.stringify(next) !== before) save();
  };
  // A snapshot taken this tick is reused for the rest of it by checks that
  // only look (a Mac action, the Memory panel). Anything that starts or ends
  // a judgement (a foreign turn starting or ending, a review, a write for the
  // owner) takes a fresh one.
  const memo = new Map<string, { files: Record<string, string>; hash: string }>();
  const fresh = (botId: string) => {
    const files = snapshot(botId);
    const snap = { files: digests(files), hash: fingerprintOf(files) };
    if (!memo.size) setImmediate(() => memo.clear());
    memo.set(botId, snap);
    return snap;
  };
  const now = (botId: string, cached = false) => (cached && memo.get(botId)) || fresh(botId);
  /** A bot seen for the first time: trusted as it is, unless the record was lost. */
  const first = (botId: string, current: { files: Record<string, string>; hash: string }, pending: boolean): Record_ =>
    ({ trusted: current.hash, files: current.files, ...(unknownFlagged.has(botId) ? { flagged: true as const } : {}), ...(pending ? { pending: true as const } : {}) });
  const needs = (botId: string) => bots[botId]?.flagged === true || (!bots[botId] && unknownFlagged.has(botId));
  return {
    /** A turn that is not provably the owner's starts for this bot. What the
     * owner changed before it is adopted first; from here on, changes are
     * judged as someone else's. */
    noteForeignTurn(botId: string) {
      load();
      const current = bots[botId];
      if (!current) { set(botId, first(botId, now(botId), true)); return; }
      if (current.flagged || current.pending) { if (!current.pending) set(botId, { ...current, pending: true }); return; }
      const snap = now(botId);
      set(botId, { trusted: snap.hash, files: snap.files, pending: true });
    },
    /** Judge the files now. `foreignRunning`: such a turn still runs.
     * `cached`: a check that only looks may reuse this tick's snapshot. */
    reconcile(botId: string, foreignRunning: boolean, opts: { cached?: boolean } = {}): { changedBySomeoneElse: boolean } {
      load();
      const current = bots[botId];
      // Clearing "pending" ends a judgement: never on a reused snapshot.
      const snap = now(botId, opts.cached === true && !(current?.pending && !foreignRunning));
      if (!current) { const created = first(botId, snap, foreignRunning); set(botId, created); return { changedBySomeoneElse: created.flagged === true }; }
      if (current.flagged) return { changedBySomeoneElse: true };
      if (snap.hash !== current.trusted) {
        if (current.pending) {
          log(`lending: memory of bot ${botId} changed while a conversation the owner did not write was running; its turns cannot use the lent Mac until the owner reviews it`);
          set(botId, { ...current, flagged: true });
          return { changedBySomeoneElse: true };
        }
        set(botId, { trusted: snap.hash, files: snap.files });
        return { changedBySomeoneElse: false };
      }
      if (current.pending && !foreignRunning) set(botId, { trusted: current.trusted, ...(current.files ? { files: current.files } : {}) });
      return { changedBySomeoneElse: false };
    },
    /** What the owner reviews: whether it is needed, a token for exactly the
     * files as they are now, and which files differ from the last trusted
     * state. */
    reviewInfo(botId: string): { needed: boolean; token: string; changed: string[] } {
      load();
      const snap = now(botId, true);
      return { needed: needs(botId), token: snap.hash, changed: changedFiles(bots[botId]?.files, snap.files) };
    },
    /** Whether the owner has a change to review (no file access). */
    needsReview(botId: string): boolean { load(); return needs(botId); },
    /** The owner looked at the memory and accepts it exactly as it was shown
     * (`token`). A token that no longer matches the files is refused. */
    review(botId: string, foreignRunning: boolean, token: string): { ok: boolean } {
      load();
      const snap = now(botId);
      if (token !== snap.hash) return { ok: false };
      set(botId, { trusted: snap.hash, files: snap.files, ...(foreignRunning ? { pending: true as const } : {}) });
      return { ok: true };
    },
    /** A write the harness makes on the owner's behalf. Adopted as the
     * owner's when the memory was still exactly as trusted just before it;
     * otherwise left for reconcile to judge. */
    trustedWrite<T>(botId: string, write: () => T): T {
      load();
      const current = bots[botId];
      const before = now(botId).hash;
      const result = write();
      const after = now(botId);
      if (!current) set(botId, first(botId, after, false));
      else if (!current.flagged && before === current.trusted) set(botId, { ...current, trusted: after.hash, files: after.files });
      return result;
    },
    forget(botId: string) {
      load();
      memo.delete(botId);
      const known = unknownFlagged.delete(botId);
      if (bots[botId]) { const next = { ...bots }; delete next[botId]; bots = next; save(); } else if (known) save();
    },
  };
}
