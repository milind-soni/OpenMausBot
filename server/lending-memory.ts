// Known open risks: a foreign write racing trustedWrite in the same moment cannot be told apart, and a
// guest-driven shell can still write after the pending window or edit this record (Full access owns the machine).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const WORKING_FOLDER_FILES = [".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/CLAUDE.md"] as const;
export const WORKING_FOLDER_DIRS = [".claude/skills", ".claude/agents", ".claude/commands", ".agents/skills", ".grok/skills"] as const;
const WORKING_FOLDER_TOP = new Map<string, string[]>();
for (const path of [...WORKING_FOLDER_FILES, ...WORKING_FOLDER_DIRS]) {
  const [top, inner] = path.split("/") as [string, string?];
  WORKING_FOLDER_TOP.set(top, [...WORKING_FOLDER_TOP.get(top) ?? [], ...(inner ? [inner] : [])]);
}
/** Read from the working folder and every folder above it (Claude Code's project memory; Codex's AGENTS.md). */
export const ANCESTOR_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md"] as const;
export const FOLDER_ENTRY_CAP = 200;
const ROOT_ENTRY_CAP = 5_000;

/** Cached by identity, size and ctime, which no process can set back. */
const contentCache = new Map<string, { key: string; hash: string }>();
function describe(file: string): string | undefined {
  let stat;
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

/** Adding, removing or renaming an entry moves a folder's mtime and ctime; editing a file in place does not. */
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

/** The skills the harness itself links into a bot's folders, each with where its link points. A bot's turn can't write this
 * record, so a link matching it exactly is the harness's: it says nothing a bot chose, wherever and whenever it appears. */
export interface HarnessSkillLinks {
  /** The bot's own enabled skills. Their folders are the bot's to write, so each one's SKILL.md counts, once. */
  own: ReadonlyMap<string, string>;
  /** Skills brought from the person's computer, kept where no bot's turn can write. */
  imported: ReadonlyMap<string, string>;
}

export function memoryFiles(workspace: string, workingFolders: readonly string[] = [], alsoAbove: readonly string[] = [], skillLinks?: HarnessSkillLinks): Record<string, string> {
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
  const present = (dir: string, wanted: readonly string[], listed = listing(dir, ROOT_ENTRY_CAP)) =>
    listed ? wanted.filter((name) => listed.overflow || listed.names.has(name)) : [];
  const harnessLink = (entry: string, path: string) =>
    [skillLinks?.own.get(entry), skillLinks?.imported.get(entry)].some((target) => target !== undefined && describe(path) === `link:${target}`);
  const capped = (dir: string) => {
    const listed = listing(dir, FOLDER_ENTRY_CAP + (skillLinks ? skillLinks.own.size + skillLinks.imported.size : 0), true);
    if (!listed || listed.link) add(dir, dir);
    if (!listed) return;
    if (listed.overflow) { files[dir] = `overflow:${fullFolder(dir)}`; return; }
    for (const entry of [...listed.names].sort()) {
      // The harness never links through a skills folder that is itself a link.
      if (!listed.link && harnessLink(entry, join(dir, entry))) continue;
      add(join(dir, entry), join(dir, entry));
      add(join(dir, entry, "SKILL.md"), join(dir, entry, "SKILL.md"));
    }
  };
  const listedRoots = new Map<string, Listing>();
  const ancestors = new Set<string>();
  for (const folder of new Set([workspace, ...workingFolders].map((dir) => resolve(dir)))) {
    const top = listing(folder, ROOT_ENTRY_CAP, true);
    if (top) {
      listedRoots.set(folder, top);
      for (const name of present(folder, [...WORKING_FOLDER_TOP.keys()], top)) {
        const path = join(folder, name);
        const wanted = WORKING_FOLDER_TOP.get(name)!;
        if (!wanted.length) { add(path, path); continue; }
        const inner = listing(path, ROOT_ENTRY_CAP);
        if (!inner) add(path, path);
        if (!inner && !isLink(path)) continue;
        for (const entry of inner ? present(path, wanted, inner) : wanted) {
          if ((WORKING_FOLDER_DIRS as readonly string[]).includes(`${name}/${entry}`)) capped(join(path, entry));
          else add(join(path, entry), join(path, entry));
        }
      }
    }
    for (let dir = folder; !ancestors.has(dir); dir = dirname(dir)) {
      ancestors.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
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
  for (const folder of ["memory", "memory/log"]) if (files[folder]?.startsWith("other:")) delete files[folder];
  // Named as the link in the bot's own folder would name it, so a record from before these links stopped counting still
  // matches; under a name of its own if something else stands there, so neither hides the other.
  for (const [name, target] of skillLinks?.own ?? []) {
    const named = join(resolve(workspace), ".claude", "skills", name, "SKILL.md");
    add(files[named] === undefined ? named : `${named}, the skill`, join(target, "SKILL.md"));
  }
  return files;
}

export interface LendingBot {
  id: string;
  cwd?: string | null;
  tasks: readonly { threadId: string; cwd?: string | null }[];
}

export function botMemoryFiles(bot: LendingBot | undefined, dirs: { workspace: (botId: string) => string; taskWorkspaces: string; skillLinks?: (botId: string) => HarnessSkillLinks }): Record<string, string> {
  if (!bot) return {};
  const folders = bot.tasks.flatMap((task) => typeof task.cwd === "string" ? [task.cwd] : []);
  return memoryFiles(dirs.workspace(bot.id), [...new Set([...(bot.cwd ? [bot.cwd] : []), ...folders])], [join(dirs.taskWorkspaces, bot.id)], dirs.skillLinks?.(bot.id));
}

export function fingerprintOf(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) hash.update(`${name}\u0000${files[name]}\u0000`);
  return hash.digest("hex");
}

function digests(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, described]) => [name, createHash("sha256").update(described).digest("hex").slice(0, 24)]));
}

/** A skill in a bot's own or a conversation's folder. Its going away plants nothing: the harness takes back a link it no
 * longer wants this way, a thread's folder goes with the thread, and older records list the harness's own links. */
const FOLDER_SKILL = /[\\/](?:workspaces[\\/][^\\/]+|task-workspaces[\\/][^\\/]+[\\/][^\\/]+)[\\/]\.(?:claude|agents|grok)[\\/]skills[\\/][^\\/]+(?:[\\/]SKILL\.md)?$/;

export function changedFiles(before: Record<string, string> | undefined, after: Record<string, string>): string[] {
  if (!before) return Object.keys(after).sort();
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name] && !(after[name] === undefined && FOLDER_SKILL.test(name))).sort();
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
  unknownFlagged: z.union([z.literal(true), z.array(z.string().max(128)).max(100_000)]).optional(),
}).strict();
type Record_ = z.infer<typeof record>;

export interface LendingMemoryDeps {
  file: string;
  files: (botId: string) => Record<string, string>;
  knownBots: () => readonly string[];
  log?: (line: string) => void;
}

export function createLendingMemory({ file, files: snapshot, knownBots, log = () => {} }: LendingMemoryDeps) {
  let bots: { [botId: string]: Record_ } = {};
  // Fail closed: a damaged, linked or oversized record flags every bot that existed when it was found.
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
      try { save(); } catch {}
    }
  };
  const save = () => writeFileAtomic(file, JSON.stringify({ version: 1, bots, ...(unknownFlagged.size ? { unknownFlagged: [...unknownFlagged] } : {}) }), { mode: 0o600 });
  const set = (botId: string, next: Record_) => {
    const before = JSON.stringify(bots[botId] ?? null);
    bots = { ...bots, [botId]: next };
    const known = unknownFlagged.delete(botId);
    if (known || JSON.stringify(next) !== before) save();
  };
  const memo = new Map<string, { files: Record<string, string>; hash: string }>();
  const fresh = (botId: string) => {
    const files = snapshot(botId);
    const snap = { files: digests(files), hash: fingerprintOf(files) };
    if (!memo.size) setImmediate(() => memo.clear());
    memo.set(botId, snap);
    return snap;
  };
  const now = (botId: string, cached = false) => (cached && memo.get(botId)) || fresh(botId);
  const first = (botId: string, current: { files: Record<string, string>; hash: string }, pending: boolean): Record_ =>
    ({ trusted: current.hash, files: current.files, ...(unknownFlagged.has(botId) ? { flagged: true as const } : {}), ...(pending ? { pending: true as const } : {}) });
  const needs = (botId: string) => bots[botId]?.flagged === true || (!bots[botId] && unknownFlagged.has(botId));
  /** What was trusted is still what's there, whichever way either side was fingerprinted. */
  const unchanged = (current: Record_, snap: { files: Record<string, string>; hash: string }) =>
    snap.hash === current.trusted || (current.files !== undefined && changedFiles(current.files, snap.files).length === 0);
  return {
    noteForeignTurn(botId: string) {
      load();
      const current = bots[botId];
      if (!current) { set(botId, first(botId, now(botId), true)); return; }
      if (current.flagged || current.pending) { if (!current.pending) set(botId, { ...current, pending: true }); return; }
      const snap = now(botId);
      set(botId, { trusted: snap.hash, files: snap.files, pending: true });
    },
    reconcile(botId: string, foreignRunning: boolean, opts: { cached?: boolean } = {}): { changedBySomeoneElse: boolean } {
      load();
      const current = bots[botId];
      // Clearing "pending" ends a judgement: never on a reused snapshot.
      const snap = now(botId, opts.cached === true && !(current?.pending && !foreignRunning));
      if (!current) { const created = first(botId, snap, foreignRunning); set(botId, created); return { changedBySomeoneElse: created.flagged === true }; }
      if (current.flagged) return { changedBySomeoneElse: true };
      if (current.pending && !unchanged(current, snap)) {
        log(`lending: memory of bot ${botId} changed while a conversation the owner did not write was running; its turns cannot use the lent Mac until the owner reviews it`);
        set(botId, { ...current, flagged: true });
        return { changedBySomeoneElse: true };
      }
      if (snap.hash !== current.trusted || (current.pending && !foreignRunning)) {
        set(botId, { trusted: snap.hash, files: snap.files, ...(current.pending && foreignRunning ? { pending: true as const } : {}) });
      }
      return { changedBySomeoneElse: false };
    },
    reviewInfo(botId: string): { needed: boolean; token: string; changed: string[] } {
      load();
      const snap = now(botId, true);
      return { needed: needs(botId), token: snap.hash, changed: changedFiles(bots[botId]?.files, snap.files) };
    },
    needsReview(botId: string): boolean { load(); return needs(botId); },
    review(botId: string, foreignRunning: boolean, token: string): { ok: boolean } {
      load();
      const snap = now(botId);
      if (token !== snap.hash) return { ok: false };
      set(botId, { trusted: snap.hash, files: snap.files, ...(foreignRunning ? { pending: true as const } : {}) });
      return { ok: true };
    },
    trustedWrite<T>(botId: string, write: () => T): T {
      load();
      const current = bots[botId];
      const before = now(botId);
      const result = write();
      const after = now(botId);
      if (!current) set(botId, first(botId, after, false));
      else if (!current.flagged && unchanged(current, before)) set(botId, { ...current, trusted: after.hash, files: after.files });
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
