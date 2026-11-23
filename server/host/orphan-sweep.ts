// Leftovers already on disk from conversations deleted before their cleanup existed: tool results
// (tool-results/<thread>), event logs (events/ and native/<thread>.ndjson) and the package installs of conversation
// folders (task-workspaces/<bot>/<thread>) whose conversation is gone. Behind OMB_ORPHAN_SWEEP, off unless set:
// "report" counts what it would remove and the bytes, and changes nothing; "remove" also removes it. A pass runs ten
// minutes after start and then once a day, and its numbers go to the log and to orphan-sweep.json.
//
// Conservative: anything not positively an orphan stays.
// - A conversation is gone only when neither the bots' and rooms' records nor the transcripts name it; if the
//   transcripts cannot be read, or no conversation is registered at all, nothing is done.
// - An orphan goes only once it is a week old by its own newest change, the sweep has known it for a week and has seen
//   it on seven different days, all in "remove" mode on this machine. What "report" saw does not count, and the notes
//   are dropped when they come from another machine (a copied disk) or from the future (a clock set back).
// - When more than a small share of all conversations on disk look orphaned (OMB_ORPHAN_SWEEP_MAX_SHARE percent, 10 by
//   default), the records are more likely unreadable than the conversations gone: the pass reports only, loudly.
// - No pass changes anything while the server is frozen after a move or a backup is being made or restored, checked
//   before each removal.
// - Each item is measured within its own budget; one past it is kept. A pass past its total budget stops, saves what
//   it saw, and the next pass carries on from there.
// The person's files in an orphaned conversation folder stay (the delete dialogs promise them; Files still shows them):
// only its package installs go, through the same checks as a delete (conversation-folder-cleanup.ts). Event logs go
// file by file after the same check again. Nothing follows a link.
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { gateResultsName, hookResultsName, liveThreadIds, type ConversationFolderCleanup, type LiveRecords } from "./conversation-folder-cleanup.ts";

export const ORPHAN_SWEEP_ENV = "OMB_ORPHAN_SWEEP";
export const ORPHAN_SWEEP_SHARE_ENV = "OMB_ORPHAN_SWEEP_MAX_SHARE";
export type OrphanSweepMode = "off" | "report" | "remove";
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const ORPHAN_PASS_DAYS = 7;
const DEFAULT_MAX_SHARE = 10;
const FIRST_PASS_MS = 10 * 60 * 1000;
const EVERY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = "orphan-sweep.json";
const ID = /^[\w-]{1,128}$/;
const PER_ITEM_ENTRIES = 250_000;
const PER_PASS_ENTRIES = 5_000_000;
const YIELD_EVERY = 256;
const PAUSE_EVERY = 4_096;
const PAUSE_MS = 20;

export function orphanSweepMode(env: NodeJS.ProcessEnv = process.env): OrphanSweepMode {
  const value = env[ORPHAN_SWEEP_ENV]?.trim().toLowerCase();
  if (value === "report" || value === "dry-run") return "report";
  if (value === "remove") return "remove";
  return "off";
}

/** The largest share of the conversations on disk, in percent, the sweep removes as orphans in one go. */
export function orphanSweepMaxShare(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[ORPHAN_SWEEP_SHARE_ENV]?.trim());
  return Number.isFinite(value) && value >= 0 && value <= 100 && env[ORPHAN_SWEEP_SHARE_ENV]?.trim() ? value : DEFAULT_MAX_SHARE;
}

export interface OrphanCount { count: number; bytes: number }
export interface OrphanReport {
  at: number;
  mode: OrphanSweepMode;
  /** Why nothing was looked at. */
  skipped?: string;
  /** Why nothing was removed although the mode is "remove". */
  held?: string;
  toolResults: OrphanCount;
  eventLogs: OrphanCount;
  /** Orphaned conversation folders: their installs (which go) and the person's files in them (which stay). */
  workspaces: { folders: number; rebuildableBytes: number; keptFileBytes: number };
  /** Conversations on disk, and how many of them look orphaned. */
  conversations: { onDisk: number; orphaned: number };
  /** Orphans not yet past their week and their seven days: counted above, removed by a later pass. */
  waiting: number;
  /** Items past their own budget, kept this pass. */
  tooLarge: number;
  /** The pass ran out of its budget; the next carries on. */
  partial: boolean;
  /** Whether a pass in "remove" mode handed the orphans over for removal. */
  removed: boolean;
}

export interface OrphanSweepDeps {
  dataDir: string;
  mode(): OrphanSweepMode;
  records(): LiveRecords;
  /** Why the workspace must not be changed now (frozen after a move, a backup being made or restored), else null. */
  paused?(): string | null;
  /** Every conversation the transcripts hold; rejects when they cannot be read. */
  storedThreadIds(): Promise<ReadonlySet<string>> | ReadonlySet<string>;
  cleanup: Pick<ConversationFolderCleanup, "orphans" | "whyKept" | "rebuildable" | "idle">;
  maxShare?(): number;
  limits?: { perItem?: number; perPass?: number };
  now?(): number;
  pause?(ms: number): Promise<void>;
  log?(line: string): void;
  warn?(line: string): void;
}

interface Seen { first: number; days: string[] }
interface State { environment: string; mode: OrphanSweepMode; seen: Record<string, Seen>; cursor?: string; last?: OrphanReport }

const empty = (at: number, mode: OrphanSweepMode, skipped?: string): OrphanReport => ({
  at, mode, ...(skipped ? { skipped } : {}), toolResults: { count: 0, bytes: 0 }, eventLogs: { count: 0, bytes: 0 },
  workspaces: { folders: 0, rebuildableBytes: 0, keptFileBytes: 0 }, conversations: { onDisk: 0, orphaned: 0 },
  waiting: 0, tooLarge: 0, partial: false, removed: false,
});
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export function describeOrphanReport(report: OrphanReport): string {
  if (report.skipped) return `orphan sweep (${report.mode}): skipped: ${report.skipped}`;
  return `orphan sweep (${report.mode}): conversations on disk ${report.conversations.onDisk}, orphaned ${report.conversations.orphaned}; ` +
    `tool results ${report.toolResults.count} folder(s) ${mb(report.toolResults.bytes)}; event logs ${report.eventLogs.count} file(s) ` +
    `${mb(report.eventLogs.bytes)}; conversation folders ${report.workspaces.folders}, installs ${mb(report.workspaces.rebuildableBytes)}, ` +
    `the person's files kept ${mb(report.workspaces.keptFileBytes)}; ${report.waiting} still waiting` +
    `${report.tooLarge ? `; ${report.tooLarge} too large to check` : ""}${report.partial ? "; stopped at its budget, the next pass carries on" : ""}` +
    `${report.held ? `; REMOVED NOTHING: ${report.held}` : report.removed ? "; the rest handed over for removal" : ""}`;
}

class OverBudget extends Error {}

export async function sweepOrphans(deps: OrphanSweepDeps): Promise<OrphanReport> {
  const dataDir = resolve(deps.dataDir);
  const now = (deps.now ?? Date.now)();
  const mode = deps.mode();
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const statePath = join(dataDir, STATE_FILE);
  const perItem = deps.limits?.perItem ?? PER_ITEM_ENTRIES, perPass = deps.limits?.perPass ?? PER_PASS_ENTRIES;
  let passSteps = 0;
  if (mode === "off") return empty(now, mode, "off");
  const paused = deps.paused?.() ?? null;
  if (paused) return empty(now, mode, paused);

  const records = deps.records();
  const registered = liveThreadIds(records);
  let stored: ReadonlySet<string>;
  try { stored = await deps.storedThreadIds(); } catch (error) {
    return empty(now, mode, `the transcripts could not be read: ${message(error)}`);
  }
  if (!registered.size) return empty(now, mode, "no conversation is registered");
  const live = new Set([...registered, ...stored]);
  const liveNames = new Set([...live].flatMap((id) => [hookResultsName(id), gateResultsName(id)]));
  const environment = (await readFile(join(dataDir, "environment-id"), "utf8").catch(() => "")).trim();

  // Notes from another machine, another mode or the future start over.
  let state: State = { environment, mode, seen: {} };
  try {
    const read = JSON.parse(await readFile(statePath, "utf8")) as Partial<State>;
    const fresh = read && read.environment === environment && read.mode === mode && !(typeof read.last?.at === "number" && read.last.at > now);
    if (fresh && read.seen && typeof read.seen === "object") state = { environment, mode, seen: { ...read.seen }, ...(typeof read.cursor === "string" ? { cursor: read.cursor } : {}) };
  } catch { /* none yet, or unreadable: every orphan starts its wait now */ }
  const report = empty(now, mode);
  const seen: Record<string, Seen> = {};
  const today = day(now);
  /** Whether an orphan is past its week, its seven days and its own week of quiet; notes this pass's sight of it. */
  const due = (key: string, newestMs: number) => {
    const before = state.seen[key];
    const first = before && Number.isFinite(before.first) ? Math.min(before.first, now) : now;
    const days = Array.isArray(before?.days) ? before.days.filter((one) => typeof one === "string" && one <= today) : [];
    if (days.at(-1) !== today) days.push(today);
    seen[key] = { first, days: days.slice(-ORPHAN_PASS_DAYS) };
    const ready = now - newestMs >= ORPHAN_GRACE_MS && now - first >= ORPHAN_GRACE_MS && seen[key]!.days.length >= ORPHAN_PASS_DAYS;
    if (!ready) report.waiting++;
    return ready;
  };
  const names = async (dir: string) => {
    try { return (await lstat(dir)).isDirectory() ? await readdir(dir) : []; } catch { return []; }
  };
  /** Bytes and newest change under `path`, never through a link, within one item's budget (null past it); `skip`
   * names subtrees counted elsewhere. */
  const measure = async (path: string, skip: ReadonlySet<string> = new Set()): Promise<{ bytes: number; newest: number } | null> => {
    const total = { bytes: 0, newest: 0 };
    let itemSteps = 0;
    const walk = async (at: string): Promise<boolean> => {
      if (++itemSteps > perItem) return false;
      if (++passSteps > perPass) throw new OverBudget();
      if (passSteps % PAUSE_EVERY === 0) await pause(PAUSE_MS);
      else if (passSteps % YIELD_EVERY === 0) await new Promise<void>((done) => setImmediate(done));
      const stats = await lstat(at).catch(() => null);
      if (!stats) return true;
      total.newest = Math.max(total.newest, stats.mtimeMs);
      if (!stats.isDirectory()) { total.bytes += stats.size; return true; }
      for (const name of await readdir(at).catch(() => [] as string[])) if (!skip.has(join(at, name)) && !await walk(join(at, name))) return false;
      return true;
    };
    return await walk(path) ? total : null;
  };

  // What is on disk, from listings alone: every conversation it holds something of, and which of those are orphans.
  type Item = { key: string; kind: "results" | "log" | "workspace"; path: string; id: string; name: string };
  const items: Item[] = [];
  const onDisk = new Set<string>(), orphaned = new Set<string>();
  for (const name of await names(join(dataDir, "tool-results"))) {
    if (!ID.test(name) || name === "thread") continue;
    onDisk.add(name);
    if (liveNames.has(name)) continue;
    orphaned.add(name);
    items.push({ key: `results:${name}`, kind: "results", path: join(dataDir, "tool-results", name), id: name, name });
  }
  for (const kind of ["events", "native"]) {
    for (const file of await names(join(dataDir, kind))) {
      const id = file.endsWith(".ndjson") ? file.slice(0, -".ndjson".length) : "";
      if (!ID.test(id)) continue;
      onDisk.add(id);
      if (live.has(id)) continue;
      orphaned.add(id);
      items.push({ key: `${kind}:${id}`, kind: "log", path: join(dataDir, kind, file), id, name: file });
    }
  }
  const tasksRoot = join(dataDir, "task-workspaces");
  for (const botId of await names(tasksRoot)) {
    if (!ID.test(botId)) continue;
    for (const threadId of await names(join(tasksRoot, botId))) {
      if (!ID.test(threadId)) continue;
      onDisk.add(threadId);
      if (live.has(threadId)) continue;
      orphaned.add(threadId);
      items.push({ key: `workspace:${botId}/${threadId}`, kind: "workspace", path: join(tasksRoot, botId, threadId), id: threadId, name: threadId });
    }
  }
  report.conversations = { onDisk: onDisk.size, orphaned: orphaned.size };
  // A pass that stopped at its budget left a cursor: this one starts there.
  const start = state.cursor ? Math.max(0, items.findIndex((item) => item.key === state.cursor)) : 0;
  const ordered = [...items.slice(start), ...items.slice(0, start)];

  const results: string[] = [], logs: Item[] = [], workspaces: string[] = [];
  let cursor: string | undefined;
  for (const item of ordered) {
    try {
      if (item.kind === "results") {
        if (!(await lstat(item.path).catch(() => null))?.isDirectory()) continue;
        const size = await measure(item.path);
        if (!size) { report.tooLarge++; continue; }
        report.toolResults.count++;
        report.toolResults.bytes += size.bytes;
        if (due(item.key, size.newest)) results.push(item.name);
      } else if (item.kind === "log") {
        const stats = await lstat(item.path).catch(() => null);
        if (!stats?.isFile()) continue;
        report.eventLogs.count++;
        report.eventLogs.bytes += stats.size;
        if (due(item.key, stats.mtimeMs)) logs.push(item);
      } else {
        if (deps.cleanup.whyKept(item.path)) continue;
        const trees = (await deps.cleanup.rebuildable(item.path)).map((tree) => tree.path);
        let treeBytes = 0, newest = 0, whole = true;
        for (const tree of trees) {
          const size = await measure(tree);
          if (!size) { whole = false; break; }
          treeBytes += size.bytes;
          newest = Math.max(newest, size.newest);
        }
        const rest = whole ? await measure(item.path, new Set(trees)) : null;
        if (!rest) { report.tooLarge++; continue; }
        report.workspaces.folders++;
        report.workspaces.rebuildableBytes += treeBytes;
        report.workspaces.keptFileBytes += rest.bytes;
        if (trees.length && due(item.key, Math.max(newest, rest.newest))) workspaces.push(item.path);
      }
    } catch (error) {
      if (!(error instanceof OverBudget)) throw error;
      report.partial = true;
      cursor = item.key;
      break;
    }
  }

  // Anything the pass did not reach keeps its notes; what is gone, or no longer an orphan, loses them.
  const listed = new Set(items.map((item) => item.key));
  for (const [key, value] of Object.entries(state.seen)) if (!(key in seen) && listed.has(key) && report.partial) seen[key] = value;

  const share = onDisk.size ? (orphaned.size / onDisk.size) * 100 : 0;
  const maxShare = (deps.maxShare ?? orphanSweepMaxShare)();
  if (mode === "remove") {
    const pausedNow = deps.paused?.() ?? null;
    if (pausedNow) report.held = pausedNow;
    else if (share > maxShare) {
      report.held = `${orphaned.size} of ${onDisk.size} conversations on disk look orphaned (${Math.round(share)}%, more than ${maxShare}%): the records may be unreadable; set ${ORPHAN_SWEEP_SHARE_ENV} after checking`;
      warn(`orphan sweep: ${report.held}`);
    } else {
      for (const item of logs) {
        // Checked again just before: a conversation may have come back meanwhile (a merge from another computer).
        if (deps.paused?.() || liveThreadIds(deps.records()).has(item.id)) continue;
        try {
          if ((await lstat(item.path)).isFile()) await unlink(item.path);
        } catch (error) {
          warn(`orphan sweep: kept ${item.path}: ${message(error)}`);
        }
      }
      deps.cleanup.orphans({ workspaces, results });
      await deps.cleanup.idle();
      report.removed = true;
    }
  }

  state = { environment, mode, seen, ...(cursor ? { cursor } : {}), last: report };
  try { writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); } catch (error) {
    warn(`orphan sweep: could not save its notes: ${message(error)}`);
  }
  return report;
}

/** The first pass ten minutes after start, then one a day; each reads the switch again, so it can be turned on or off
 * without a restart where the environment allows. */
export function startOrphanSweep(deps: OrphanSweepDeps & { firstPassMs?: number; everyMs?: number }): void {
  let running = false;
  const pass = () => {
    if (running || deps.mode() === "off") return;
    running = true;
    void sweepOrphans(deps)
      .then((report) => (deps.log ?? console.log)(describeOrphanReport(report)))
      .catch((error: unknown) => (deps.warn ?? console.warn)(`orphan sweep: stopped: ${message(error)}`))
      .finally(() => { running = false; });
  };
  setTimeout(pass, deps.firstPassMs ?? FIRST_PASS_MS).unref?.();
  setInterval(pass, deps.everyMs ?? EVERY_MS).unref?.();
}
