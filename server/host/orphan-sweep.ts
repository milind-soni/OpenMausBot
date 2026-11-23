// Leftovers already on disk from conversations deleted before their cleanup existed: tool results
// (tool-results/<thread>), event logs (events/ and native/<thread>.ndjson) and the installed dependencies of
// conversation folders (task-workspaces/<bot>/<thread>) whose conversation is gone. Behind OMB_ORPHAN_SWEEP, off unless
// set: "report" counts what it would remove and the bytes, and changes nothing; "remove" also removes it. A pass runs ten
// minutes after start and then once a day, and its numbers go to the log and to orphan-sweep.json.
//
// Conservative: anything not positively an orphan stays. A conversation is gone only when neither the bots' and rooms'
// records nor the transcripts name it; if either cannot be read, or no conversation is registered at all, nothing is
// done. An orphan goes only once it is a week old by its own time and the sweep has known it for a week, so files a
// restore or a merge brings before their records stay. No pass runs while the server is frozen after a move or a backup
// is being made or restored. The person's files in an orphaned conversation folder stay (the
// delete dialogs promise them; Files still shows them): only its node_modules and venvs go, through the same checks as a
// delete (conversation-folder-cleanup.ts). Event logs go file by file after the same check again; nothing follows a link.
import { lstat, readdir, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { gateResultsName, hookResultsName, liveThreadIds, type ConversationFolderCleanup, type LiveRecords } from "./conversation-folder-cleanup.ts";

export const ORPHAN_SWEEP_ENV = "OMB_ORPHAN_SWEEP";
export type OrphanSweepMode = "off" | "report" | "remove";
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_PASS_MS = 10 * 60 * 1000;
const EVERY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = "orphan-sweep.json";
const ID = /^[\w-]{1,128}$/;
const MAX_ENTRIES = 5_000_000;
const YIELD_EVERY = 256;
const PAUSE_EVERY = 4_096;
const PAUSE_MS = 20;

export function orphanSweepMode(env: NodeJS.ProcessEnv = process.env): OrphanSweepMode {
  const value = env[ORPHAN_SWEEP_ENV]?.trim().toLowerCase();
  if (value === "report" || value === "dry-run") return "report";
  if (value === "remove") return "remove";
  return "off";
}

export interface OrphanCount { count: number; bytes: number }
export interface OrphanReport {
  at: number;
  mode: OrphanSweepMode;
  /** Why nothing was looked at. */
  skipped?: string;
  toolResults: OrphanCount;
  eventLogs: OrphanCount;
  /** Orphaned conversation folders: their rebuildable trees (which go) and the person's files in them (which stay). */
  workspaces: { folders: number; rebuildableBytes: number; keptFileBytes: number };
  /** Orphans not yet a week old, or not yet known for a week: counted above, removed by a later pass. */
  waiting: number;
  /** Whether a pass in "remove" mode handed the orphans over for removal. */
  removed: boolean;
}

export interface OrphanSweepDeps {
  dataDir: string;
  mode(): OrphanSweepMode;
  records(): LiveRecords;
  /** Why the workspace must not be changed now (frozen after a move, a backup being made or restored), else null. */
  paused?(): string | null;
  /** Every conversation the transcripts hold; throws when they cannot be read. */
  storedThreadIds(): ReadonlySet<string>;
  cleanup: Pick<ConversationFolderCleanup, "orphans" | "whyKept" | "rebuildable" | "idle">;
  now?(): number;
  pause?(ms: number): Promise<void>;
  log?(line: string): void;
  warn?(line: string): void;
}

interface State { firstSeen: Record<string, number>; last?: OrphanReport }

const empty = (at: number, mode: OrphanSweepMode, skipped?: string): OrphanReport => ({
  at, mode, ...(skipped ? { skipped } : {}), toolResults: { count: 0, bytes: 0 }, eventLogs: { count: 0, bytes: 0 },
  workspaces: { folders: 0, rebuildableBytes: 0, keptFileBytes: 0 }, waiting: 0, removed: false,
});
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function describeOrphanReport(report: OrphanReport): string {
  if (report.skipped) return `orphan sweep (${report.mode}): skipped: ${report.skipped}`;
  return `orphan sweep (${report.mode}): tool results ${report.toolResults.count} folder(s) ${mb(report.toolResults.bytes)}; ` +
    `event logs ${report.eventLogs.count} file(s) ${mb(report.eventLogs.bytes)}; conversation folders ${report.workspaces.folders}, ` +
    `rebuildable trees ${mb(report.workspaces.rebuildableBytes)}, the person's files kept ${mb(report.workspaces.keptFileBytes)}; ` +
    `${report.waiting} still in their week${report.removed ? "; the rest handed over for removal" : ""}`;
}

export async function sweepOrphans(deps: OrphanSweepDeps): Promise<OrphanReport> {
  const dataDir = resolve(deps.dataDir);
  const now = (deps.now ?? Date.now)();
  const mode = deps.mode();
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const statePath = join(dataDir, STATE_FILE);
  let steps = 0;
  const step = async () => {
    steps++;
    if (steps > MAX_ENTRIES) throw new Error("too many entries for one pass");
    if (steps % PAUSE_EVERY === 0) await pause(PAUSE_MS);
    else if (steps % YIELD_EVERY === 0) await new Promise<void>((done) => setImmediate(done));
  };
  if (mode === "off") return empty(now, mode, "off");
  const paused = deps.paused?.() ?? null;
  if (paused) return empty(now, mode, paused);

  const records = deps.records();
  const registered = liveThreadIds(records);
  let stored: ReadonlySet<string>;
  try { stored = deps.storedThreadIds(); } catch (error) {
    return empty(now, mode, `the transcripts could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!registered.size) return empty(now, mode, "no conversation is registered");
  const live = new Set([...registered, ...stored]);
  const liveNames = new Set([...live].flatMap((id) => [hookResultsName(id), gateResultsName(id)]));

  let state: State = { firstSeen: {} };
  try {
    const read = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>;
    if (read && typeof read.firstSeen === "object" && read.firstSeen) state = { firstSeen: { ...read.firstSeen } };
  } catch { /* none yet, or unreadable: every orphan starts its week now */ }
  const seen: Record<string, number> = {};
  const report = empty(now, mode);
  /** Whether an orphan is past both weeks; records when the sweep first knew it. */
  const due = (key: string, newestMs: number) => {
    const first = Number.isFinite(state.firstSeen[key]) ? Math.min(state.firstSeen[key]!, now) : now;
    seen[key] = first;
    const ready = now - newestMs >= ORPHAN_GRACE_MS && now - first >= ORPHAN_GRACE_MS;
    if (!ready) report.waiting++;
    return ready;
  };
  const names = async (dir: string) => {
    try { return (await lstat(dir)).isDirectory() ? await readdir(dir) : []; } catch { return []; }
  };
  /** Bytes and newest change under `path`, never through a link; `skip` names subtrees counted elsewhere. */
  const measure = async (path: string, skip: ReadonlySet<string> = new Set()): Promise<{ bytes: number; newest: number }> => {
    const total = { bytes: 0, newest: 0 };
    const walk = async (at: string) => {
      await step();
      const stats = await lstat(at).catch(() => null);
      if (!stats) return;
      total.newest = Math.max(total.newest, stats.mtimeMs);
      if (!stats.isDirectory()) { total.bytes += stats.size; return; }
      for (const name of await readdir(at).catch(() => [] as string[])) if (!skip.has(join(at, name))) await walk(join(at, name));
    };
    await walk(path);
    return total;
  };

  const results: string[] = [];
  for (const name of await names(join(dataDir, "tool-results"))) {
    if (!ID.test(name) || name === "thread" || liveNames.has(name)) continue;
    const path = join(dataDir, "tool-results", name);
    if (!(await lstat(path).catch(() => null))?.isDirectory()) continue;
    const size = await measure(path);
    report.toolResults.count++;
    report.toolResults.bytes += size.bytes;
    if (due(`results:${name}`, size.newest)) results.push(name);
  }

  const logs: Array<{ path: string; id: string }> = [];
  for (const kind of ["events", "native"]) {
    for (const file of await names(join(dataDir, kind))) {
      const id = file.endsWith(".ndjson") ? file.slice(0, -".ndjson".length) : "";
      if (!ID.test(id) || live.has(id)) continue;
      const path = join(dataDir, kind, file);
      const stats = await lstat(path).catch(() => null);
      if (!stats?.isFile()) continue;
      await step();
      report.eventLogs.count++;
      report.eventLogs.bytes += stats.size;
      if (due(`${kind}:${id}`, stats.mtimeMs)) logs.push({ path, id });
    }
  }

  const workspaces: string[] = [];
  const tasksRoot = join(dataDir, "task-workspaces");
  for (const botId of await names(tasksRoot)) {
    if (!ID.test(botId)) continue;
    for (const threadId of await names(join(tasksRoot, botId))) {
      if (!ID.test(threadId) || live.has(threadId)) continue;
      const folder = join(tasksRoot, botId, threadId);
      if (deps.cleanup.whyKept(folder)) continue;
      const trees = await deps.cleanup.rebuildable(folder);
      let treeBytes = 0, newest = 0;
      for (const tree of trees) {
        const size = await measure(tree);
        treeBytes += size.bytes;
        newest = Math.max(newest, size.newest);
      }
      const rest = await measure(folder, new Set(trees));
      report.workspaces.folders++;
      report.workspaces.rebuildableBytes += treeBytes;
      report.workspaces.keptFileBytes += rest.bytes;
      if (trees.length && due(`workspace:${botId}/${threadId}`, Math.max(newest, rest.newest))) workspaces.push(folder);
    }
  }

  const pausedNow = deps.paused?.() ?? null;
  if (mode === "remove" && pausedNow) report.skipped = pausedNow;
  else if (mode === "remove") {
    for (const { path, id } of logs) {
      // Checked again just before: a conversation may have come back meanwhile (a merge from another computer).
      if (liveThreadIds(deps.records()).has(id)) continue;
      try {
        if ((await lstat(path)).isFile()) await unlink(path);
      } catch (error) {
        (deps.warn ?? console.warn)(`orphan sweep: kept ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    deps.cleanup.orphans({ workspaces, results });
    await deps.cleanup.idle();
    report.removed = true;
  }

  state = { firstSeen: seen, last: report };
  try { writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); } catch (error) {
    (deps.warn ?? console.warn)(`orphan sweep: could not save its notes: ${error instanceof Error ? error.message : String(error)}`);
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
      .catch((error: unknown) => (deps.warn ?? console.warn)(`orphan sweep: stopped: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  };
  setTimeout(pass, deps.firstPassMs ?? FIRST_PASS_MS).unref?.();
  setInterval(pass, deps.everyMs ?? EVERY_MS).unref?.();
}
