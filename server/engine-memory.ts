// Each engine process and the MCP servers it starts take hundreds of MB, and a Linux machine without swap that runs out
// keeps reclaiming, unresponsive, long before its OOM killer acts; in a container the kernel stops engines instead. So a
// turn that needs a new engine waits here for memory, and under a container's pids limit for room for its processes
// (process-room.ts), on a Cloud home and on a self-hosted Linux server alike.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { chatNotice, noticeFailure } from "./chat-notices.ts";
import { newEventId, newId, TurnAuthenticationRefusedError, TurnNotStartedError, TurnUsageLimitRefusedError, type ProviderAdapter, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "./contracts.ts";
import { readCgroupMemory } from "./process-limits.ts";
import { namesOwnCause, shortageCode, type ShortageCode } from "./process-shortage.ts";
import {
  BROWSER_TASKS, ENGINE_TASKS, engineTasks, gateHost, linuxTreeUse, processBudget, SESSION_TASKS, turnsSetting, turnsUnder, type GateHost, type ProcessBudget, type TreeUse,
  type TurnsSetting,
} from "./process-room.ts";

const MB = 1024 * 1024;
const PAGE_BYTES = 4096;
/** What one engine and its MCP servers take until one has been measured here: `opencode acp` 1.19.3 measured 361 MB on a
 * Cloud home before its first prompt and 623 MB with six stdio MCP servers, and about 466 MB while working. */
export const ENGINE_DEFAULT_BYTES = 700 * MB;
const ENGINE_MIN_BYTES = 300 * MB;
/** The most admission plans for one engine, however large the ones measured here. */
export const ENGINE_MAX_BYTES = 1500 * MB;
/** One more session in a running shared process: OpenCode 1.19.3 grew about 110 MB a session with three stdio MCP
 * servers after a prompt; more MCP servers cost more. */
export const SESSION_BYTES = 200 * MB;
/** Memory the server, Chrome and the page cache keep: below it a machine without swap starts to thrash. */
export const memoryFloor = (totalBytes: number): number => Math.max(320 * MB, totalBytes * 0.1);
/** One bot's browser (agent-browser's daemon and its Chrome) on a page or two: 270 to 390 MB per bot on an 8 GB Cloud home,
 * 2026-10-21. It runs outside the engine's process group, so an engine's measured size never includes it. */
export const BROWSER_BYTES = 400 * MB;
/** A new engine's share is held back this long while it starts and grows; it is measured once it has run this long. */
const RESERVE_MS = 90_000, SETTLED_MS = 30_000, TASKS_RESERVE_MS = 20_000, TASKS_SETTLED_MS = 5_000, SERVER_TURNS_FOR_MS = 5_000;
/** A new engine process that has sent nothing this long after its turn began, while the server is short of room, never
 * came up: under a full pids limit a process can start and then hang, its threads refused, without any error. With no
 * sign of a shortage, or while its processes still work (a cold `npx` install, a slow first start), each driver's own
 * start timeout decides instead. */
export const FIRST_FRAME_MS = 90_000;
/** A silent engine's tree is read this long apart: less CPU than IDLE_CPU_MS between two reads and no child running is idle. */
const FRAME_SAMPLE_MS = 5_000, FRAME_RECHECK_MS = 15_000, IDLE_CPU_MS = 50, FRAME_WATCH_MS = 10 * 60_000;
const TICK_MS = 2_000, RELIEF_COOLDOWN_MS = 15_000, NOTICE_REPEAT_MS = 10 * 60_000, STOP_GRACE_MS = 5_000;
/** How long a bot's turn lets a person's own work go first. Past this it takes its place by arrival, so it is never starved. */
export const BOT_TURN_GIVES_WAY_MS = 5 * 60_000;
/** A minute counts as stalled on memory when every task that could run waited on memory this much of ten seconds (the
 * kernel's `full avg10`, in percent). */
const STALL_PERCENT = 20;
/** Every task stalled on memory this much of the time, with room below the floor: the machine is thrashing. A Cloud home
 * that does stops answering, and its Admin restarts it within minutes, every turn with it (Nov 2026: 75 of 112 restarts
 * on Fly in a week, 58 of them 2 GB homes without swap, memory available 7 MB and the stall 70% at the median). */
const THRASH_PERCENT = 40;
/** After a busy engine is stopped for room, no other busy one is for this long, nor while that stop or its browser's
 * close is still under way: what it frees takes a moment to show. */
const BUSY_STOP_GAP_MS = 2 * RELIEF_COOLDOWN_MS;
const MINUTE_MS = 60_000, DAY_MINUTES = 24 * 60;
/** Engines that run each thread's turns in processes of their own. */
export const ENGINE_PROCESS_KINDS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "opencodeGo", "grokAgent", "geminiAgent", "kimiAgent",
  "droidAgent", "cursorAgent", "qwenAgent", "hermesAgent", "clineAgent", "copilotAgent", "commandCodeAgent", "kiroAgent", "devinAgent", "customAcp", "piAgent", "ompAgent", "mistralVibeAgent", "antigravityAgent"]);

/** Chat-runtime engines (openai-chat.ts) have no process of their own, but each turn starts its MCP servers, each a Node process. */
export const CHAT_RUNTIME_KINDS: ReadonlySet<string> = new Set(["openai-compat", "cerebras", "greenference", "grok", "groq", "meta", "minimax", "mistral", "modelgo"]);

export interface HostMemory {
  totalBytes: number; availableBytes: number; swapFreeBytes: number; oomKills: number | null; fullStall10: number | null;
  /** "host": `fullStall10` is the whole machine's, read for a cgroup that has no stall of its own (cgroup v1), not this
   * server's. Absent: its own. */
  stallScope?: "host";
}

const procText = (path: string) => readFileSync(path, "utf8");

/** /proc/meminfo, the kernel's OOM kill count and memory stall; null where there is no /proc (not Linux). /proc/meminfo is
 * the whole machine's even inside a container, so under a cgroup limit below the machine's memory the limit, what counts
 * against it and the cgroup's own OOM kills and stall are what is reported, and swap, which the limit may not allow, is not
 * counted on. */
export function readHostMemory(read: (path: string) => string = procText): HostMemory | null {
  const host = readMachineMemory(read);
  if (!host) return null;
  const cgroup = readCgroupMemory((path) => { try { return read(path); } catch { return null; } });
  if (!cgroup || cgroup.limitBytes >= host.totalBytes) return host;
  return { totalBytes: cgroup.limitBytes, availableBytes: Math.max(0, Math.min(host.availableBytes, cgroup.limitBytes - cgroup.usedBytes)), swapFreeBytes: 0,
    oomKills: cgroup.oomKills ?? host.oomKills, fullStall10: cgroup.fullStall10 ?? host.fullStall10, ...(cgroup.fullStall10 === null && host.fullStall10 !== null ? { stallScope: "host" as const } : {}) };
}

function readMachineMemory(read: (path: string) => string): HostMemory | null {
  let meminfo: string;
  try { meminfo = read("/proc/meminfo"); } catch { return null; }
  const field = (name: string) => { const found = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(meminfo); return found ? Number(found[1]) * 1024 : null; };
  const totalBytes = field("MemTotal"), availableBytes = field("MemAvailable");
  if (totalBytes === null || availableBytes === null) return null;
  const number = (path: string, pattern: RegExp) => { try { const found = pattern.exec(read(path)); return found ? Number(found[1]) : null; } catch { return null; } };
  return { totalBytes, availableBytes, swapFreeBytes: field("SwapFree") ?? 0,
    oomKills: number("/proc/vmstat", /^oom_kill (\d+)$/m), fullStall10: number("/proc/pressure/memory", /^full avg10=([\d.]+)/m) };
}

/** A process's proportional set size: each page it shares counts as its share among the processes sharing it. Null where
 * /proc/<pid>/smaps_rollup can't be read (a kernel before 4.14, another user's process). */
function pssBytes(pid: string, read: (path: string) => string): number | null {
  try {
    const found = /^Pss:\s+(\d+) kB$/m.exec(read(`/proc/${pid}/smaps_rollup`));
    return found ? Number(found[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** What each process group takes (an engine and the MCP servers it started): the sum of its processes' proportional set
 * sizes, so engines of one kind, or MCP servers on one runtime, count the code they share once between them rather than
 * once each, as resident pages would. A process whose share can't be read counts its resident pages, which err high. */
export function processGroupBytes(list: () => string[] = () => readdirSync("/proc"), read: (path: string) => string = procText): Map<number, number> {
  const groups = new Map<number, number>();
  let pids: string[];
  try { pids = list(); } catch { return groups; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let stat: string;
    try { stat = read(`/proc/${pid}/stat`); } catch { continue; }
    // pid (comm) state ppid pgrp …, rss the 24th: comm may hold spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const group = Number(fields[2]);
    groups.set(group, (groups.get(group) ?? 0) + (pssBytes(pid, read) ?? (Number(fields[21]) * PAGE_BYTES || 0)));
  }
  return groups;
}

const tasks = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;
const running = (count: number) => `${tasks(count)} ${count === 1 ? "is" : "are"} running on this Cloud`;
/** `only`: it was the one task running (stopped as the machine thrashed): nothing else was kept running by it. */
const memoryStopKey = (browser: boolean, detail = false, only = false) => only
  ? detail ? "chat.notice.memoryReclaimedOnlyDetail" : "chat.notice.memoryReclaimedOnly"
  : detail
    ? browser ? "chat.notice.memoryReclaimedBrowserDetail" : "chat.notice.memoryReclaimedTaskDetail"
    : browser ? "chat.notice.memoryReclaimedBrowser" : "chat.notice.memoryReclaimedTask";
/** The one line a turn stopped for memory ends with: what was closed to keep everything else running. */
export const memoryStopText = (browser: boolean, only = false) => chatNotice(memoryStopKey(browser, false, only));
/** Whether a failed turn's cause is `memoryStopText`'s: such a run is started again once there is room. */
export const memoryStopped = (cause: string) =>
  /^Ran out of room, so I (closed the browser|stopped this task) to keep (everything else running|everything here from freezing)\./.test(cause);
export const memoryWaitText = (count: number) => `Waiting for memory: ${running(count)}, and one more could run it out of memory. `
  + "This one starts by itself when there is room.";
export const memoryStillWaitingText = (count: number) => `Still waiting for memory: ${running(count)}.`;
/** How a wait reads to the person, in their language, and where else it shows. */
export interface EngineWaits {
  /** `limit`: the most turns at once (a plan's, or a self-hosted server's), when that is what this one waits for rather
   * than room. `server`: a self-hosted server, whose wait is for memory or for room under its process limit. */
  text(threadId: string, wait: { first: boolean; running: number; ahead: number; limit?: number; server?: boolean }): string;
  began(threadId: string, wait: { running: number; ahead: number; limit?: number; server?: boolean }): void;
  /** Whether anything is waiting for memory changed. */
  changed(): void;
}
export const memoryStallText = (cause: string, count: number) => `${cause}. This Cloud ran out of memory while ${tasks(count)} ran at once (not a problem with the AI provider)`;

/** The last day's memory pressure on a Cloud home: tasks that had to wait for memory and how long they waited in all (a wait
 * still going included), turns stopped for memory, processes the kernel stopped, and minutes the machine stalled on it. */
export interface RoomReport { waits: number; waitMs: number; stopped: number; killed: number; stallMinutes: number }
/** The same counts since this process started (no wait time): the Admin keeps each hour's increase (its Cloud history), which
 * the rolling day can't give. A restart starts them again; the Admin tells by the report's `bootedAt`. */
export type BootPressure = Omit<RoomReport, "waitMs">;
type PressureKind = "waits" | "waitMs" | "stopped" | "killed" | "stalled";

/** Counts by minute over the last day, and since start. */
export class PressureLedger {
  private readonly minutes = new Map<number, Record<PressureKind, number>>();
  private readonly sinceStart: BootPressure = { waits: 0, stopped: 0, killed: 0, stallMinutes: 0 };

  note(at: number, kind: PressureKind, amount = 1): void {
    const minute = Math.floor(at / MINUTE_MS);
    const slot = this.minutes.get(minute) ?? { waits: 0, waitMs: 0, stopped: 0, killed: 0, stalled: 0 };
    if (kind === "stalled") { if (!slot.stalled) this.sinceStart.stallMinutes += 1; }
    else if (kind !== "waitMs") this.sinceStart[kind] += amount;
    slot[kind] = kind === "stalled" ? 1 : slot[kind] + amount;
    this.minutes.set(minute, slot);
    for (const key of this.minutes.keys()) if (key <= minute - DAY_MINUTES) this.minutes.delete(key);
  }

  /** `waiting`: when each task still waiting began to. */
  read(at: number, waiting: Iterable<number> = []): RoomReport {
    const report: RoomReport = { waits: 0, waitMs: 0, stopped: 0, killed: 0, stallMinutes: 0 };
    const since = Math.floor(at / MINUTE_MS) - DAY_MINUTES;
    for (const [minute, slot] of this.minutes) {
      if (minute <= since) continue;
      report.waits += slot.waits; report.waitMs += slot.waitMs; report.stopped += slot.stopped; report.killed += slot.killed; report.stallMinutes += slot.stalled;
    }
    for (const start of waiting) report.waitMs += Math.max(0, at - start);
    return report;
  }

  /** Counts since start: never fall, so the Admin can take each read's increase. */
  boot(): BootPressure { return { ...this.sinceStart }; }
}

/** The bots' browsers, which start during a turn rather than with its engine. */
export interface EngineBrowsers {
  /** Whether this thread's bot may browse and its browser is not running yet. */
  starts(threadId: string): boolean;
  /** Which browser this thread would use: threads naming the same one start it once between them. */
  which?(threadId: string): string | undefined;
  /** Whether this thread's bot's browser is running now. */
  running(threadId: string): boolean;
  /** This thread's engine was stopped for memory: its browser can close too once no turn holds it. Resolves once it has
   * closed, or given up. */
  stopped(threadId: string): void | Promise<unknown>;
  /** Closes running browsers no turn holds and no call runs in, before their idle time is up; how many it asked to close.
   * `thrashing`: the machine thrashes, and a browser a person watches, one of a running turn that hasn't used it yet, or
   * one whose close loses its sign-ins goes too. `busy`: the threads with a turn running (host/browser-reclaim.ts). */
  reclaimUnused?(pressure: { thrashing: boolean; busy: readonly string[] }): number;
  /** Whether any bot's browser runs now: memory is watched while one does, engine or not. */
  anyRunning?(): boolean;
}

/** A plan's limit on how many turns run at once, whatever memory allows. */
export interface EngineCap {
  /** The most turns that may run at once; undefined when the plan sets no such limit. */
  most(): number | undefined;
  /** Whether this thread's running turn waits on work it handed out: it holds no place, so the work it waits on can run. */
  waitsOnOthers(threadId: string): boolean;
  /** Whether a lane of its own runs this thread (a burst's): it neither takes a place under this limit nor waits for one. */
  laneOwned?(threadId: string): boolean;
}

/** An engine process and the threads whose sessions it runs: one, or several when the driver shares processes. */
interface Engine { child: ChildProcess; threads: Set<string>; startedAt: number; stopping: boolean }
interface Waiter { wake: () => void; threadId: string; since: number }

export interface EngineMemoryOptions {
  enabled: boolean;
  /** A self-hosted server also holds turns to a number of its own and to its container's pids limit; a Cloud home, the
   * default, keeps to memory and its plan. */
  host?: Exclude<GateHost, null>;
  /** OMB_TURNS_MAX_RUNNING on a self-hosted server. */
  turns?: TurnsSetting;
  processes?: ProcessBudget;
  read?: () => HostMemory | null;
  groups?: () => Map<number, number>;
  now?: () => number;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** An engine's process tree: whether it still works. Null where it can't be read, and then it is never stopped as silent. */
  tree?: (pid: number) => TreeUse | null;
  log?: (line: string) => void;
  tickMs?: number;
}

export class EngineMemory {
  readonly enabled: boolean;
  private readonly read: () => HostMemory | null;
  private readonly groups: () => Map<number, number>;
  private readonly now: () => number;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly tree: (pid: number) => TreeUse | null;
  private readonly log: (line: string) => void;
  private readonly tickMs: number;
  private readonly context = new AsyncLocalStorage<string>();
  private readonly engines = new Map<number, Engine>();
  private readonly active = new Set<string>();
  /** Threads admitted in the last RESERVE_MS: when, and what they were let in for. */
  private readonly reserved = new Map<string, { at: number; start: "process" | "session"; tasks: number; browser: boolean; browserSince?: number }>();
  private readonly queue: Waiter[] = [];
  /** Threads whose engine was stopped for memory: how many tasks ran then, and whether their browser was running. */
  private readonly stops = new Map<string, { count: number; browser: boolean; only?: true }>();
  /** Threads whose turn could not run its engine for want of room: the code its failure names, and whether the engine's own
   * spawn was refused (a later spawn in the same turn that works clears that) or the engine was stopped as silent. */
  private readonly starved = new Map<string, { code: ShortageCode; why: "refused" | "silent" }>();
  /** Threads whose engine this gate stopped, for room or for want of it, during their turn: that engine's pid. */
  private readonly roomStopped = new Map<string, number>();
  /** The last spawn the system refused for want of room, anywhere on the server. */
  private lastRefusal: { at: number; code: ShortageCode } | null = null;
  /** Threads whose turn is about to start an engine that keeps a session (expectFrame). */
  private readonly expecting = new Set<string>();
  private queuedEver = 0;
  private starvedEver = 0;
  /** Threads that ran while memory was short: the most tasks running then. */
  private readonly pressure = new Map<string, number>();
  private oomKills: number | null = null;
  private readonly ledger = new PressureLedger();
  /** Tasks waiting for memory now, and since when. */
  private readonly waitingSince = new Map<Waiter, number>();
  private lastRelief = -Infinity;
  private lastBrowserRelief = -Infinity;
  private lastBusyStop = -Infinity;
  private busyStopping = false;
  /** Since when every reading has thrashed, the home's own stall (not a host's) with memory below the critical line. */
  private thrashingSince: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private browsers: EngineBrowsers | null = null;
  private personsOwn: (threadId: string) => boolean = () => false;
  private generation = 0;
  private ordered: { at: number; generation: number; list: Waiter[] } | null = null;
  private waits: EngineWaits | null = null;
  private cap: EngineCap | null = null;
  private readonly server: boolean;
  private readonly turns: TurnsSetting;
  private readonly processes: ProcessBudget | null;
  private serverTurns: { at: number; most: number | undefined } | null = null;
  private idleSweep: (() => void) | null = null;

  constructor(options: EngineMemoryOptions) {
    this.enabled = options.enabled;
    this.server = options.host === "server";
    this.turns = options.turns ?? "auto";
    this.processes = this.server ? options.processes ?? processBudget : null;
    this.processes?.onRefused(() => this.wake());
    this.read = options.read ?? (() => readHostMemory());
    this.groups = options.groups ?? (() => processGroupBytes());
    this.now = options.now ?? Date.now;
    this.signal = options.signal ?? ((pid, signal) => process.kill(-pid, signal));
    this.tree = options.tree ?? ((pid) => linuxTreeUse(pid));
    this.log = options.log ?? ((line) => console.warn(`memory: ${line}`));
    this.tickMs = options.tickMs ?? TICK_MS;
  }

  useBrowsers(browsers: EngineBrowsers): void { this.browsers = browsers; }

  /** Whether this thread's turn is a person's own work, which goes first when memory holds several. */
  useTurnOrder(personsOwn: (threadId: string) => boolean): void { this.personsOwn = personsOwn; }

  useWaits(waits: EngineWaits): void { this.waits = waits; }

  useCap(cap: EngineCap): void { this.cap = cap; }

  /** A self-hosted server where turns wait for room (not a Cloud home, not the desktop app). */
  selfHosted(): boolean { return this.enabled && this.server; }

  /** Whether every turn here waits for a place under a limit on turns, not only one that starts an engine. */
  limited(): boolean { return this.enabled && this.most() !== undefined; }

  /** The most turns at once: the plan's, and on a self-hosted server the operator's number, or else what its memory and
   * its pids limit hold at an engine's usual size. */
  most(): number | undefined {
    const plan = this.cap?.most(), server = this.serverMost();
    return plan === undefined ? server : server === undefined ? plan : Math.min(plan, server);
  }

  private serverMost(): number | undefined {
    if (!this.server) return undefined;
    if (typeof this.turns === "number") return this.turns;
    const at = this.now();
    if (this.serverTurns && at - this.serverTurns.at < SERVER_TURNS_FOR_MS && at >= this.serverTurns.at) return this.serverTurns.most;
    const memory = this.read(), limit = this.processes?.limit() ?? null;
    const fits = [memory ? Math.max(1, Math.floor((memory.totalBytes - this.floor(memory)) / ENGINE_DEFAULT_BYTES)) : null, limit === null ? null : turnsUnder(limit)]
      .filter((count): count is number => count !== null);
    this.serverTurns = { at, most: fits.length ? Math.min(...fits) : undefined };
    return this.serverTurns.most;
  }

  /** The plan's limit when it is what this thread's turn must wait for now; undefined when there is a place. */
  private capped(threadId: string): number | undefined {
    const most = this.most();
    if (most === undefined || this.cap?.laneOwned?.(threadId)) return undefined;
    let running = 0;
    for (const other of new Set([...this.active, ...this.reserved.keys()])) {
      if (other === threadId || this.cap?.waitsOnOthers(other) || this.cap?.laneOwned?.(other)) continue;
      if (++running >= most) return most;
    }
    return undefined;
  }

  /** Whether a lane may start one more turn: nobody's own work is waiting, and under a plan's limit the whole machine, the
   * lane's own turns counted, has a place. Linear in the turns running and the ones waiting. */
  laneHasRoom(): boolean {
    if (!this.enabled) return true;
    if (this.queue.some((waiter) => this.personsOwn(waiter.threadId))) return false;
    const most = this.most();
    if (most === undefined) return true;
    let running = 0;
    for (const other of new Set([...this.active, ...this.reserved.keys()])) {
      if (!this.cap?.waitsOnOthers(other) && ++running >= most) return false;
    }
    return true;
  }

  /** Whether a task is waiting for memory now. */
  waiting(): boolean { return this.waitingSince.size > 0; }

  /** Runs `start` with the engine processes it spawns counted as this thread's (procs.ts spawnCli calls `track`). */
  within<T>(threadId: string, start: () => T): T {
    return this.enabled ? this.context.run(threadId, start) : start();
  }

  /** An engine process just spawned for a bot's turn. */
  track(child: ChildProcess): void {
    const threadId = this.context.getStore();
    if (!this.enabled || !child.pid || threadId === undefined) return;
    const pid = child.pid, engine: Engine = { child, threads: new Set([threadId]), startedAt: this.now(), stopping: false };
    this.engines.set(pid, engine);
    this.oomKills ??= this.read()?.oomKills ?? null;
    // A spawn that worked after one was refused in the same turn: the turn goes on, and its end is its own.
    if (this.starved.get(threadId)?.why === "refused") this.starved.delete(threadId);
    // An engine that keeps a session (Claude's stream, ACP, Codex's app-server) writes to its stdout first thing. Read from
    // the pipe's byte count: no listener is added to it.
    const out = this.expecting.delete(threadId) ? child.stdout as { bytesRead?: unknown } | null : null;
    const unwatch = out && typeof out.bytesRead === "number" ? this.watchFirstFrame(engine, out as { bytesRead: number }) : null;
    child.once("exit", (_code, signal) => { unwatch?.(); this.exited(pid, engine, signal); });
    this.arm();
  }

  /** From FIRST_FRAME_MS on, a new engine that has written nothing is stopped as one that never came up, only while the
   * server shows a shortage (pids at its limit at the start or now, a spawn refused since the start, memory short or
   * stalled) and only once its process tree has gone idle with no child running. Otherwise it is left to its driver. */
  private watchFirstFrame(engine: Engine, out: { bytesRead: number }): () => void {
    const pid = engine.child.pid!, crowdedAtStart = this.processes?.short(ENGINE_TASKS, 0) === true;
    let timer: ReturnType<typeof setTimeout> | null = null, last: TreeUse | null = null;
    const watch = (ms: number) => { timer = setTimeout(look, ms); timer.unref?.(); };
    const look = () => {
      timer = null;
      if (engine.stopping || out.bytesRead !== 0 || this.now() - engine.startedAt > FRAME_WATCH_MS) return;
      const code = this.shortage(engine.startedAt, crowdedAtStart), use = code === null ? null : this.tree(pid);
      if (code !== null && use && last && use.children === 0 && use.cpuMs - last.cpuMs < IDLE_CPU_MS) { void this.starveEngine(engine, code); return; }
      last = use;
      watch(use ? FRAME_SAMPLE_MS : FRAME_RECHECK_MS);
    };
    watch(FIRST_FRAME_MS - FRAME_SAMPLE_MS);
    return () => { if (timer) clearTimeout(timer); };
  }

  /** The shortage the server shows for an engine started at `since`, by the code its turn's failure would name; null for
   * none. */
  private shortage(since: number, crowdedAtStart: boolean): ShortageCode | null {
    if (this.lastRefusal && this.lastRefusal.at >= since) return this.lastRefusal.code;
    if (crowdedAtStart || this.processes?.short(0, 0)) return "EAGAIN";
    const memory = this.read();
    return memory && ((memory.fullStall10 ?? 0) >= STALL_PERCENT || this.free(memory) < this.floor(memory)) ? "ENOMEM" : null;
  }

  /** The next engine process this thread's turn starts keeps a session, and so speaks first: it gets FIRST_FRAME_MS to. */
  expectFrame(threadId: string): void { if (this.enabled) this.expecting.add(threadId); }

  /** A spawn the system refused. Every one is a sign of a shortage; an engine's own (`engine`) inside a thread's running
   * turn also fails that turn as one the server had no room for. `threadId` is that turn's, read from the spawn's own
   * context unless given. */
  spawnRefused(code: string | undefined, engine = false, threadId = this.context.getStore()): void {
    const shortage = shortageCode({ code });
    if (!this.enabled || shortage === null) return;
    this.lastRefusal = { at: this.now(), code: shortage };
    if (engine && threadId !== undefined && this.active.has(threadId) && !this.starved.has(threadId)) this.starved.set(threadId, { code: shortage, why: "refused" });
  }

  /** The engine processes tracked now, with the threads each runs: for the performance sampler's buckets. */
  enginePids(): Array<{ pid: number; threads: string[] }> { return [...this.engines].map(([pid, engine]) => ({ pid, threads: [...engine.threads] })); }

  /** A thread's session now runs in this already tracked engine process. */
  attach(child: ChildProcess, threadId: string): void {
    if (child.pid) this.engines.get(child.pid)?.threads.add(threadId);
  }

  detach(child: ChildProcess, threadId: string): void {
    if (child.pid) this.engines.get(child.pid)?.threads.delete(threadId);
  }

  /** A turn starts with nothing from an earlier one: what stopped or starved that turn's engine is not this one's cause. */
  turnStarted(threadId: string): void {
    if (!this.enabled) return;
    this.active.add(threadId);
    this.forget(threadId);
  }

  private forget(threadId: string): void {
    this.stops.delete(threadId);
    this.starved.delete(threadId);
    this.roomStopped.delete(threadId);
  }

  /** This thread's engine process is still running (an engine keeps one between turns), so its turn starts no new one. */
  hasEngine(threadId: string): boolean {
    for (const engine of this.engines.values()) if (engine.threads.has(threadId) && !engine.stopping) return true;
    return false;
  }

  turnEnded(threadId: string): void {
    if (!this.enabled) return;
    this.active.delete(threadId);
    this.reserved.delete(threadId);
    this.pressure.delete(threadId);
    this.forget(threadId);
    this.expecting.delete(threadId);
    this.wake();
  }

  /** A new engine never came up: its processes are stopped, and its threads' turns fail as ones the server had no room
   * for, which start again by themselves rather than as the AI's failure. */
  private async starveEngine(engine: Engine, code: ShortageCode): Promise<void> {
    if (engine.stopping || engine.child.exitCode !== null || engine.child.signalCode !== null) return;
    // Not a refused spawn: no limit is learned from it, and no count of refusals goes up.
    for (const threadId of this.working(engine)) if (!this.starved.has(threadId)) this.starved.set(threadId, { code, why: "silent" });
    this.noteRoomStopped(engine);
    this.starvedEver += 1;
    this.log(`an engine (pid ${engine.child.pid}) sent nothing for ${Math.round((this.now() - engine.startedAt) / 1000)} s after it started, idle, while the server was short of room (${code}); stopping it`);
    await this.stop(engine, "relief");
  }

  private noteRoomStopped(engine: Engine): void { for (const threadId of this.working(engine)) this.roomStopped.set(threadId, engine.child.pid!); }

  /** Whether this thread's engine was stopped to make room, or for want of it, in its turn: its turn is not sent again at
   * once. With `pid`, whether that engine process is the one stopped: any other exit is the engine's own. */
  stoppedForRoom(threadId: string, pid?: number): boolean {
    if (pid !== undefined) return this.roomStopped.get(threadId) === pid;
    return this.stops.has(threadId) || this.starved.has(threadId);
  }

  /** How many engines may stay loaded with no turn running, on a self-hosted server: what fits beside the ones working.
   * Infinity elsewhere. */
  idleEnginesAllowed(): number {
    const most = this.enabled ? this.serverMost() : undefined;
    return most === undefined ? Infinity : Math.max(1, most - this.busy());
  }

  /** Turns running and waiting now, and counts since the server started: numbers only. */
  counts(): { running: number; queued: number; longestWaitMs: number; most: number | null; queuedEver: number; starvedEver: number } {
    const at = this.now();
    return { running: this.active.size, queued: this.waitingSince.size, longestWaitMs: Math.max(0, ...[...this.waitingSince.values()].map((since) => at - since)),
      most: this.enabled ? this.most() ?? null : null, queuedEver: this.queuedEver, starvedEver: this.starvedEver };
  }

  /** Tasks running on engines here now, or about to (admitted, not yet started); `also` counts one more thread. */
  busy(also?: string): number {
    const threads = this.busyThreads();
    if (also !== undefined) threads.add(also);
    return threads.size;
  }

  private othersBusy(threadId: string): number {
    const threads = this.busyThreads();
    threads.delete(threadId);
    return threads.size;
  }

  private busyThreads(): Set<string> {
    const threads = new Set(this.reserved.keys());
    for (const engine of this.engines.values()) if (!engine.stopping) for (const threadId of this.working(engine)) threads.add(threadId);
    return threads;
  }

  /** Resolves once a new engine process, or a session in the running one `joining` names by pid, fits for this thread, or
   * for `turn` once the plan's limit has a place for its turn; `notify` tells the person when it has to wait. False when
   * aborted. A thread joining a process counts on it at once, so that process is never stopped as idle to make room for its
   * own new session. `tasks`: what a new process of this engine holds against the pids limit. */
  async admit(threadId: string, abort: AbortSignal, notify: (text: string) => void, start: "process" | "session" | "turn" = "process",
    joining?: number, tasks = ENGINE_TASKS): Promise<boolean> {
    if (!this.enabled) return true;
    if (joining !== undefined) this.engines.get(joining)?.threads.add(threadId);
    const waiter: Waiter = { wake: () => {}, threadId, since: this.now() };
    this.queue.push(waiter);
    this.generation++;
    let announced: number | null = null;
    try {
      for (;;) {
        if (abort.aborted) return false;
        if (this.order()[0] === waiter && this.capped(threadId) === undefined) {
          // Counted at once: another waiter woken with this one must see its place taken.
          if (start === "turn") { this.active.add(threadId); return true; }
          const room = this.room(start, threadId, tasks);
          if (room === "admit") {
            this.reserved.set(threadId, { at: this.now(), start, tasks, browser: this.browserStarts(threadId) });
            this.arm();
            return true;
          }
          if (room !== "wait") { await this.stop(room, "idle"); continue; }
        }
        if (announced === null || this.now() - announced >= NOTICE_REPEAT_MS) {
          const others = this.othersBusy(threadId), first = announced === null, ahead = this.order().indexOf(waiter);
          const limit = this.capped(threadId), wait = { running: others, ahead, ...(limit === undefined ? {} : { limit }), ...(this.server ? { server: true } : {}) };
          if (first) {
            this.waitingSince.set(waiter, this.now());
            this.queuedEver += 1;
            this.ledger.note(this.now(), "waits");
            this.waits?.began(threadId, wait);
            if (this.waitingSince.size === 1) this.waits?.changed();
          }
          notify(this.waits?.text(threadId, { first, ...wait }) ?? (first ? memoryWaitText(others) : memoryStillWaitingText(others)));
          announced = this.now();
        }
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); abort.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, this.tickMs);
          timer.unref?.();
          waiter.wake = done;
          abort.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      this.queue.splice(this.queue.indexOf(waiter), 1);
      this.generation++;
      const since = this.waitingSince.get(waiter);
      if (since !== undefined) {
        this.waitingSince.delete(waiter);
        this.ledger.note(this.now(), "waitMs", this.now() - since);
        if (this.waitingSince.size === 0) this.waits?.changed();
      }
      this.wake();
    }
  }

  /** The sentence for a turn of this thread whose engine was stopped for memory; null when it was not. */
  stopText(threadId: string): string | null {
    return this.stopFailure(threadId)?.message ?? null;
  }

  /** `detail`: the failure that ends the turn, when one names its own cause (a usage limit, a sign-in) it is kept, whatever
   * shortage was seen in the turn. `interrupted`: the person stopped the turn, which no shortage explains. */
  stopFailure(threadId: string, detail?: string, interrupted = false): ReturnType<typeof noticeFailure> | null {
    const starved = this.starved.get(threadId);
    if (starved !== undefined && !interrupted && (detail === undefined || !namesOwnCause(detail))) return noticeFailure("chat.notice.outOfProcesses", { code: starved.code });
    const stop = this.stops.get(threadId);
    return stop === undefined ? null : noticeFailure(memoryStopKey(stop.browser, detail !== undefined, stop.only === true), detail === undefined ? undefined : { detail });
  }

  /** A stalled turn's cause, saying so when memory ran short while it ran. */
  stallCause(threadId: string, cause: string): string {
    const count = this.stops.get(threadId)?.count ?? this.pressure.get(threadId);
    return count === undefined ? cause : memoryStallText(cause, count);
  }

  /** The last day's memory pressure, for the Admin's health check (cloud-health.ts): times only, never what ran. */
  dayPressure(): RoomReport { return this.ledger.read(this.now(), this.waitingSince.values()); }
  /** The last day's pressure and the counts since start (`boot`), as the health report carries them. */
  roomReport(): RoomReport & { boot: BootPressure } { return { ...this.dayPressure(), boot: this.ledger.boot() }; }

  /** Every couple of seconds while an engine or a bot's browser runs: notes short memory against the running turns, and
   * makes room before the machine runs out: an idle engine first (and, thrashing, the unused browsers with it), then the
   * browsers no turn is using, then one of two or more busy engines (a bot's own work before a person's, then the
   * newest), one at a time; the only busy one only once the machine has thrashed on its own stall for a cooldown with
   * memory below the critical line, when the Admin's restart that follows would stop it and everything else. */
  tick(): void {
    try { this.idleSweep?.(); } catch (error) { this.log(`idle sweep failed: ${error instanceof Error ? error.message : String(error)}`); }
    const memory = this.read();
    if (!memory) return;
    if ((memory.fullStall10 ?? 0) >= STALL_PERCENT) this.ledger.note(this.now(), "stalled");
    // The kernel's OOM killer just stopped something (a bot's process: oom-score.ts): its memory comes back first.
    if (this.kernelKilled(memory.oomKills)) return;
    const free = this.free(memory), count = this.busy();
    if (free < this.floor(memory)) for (const threadId of this.active) this.pressure.set(threadId, Math.max(this.pressure.get(threadId) ?? 1, count));
    // Short memory is noted against the running turns above on every look. Relief, and the watch itself, only while an
    // engine or a bot's browser runs; with neither, the next engine starts the watch again.
    if (!this.engines.size && !this.browsersRunning()) { if (this.timer) { clearInterval(this.timer); this.timer = null; } return; }
    // Memory available, not counting swap: a home with gigabytes of swap free thrashes all the same (Nov 2026: memory
    // available 0–100 MB, the stall at 40–98%, with 1.8–3.9 GB of swap free).
    const thrashing = (memory.fullStall10 ?? 0) >= THRASH_PERCENT && memory.availableBytes < this.floor(memory);
    const criticalLine = Math.max(160 * MB, memory.totalBytes * 0.04);
    // The only busy engine goes only on this server's own stall, with memory itself below the critical line, read so on
    // two looks at least a cooldown apart: a burst (an install, a build) that passes does not end a turn.
    const severe = thrashing && memory.stallScope !== "host" && memory.availableBytes < criticalLine;
    this.thrashingSince = severe ? this.thrashingSince ?? this.now() : null;
    const critical = free < criticalLine || thrashing;
    if (!critical || this.now() - this.lastRelief < RELIEF_COOLDOWN_MS) return;
    const pressure = { thrashing, busy: [...this.active] };
    const reclaimBrowsers = () => {
      if (this.now() - this.lastBrowserRelief < 2 * RELIEF_COOLDOWN_MS) return 0;
      let asked = 0;
      try { asked = this.browsers?.reclaimUnused?.(pressure) ?? 0; } catch {}
      if (asked > 0) this.lastBrowserRelief = this.now();
      return asked;
    };
    const idle = this.idle();
    if (idle) {
      this.lastRelief = this.now();
      void this.stop(idle, "idle");
      // Thrashing, the browsers no task uses go in the same look: one idle engine at a time is too slow.
      if (thrashing) reclaimBrowsers();
      return;
    }
    // A browser no turn is using goes before any turn does: its idle time may be minutes away. Once per two cooldowns:
    // if memory is still short after that, a busy engine goes, whatever the browsers say.
    if (reclaimBrowsers() > 0) { this.lastRelief = this.now(); return; }
    if (this.busyStopping || this.now() - this.lastBusyStop < BUSY_STOP_GAP_MS) return;
    // A bot's own work goes before a turn a person started, then the newest.
    const own = (engine: Engine) => this.working(engine).some((threadId) => this.personsOwn(threadId));
    const busy = [...this.engines.values()].filter((engine) => !engine.stopping && this.working(engine).length)
      .sort((a, b) => Number(own(a)) - Number(own(b)) || b.startedAt - a.startedAt);
    const only = busy.length === 1;
    const victim = busy.length >= 2 || (only && this.thrashingSince !== null && this.now() - this.thrashingSince >= RELIEF_COOLDOWN_MS) ? busy[0]! : null;
    if (!victim) return;
    this.lastRelief = this.lastBusyStop = this.now();
    this.busyStopping = true;
    const stopped = this.working(victim);
    this.noteStops(stopped, () => count, only);
    this.noteRoomStopped(victim);
    void this.stop(victim, "relief").then(() => this.closeBrowsers(stopped)).finally(() => { this.busyStopping = false; this.lastBusyStop = this.now(); });
  }

  /** How much of an idle engine's keep-alive memory allows: 1 with half the machine free above the floor, down to a tenth
   * as it runs out; 1 where memory can't be read or the gate is off. */
  headroom(): number {
    const memory = this.enabled ? this.read() : null;
    if (!memory) return 1;
    return Math.min(1, Math.max(0.1, (this.free(memory) - this.floor(memory)) / (memory.totalBytes / 2)));
  }

  /** How much of an idle engine's keep-alive the server's room allows (idle-policy.ts): the lower of memory's headroom and,
   * on a server under a pids limit, its processes'; 1 where the gate is off. The same signals admission reads. */
  roomFactor(): number {
    if (!this.enabled) return 1;
    return Math.min(this.headroom(), this.processes?.headroom() ?? 1);
  }

  /** Whether admission would hold a new engine back now: memory below the floor, or no room for one more engine's
   * processes. Then even an engine kept warm on purpose (a prompt-cache keep-warm hold) is closed once idle. */
  shortOfRoom(): boolean {
    if (!this.enabled) return false;
    if (this.processes?.short(ENGINE_TASKS, 0)) return true;
    const memory = this.read();
    return memory !== null && this.free(memory) < this.floor(memory);
  }

  /** Memory available, not counting swap, is under relief's floor (`times` the floor, where given): a browser over its hard
   * line then closes whatever holds it (browser/memory-ceiling.ts). False where memory can't be read. */
  memoryShort(times = 1): boolean {
    const memory = this.read();
    return memory !== null && memory.availableBytes < this.floor(memory) * times;
  }

  /** The browser this thread's turn holds was closed for memory, whatever held it (browser/memory-ceiling.ts): the engine
   * running that turn is stopped as relief stops one, and the turn ends with the line that the browser was closed. False
   * when no engine here runs that turn. */
  stopForBrowser(threadId: string): boolean {
    const engine = [...this.engines.values()].find((candidate) => this.working(candidate).includes(threadId));
    if (!engine) return false;
    if (engine.stopping) return true;
    const stopped = this.working(engine);
    // A driver that carries other conversations stops them too; only this one's line says its browser was the cause.
    this.noteStops(stopped, () => this.busy(), false, threadId);
    this.noteRoomStopped(engine);
    this.lastRelief = this.now();
    void this.stop(engine, "relief").then(() => this.closeBrowsers(stopped));
    return true;
  }

  /** Stops the engine idle longest, if any: what a browser that has no room to open asks before it is refused. */
  async reclaimIdle(): Promise<boolean> {
    const idle = this.enabled ? this.idle() : null;
    if (!idle) return false;
    await this.stop(idle, "idle");
    return true;
  }

  /** Runs on every tick (every couple of seconds while engines run): the idle policy closes what it kept too long. */
  useIdleSweep(sweep: () => void): void { this.idleSweep = sweep; }

  private floor(memory: HostMemory): number { return memoryFloor(memory.totalBytes); }

  private free(memory: HostMemory): number { return memory.availableBytes + memory.swapFreeBytes / 2; }

  private working(engine: Engine): string[] {
    return [...engine.threads].filter((threadId) => this.active.has(threadId));
  }

  private idle(): Engine | null {
    return [...this.engines.values()].filter((engine) => !engine.stopping && !this.working(engine).length)
      .sort((a, b) => a.startedAt - b.startedAt)[0] ?? null;
  }

  private room(start: "process" | "session", threadId: string, tasks: number): "admit" | "wait" | Engine {
    const memory = this.read();
    if (!memory) return this.crowded(start, threadId, 0, false, tasks) ? this.idle() ?? (this.othersBusy(threadId) === 0 ? "admit" : "wait") : "admit";
    const groups = this.groups(), at = this.now();
    const live = [...this.engines.entries()].filter(([, engine]) => !engine.stopping);
    const measured = live.filter(([, engine]) => at - engine.startedAt >= SETTLED_MS).map(([pid]) => groups.get(pid)).filter((bytes) => bytes !== undefined);
    const process = Math.min(ENGINE_MAX_BYTES, Math.max(ENGINE_MIN_BYTES, measured.length ? measured.reduce((sum, bytes) => sum + bytes, 0) / measured.length : ENGINE_DEFAULT_BYTES));
    let held = 0, heldTasks = 0, heldBrowser = false;
    const heldBrowsers = new Set<string>();
    for (const [threadId, admitted] of this.reserved) {
      if (at - admitted.at >= RESERVE_MS) { this.reserved.delete(threadId); continue; }
      // An engine's processes are all there within seconds of its start, long before its memory settles.
      const up = admitted.start === "process" && live.some(([, engine]) => engine.threads.has(threadId) && at - engine.startedAt >= TASKS_SETTLED_MS);
      if (at - admitted.at < TASKS_RESERVE_MS && !up) {
        heldTasks += admitted.start === "session" ? SESSION_TASKS : admitted.tasks;
        heldBrowser ||= admitted.browser && this.browserStarts(threadId);
      }
      // A browser grows as it starts and loads its first pages: its share is held until it has run SETTLED_MS.
      if (admitted.browser) {
        if (!this.browserStarts(threadId)) admitted.browserSince ??= at;
        const browser = this.browsers?.which?.(threadId) ?? threadId;
        if ((admitted.browserSince === undefined || at - admitted.browserSince < SETTLED_MS) && !heldBrowsers.has(browser)) {
          heldBrowsers.add(browser);
          held += BROWSER_BYTES;
        }
      }
      // A session's growth hides inside its shared process's total, so it stays held in full until it settles.
      if (admitted.start === "session") { held += SESSION_BYTES; continue; }
      const pid = live.find(([, engine]) => engine.threads.has(threadId))?.[0];
      held += Math.max(0, process - (pid === undefined ? 0 : groups.get(pid) ?? 0));
    }
    const newBrowser = this.browserStarts(threadId) && !heldBrowsers.has(this.browsers?.which?.(threadId) ?? threadId);
    const need = (start === "session" ? SESSION_BYTES : process) + (newBrowser ? BROWSER_BYTES : 0);
    if (this.free(memory) - this.floor(memory) - held >= need && !this.crowded(start, threadId, heldTasks, heldBrowser, tasks)) return "admit";
    return this.idle() ?? (this.othersBusy(threadId) === 0 ? "admit" : "wait");
  }

  /** Whether this start's processes would not fit under the server's pids limit. A browser starts on a bot's first browser
   * call, not with its engine, and itself waits for room before it opens (browser-room.ts): room for one more
   * is kept while any start pending may open one, rather than one for every such start, which would let one turn in at a
   * time. Browsers already running count in the limit's own count. */
  private crowded(start: "process" | "session", threadId: string, heldTasks: number, heldBrowser: boolean, tasks: number): boolean {
    if (!this.processes) return false;
    const browser = heldBrowser || this.browserStarts(threadId) ? BROWSER_TASKS : 0;
    return this.processes.short((start === "session" ? SESSION_TASKS : tasks) + browser, heldTasks);
  }

  private browserStarts(threadId: string): boolean { return this.browsers?.starts(threadId) === true; }

  private browsersRunning(): boolean { try { return this.browsers?.anyRunning?.() === true; } catch { return false; } }

  private closeBrowsers(threadIds: string[]): Promise<unknown> {
    return Promise.all(threadIds.map((threadId) => { try { return this.browsers?.stopped(threadId); } catch { return undefined; } }));
  }

  private async stop(engine: Engine, why: "idle" | "relief"): Promise<void> {
    const pid = engine.child.pid!, gone = () => engine.child.exitCode !== null || engine.child.signalCode !== null;
    engine.stopping = true;
    this.log(`stopping ${why === "idle" ? "an idle engine" : "an engine"} (pid ${pid}) to make room; ${tasks(this.busy())} running`);
    const exited = new Promise<void>((resolve) => { if (gone()) resolve(); else engine.child.once("exit", () => resolve()); });
    const grace = () => new Promise<void>((resolve) => { const timer = setTimeout(resolve, STOP_GRACE_MS); timer.unref?.(); });
    try { this.signal(pid, why === "idle" ? "SIGTERM" : "SIGKILL"); } catch {}
    await Promise.race([exited, grace()]);
    if (gone()) return;
    try { this.signal(pid, "SIGKILL"); } catch {}
    await Promise.race([exited, grace()]);
  }

  private exited(pid: number, engine: Engine, signal: NodeJS.Signals | null): void {
    if (this.engines.get(pid) === engine) this.engines.delete(pid);
    const working = this.working(engine);
    if (signal === "SIGKILL" && !engine.stopping && working.length && this.kernelKilled(this.read()?.oomKills ?? null)) {
      this.noteStops(working, (threadId) => this.busy(threadId));
      for (const threadId of working) this.roomStopped.set(threadId, pid);
      this.log(`the kernel stopped an engine (pid ${pid}) for memory`);
      this.closeBrowsers(working);
    }
    if (!this.engines.size && !this.browsersRunning() && this.timer) { clearInterval(this.timer); this.timer = null; }
    this.wake();
  }

  /** Whether the kernel stopped processes since the last read of its count, each counted for the day's pressure. */
  private kernelKilled(kills: number | null): boolean {
    const killed = kills !== null && this.oomKills !== null && kills > this.oomKills ? kills - this.oomKills : 0;
    this.oomKills = kills ?? this.oomKills;
    if (killed) this.ledger.note(this.now(), "killed", killed);
    return killed > 0;
  }

  /** These threads' turns were stopped for memory, with how many tasks ran then: each says whether its browser was closed. */
  private noteStops(threadIds: string[], count: (threadId: string) => number, only = false, browserClosed?: string): void {
    for (const threadId of threadIds) {
      if (!this.stops.has(threadId)) this.ledger.note(this.now(), "stopped");
      this.stops.set(threadId, { count: count(threadId), browser: threadId === browserClosed || this.browsers?.running(threadId) === true, ...(only ? { only: true as const } : {}) });
    }
  }

  /** Every waiter orders the queue each time it wakes, so the order is worked out once per wake and moment. */
  private order(): Waiter[] {
    const at = this.now();
    if (this.ordered?.at === at && this.ordered.generation === this.generation) return this.ordered.list;
    const holding: Waiter[] = [], first: Waiter[] = [], rest: Waiter[] = [];
    // A turn that already has its place under a limit on turns, and now waits for its engine's room, goes ahead of the
    // turns still waiting for a place: behind them it would hold its place for good, and they would wait on it.
    for (const waiter of this.queue) (this.active.has(waiter.threadId) ? holding : this.personsOwn(waiter.threadId) || at - waiter.since >= BOT_TURN_GIVES_WAY_MS ? first : rest).push(waiter);
    this.ordered = { at, generation: this.generation, list: [...holding, ...first, ...rest] };
    return this.ordered.list;
  }

  private wake(): void {
    this.generation++;
    for (const waiter of this.queue) waiter.wake();
  }

  private arm(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }
}

const HOST = gateHost();
export const engineMemory = new EngineMemory({ enabled: HOST !== null, host: HOST ?? "cloud", turns: turnsSetting(process.env.OMB_TURNS_MAX_RUNNING) });

/** Engines that keep a session over stdout and answer first (stream-json's init, JSON-RPC's initialize); every driver
 * that admits its own engines (ACP) does too. */
const SESSION_KINDS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * One engine's adapter on a Cloud home: a turn that needs a new engine process waits for memory first (saying so in the
 * chat, and again every ten minutes, which also keeps both stall checks from firing), and a turn whose engine was stopped
 * for memory fails with that reason. The instance is changed in place: its `models` may be a getter a copy would freeze.
 */
export function withEngineMemory(instance: ProviderInstance, memory: EngineMemory = engineMemory): ProviderInstance {
  if (!memory.enabled || !(ENGINE_PROCESS_KINDS.has(instance.driverKind) || CHAT_RUNTIME_KINDS.has(instance.driverKind))) return instance;
  const adapter = instance.adapter;
  const listeners = new Set<RuntimeEventListener>();
  const waiting = new Map<string, AbortController>();
  const tasks = engineTasks(instance.driverKind);
  const explained = new Set<string>();
  const event = (threadId: string, fields: Record<string, unknown>) =>
    ({ eventId: newEventId(), provider: instance.driverKind, threadId, createdAt: new Date().toISOString(), ...fields }) as RuntimeEvent;
  adapter.onEvent((item) => {
    if (item.type !== "turn.completed") return;
    // Once every listener has seen this event: they read the stop while it is delivered.
    queueMicrotask(() => { explained.delete(item.threadId); memory.turnEnded(item.threadId); });
  });
  const present = (item: RuntimeEvent): RuntimeEvent[] => {
    const stopped = memory.stopFailure(item.threadId, item.type === "runtime.error" ? item.message.slice(0, 200) : undefined,
      item.type === "turn.completed" && item.stopReason === "interrupted");
    if (!stopped) return [item];
    if (item.type === "runtime.error") {
      explained.add(item.threadId);
      return [{ ...item, ...stopped }];
    }
    if (item.type === "turn.completed" && !item.ok && !explained.has(item.threadId)) {
      explained.add(item.threadId);
      return [event(item.threadId, { turnId: item.turnId, type: "runtime.error", ...stopped }), item];
    }
    return [item];
  };
  (instance as { adapter: ProviderAdapter }).adapter = {
    ...adapter,
    // Admission counts the engines turns start: none starts ahead of one here.
    prestart: undefined,
    onEvent: (listener) => {
      listeners.add(listener);
      const off = adapter.onEvent((item) => { for (const shown of present(item)) listener(shown); });
      return () => { listeners.delete(listener); off(); };
    },
    sendTurn: async (input) => {
      const { threadId } = input;
      const admit = async (start: "process" | "session" | "turn", joining?: number) => {
        const controller = new AbortController();
        waiting.get(threadId)?.abort();
        waiting.set(threadId, controller);
        try {
          const admitted = await memory.admit(threadId, controller.signal, (message) => {
            for (const listener of listeners) listener(event(threadId, { type: "runtime.notice", message }));
          }, start, joining, tasks);
          if (!admitted) throw new TurnNotStartedError(newId(), "stopped while waiting for memory");
        } finally {
          if (waiting.get(threadId) === controller) waiting.delete(threadId);
        }
      };
      const driverAdmits = adapter.capabilities.engineAdmission === true, limited = memory.limited();
      if (limited) await admit("turn");
      try {
        if (!driverAdmits && !memory.hasEngine(threadId)) await admit("process");
      } catch (error) {
        if (limited) memory.turnEnded(threadId);
        throw error;
      }
      memory.turnStarted(threadId);
      if (SESSION_KINDS.has(instance.driverKind) || driverAdmits) memory.expectFrame(threadId);
      try {
        return await memory.within(threadId, () => adapter.sendTurn(driverAdmits ? { ...input, engineAdmission: admit } : input));
      } catch (error) {
        // A start the server had no room for names that, never the engine's own words: no backup AI is tried for it. A refusal
        // that names its own cause (a usage limit, a sign-in) stays what it is.
        if (error instanceof TurnNotStartedError && !(error instanceof TurnUsageLimitRefusedError || error instanceof TurnAuthenticationRefusedError)
          && memory.stoppedForRoom(threadId) && !namesOwnCause(error.message)) error.message = memory.stopFailure(threadId)?.message ?? error.message;
        memory.turnEnded(threadId);
        throw error;
      }
    },
    interruptTurn: async (threadId, turnId) => {
      waiting.get(threadId)?.abort();
      return adapter.interruptTurn(threadId, turnId);
    },
    stopAll: async () => {
      for (const controller of waiting.values()) controller.abort();
      return adapter.stopAll();
    },
  };
  return instance;
}
