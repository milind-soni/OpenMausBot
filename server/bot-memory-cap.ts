// One bot may use only so much of the server's memory: past its cap, that bot's engine is stopped (its running turn ends
// with a line saying why) and its browser closed, before it can take memory every other bot needs. The design's ladder
// is a systemd scope, then a delegated cgroup v2, then this server's own watchdog, then nothing (the desktop). The kernel
// rungs are probed and reported but not used yet: putting each bot's processes in a cgroup of its own needs the server
// moved into a leaf of its own first, which nothing here has verified on a real host. The watchdog is what enforces the
// cap: every few seconds it reads the process list (no spawn), sums each bot's processes as the per-bot footprint
// attributes them (perf/bot-footprint.ts: never another bot's, never a shared process), checks a bot over its cap by
// proportional set size (shared pages counted once), and stops that bot's processes once it stays over, or at once far
// over. A process several bots share is never stopped.
import { accessSync, constants, existsSync, readFileSync } from "node:fs";

import { boxMemory } from "./box-memory.ts";
import { noticeFailure } from "./chat-notices.ts";
import { newEventId, type ProviderAdapter, type ProviderInstance, type RuntimeEvent } from "./contracts.ts";
import { BROWSER_BYTES, ENGINE_DEFAULT_BYTES } from "./engine-memory.ts";
import { attributeRows, type BotTally, type FootprintOwner } from "./perf/bot-footprint.ts";
import type { ProcessRow } from "./perf/process-buckets.ts";
import type { GateHost } from "./process-room.ts";

export const BOT_MEMORY_ENV = "OMB_BOT_MEMORY_MAX_MB";
const MB = 1_048_576;
/** No cap is set below a busy engine at its largest (engine-memory's ENGINE_MAX_BYTES) with its browser open. */
export const BOT_CAP_FLOOR_BYTES = 1500 * MB + BROWSER_BYTES;
/** Nor above this share of the server's memory: one bot never takes most of it. */
const CAP_SHARE = 0.8;
/** The fair share of a bot is the memory over the turns that may run at once; one bot may use twice that. */
const FAIR_SHARES = 2;
/** An explicit cap below this is taken as this: an engine alone needs more. */
const SMALLEST_CAP_BYTES = 256 * MB;
export const WATCHDOG_MS = 5_000;
/** Over its cap in this many reads in a row (a few seconds apart), or this far over in one, and a bot is stopped. */
const STRIKES = 2, FAR_OVER = 1.5;
const STOP_GRACE_MS = 3_000;
/** A turn that fails this long after its bot was stopped for memory says so. */
const EXPLAIN_FOR_MS = 60_000;

export interface CapInputs {
  /** Where turns wait for room (process-room.ts gateHost): a Cloud home or a self-hosted Linux server; null on the desktop. */
  gate: GateHost;
  /** The memory the server may use: its container's limit, else the machine's. */
  memoryBytes: number;
  /** The most turns that run at once, where known. */
  turns?: number;
}

/** OMB_BOT_MEMORY_MAX_MB: a number of MB; "off" or 0 for no cap; unset or "auto" for the default, which is on wherever
 * turns wait for room (never on the desktop): twice one bot's fair share of the memory (the memory over the turns that
 * may run at once), at least an engine at its largest with its browser, at most 80% of the memory. */
export function botMemoryCapBytes(env: NodeJS.ProcessEnv, inputs: CapInputs, warn: (line: string) => void = () => undefined): number | null {
  const raw = env[BOT_MEMORY_ENV]?.trim().toLowerCase();
  if (raw === "off" || raw === "0") return null;
  if (raw && /^\d+$/.test(raw)) return Math.max(SMALLEST_CAP_BYTES, Number(raw) * MB);
  if (raw && raw !== "auto") warn(`${BOT_MEMORY_ENV}=${JSON.stringify(env[BOT_MEMORY_ENV])} is not a number of MB, "auto" or "off", so the default is used`);
  if (inputs.gate === null || !(inputs.memoryBytes > 0)) return null;
  const turns = Math.max(1, inputs.turns ?? Math.floor(inputs.memoryBytes / ENGINE_DEFAULT_BYTES));
  const fair = (FAIR_SHARES * inputs.memoryBytes) / turns;
  return Math.round(Math.min(inputs.memoryBytes * CAP_SHARE, Math.max(BOT_CAP_FLOOR_BYTES, fair)));
}

export type CapRung = "systemd-scope" | "cgroup" | "watchdog" | "none";
type Read = (path: string) => string | null;
const readText: Read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const writable = (path: string) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } };

/** Which rungs of the ladder this host offers, best first, and the one in use (the watchdog wherever a cap is set and a
 * process list can be read: Linux). */
export function capLadder(capBytes: number | null, deps: { platform?: NodeJS.Platform; read?: Read; writable?: (path: string) => boolean; exists?: (path: string) => boolean } = {}): { rung: CapRung; offered: CapRung[] } {
  const platform = deps.platform ?? process.platform, read = deps.read ?? readText, canWrite = deps.writable ?? writable, exists = deps.exists ?? existsSync;
  if (platform !== "linux") return { rung: "none", offered: [] };
  const offered: CapRung[] = [];
  const own = /^0::(\/.*)$/m.exec(read("/proc/self/cgroup") ?? "")?.[1];
  const dir = own === undefined ? null : `/sys/fs/cgroup${own === "/" ? "" : own}`;
  const memory = dir !== null && /(^|\s)memory(\s|$)/.test(read(`${dir}/cgroup.controllers`) ?? "");
  if (memory && exists("/run/systemd/system") && /\.(service|scope)$/.test(own ?? "")) offered.push("systemd-scope");
  if (memory && dir !== null && canWrite(`${dir}/cgroup.subtree_control`) && canWrite(`${dir}/cgroup.procs`)) offered.push("cgroup");
  offered.push("watchdog");
  return { rung: capBytes === null ? "none" : "watchdog", offered };
}

/** A process's proportional set size from /proc/<pid>/smaps_rollup; null where it can't be read. */
export function pssBytes(pid: number, read: Read = readText): number | null {
  const found = /^Pss:\s+(\d+) kB$/m.exec(read(`/proc/${pid}/smaps_rollup`) ?? "");
  return found ? Number(found[1]) * 1024 : null;
}

export interface CapStop { botId: string; at: number; usedBytes: number; capBytes: number; pids: number[] }

export interface WatchdogOptions {
  cap: () => number | null;
  list: () => readonly ProcessRow[];
  owners: () => readonly FootprintOwner[];
  pss?: (pid: number) => number | null;
  /** Closes the bot's browser the way an idle close does (its sign-ins saved); resolves once it is closed or given up. */
  closeBrowsers?: (botId: string) => Promise<void>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** What each pid's start is now (Linux's start tick), to signal only the process that was read. */
  startOf?: (pid: number) => string | null;
  log?: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
  graceMs?: number;
}

export class BotMemoryWatchdog {
  readonly #options: WatchdogOptions;
  readonly #strikes = new Map<string, number>();
  readonly #stops = new Map<string, CapStop>();
  /** Engine pids stopped, and when: a pid the system later gives to another engine is not one of them for long. */
  readonly #stoppedPids = new Map<number, number>();
  #stopping = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #count = 0;

  constructor(options: WatchdogOptions) { this.#options = options; }

  start(): void {
    if (this.#timer || this.#options.cap() === null) return;
    this.#timer = setInterval(() => void this.check(), this.#options.intervalMs ?? WATCHDOG_MS);
    this.#timer.unref?.();
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  /** One look at every bot; resolves with the bots stopped. */
  async check(): Promise<CapStop[]> {
    const cap = this.#options.cap();
    if (cap === null || this.#running) return [];
    this.#running = true;
    try {
      const rows = this.#options.list();
      const starts = new Map(rows.map((row) => [row.pid, row.start]));
      const { bots } = attributeRows(rows, this.#options.owners());
      for (const id of this.#strikes.keys()) if (!bots.has(id)) this.#strikes.delete(id);
      const over: Array<{ id: string; tally: BotTally; used: number }> = [];
      for (const [id, tally] of bots) {
        if (tally.rssBytes <= cap || this.#stopping.has(id)) { this.#strikes.delete(id); continue; }
        // Resident pages count what several processes share once each; their proportional share counts it once.
        const used = tally.pids.reduce((sum, pid) => sum + (this.#options.pss?.(pid) ?? rowRss(rows, pid)), 0);
        if (used <= cap) { this.#strikes.delete(id); continue; }
        const strikes = (this.#strikes.get(id) ?? 0) + 1;
        this.#strikes.set(id, strikes);
        if (strikes >= STRIKES || used >= cap * FAR_OVER) over.push({ id, tally, used });
      }
      return await Promise.all(over.map(({ id, tally, used }) => this.#stopBot(id, tally, used, cap, starts)));
    } finally { this.#running = false; }
  }

  async #stopBot(botId: string, tally: BotTally, usedBytes: number, capBytes: number, starts: ReadonlyMap<number, string>): Promise<CapStop> {
    const now = this.#options.now ?? Date.now, signal = this.#options.signal ?? ((pid, value) => process.kill(pid, value));
    const startOf = this.#options.startOf ?? (() => null);
    const stop: CapStop = { botId, at: now(), usedBytes, capBytes, pids: [...tally.pids] };
    this.#stopping.add(botId);
    this.#strikes.delete(botId);
    this.#stops.set(botId, stop);
    this.#count += 1;
    const browser = new Set(tally.browserPids);
    const engine = tally.pids.filter((pid) => !browser.has(pid));
    for (const [pid, at] of this.#stoppedPids) if (stop.at - at > EXPLAIN_FOR_MS) this.#stoppedPids.delete(pid);
    for (const pid of engine) this.#stoppedPids.set(pid, stop.at);
    (this.#options.log ?? ((line) => console.warn(line)))(`memory: bot ${botId} used ${Math.round(usedBytes / MB)} MB, more than the ${Math.round(capBytes / MB)} MB this server allows one bot; stopping its engine (${engine.length} processes)${browser.size ? " and closing its browser" : ""}`);
    // Only a process still the one that was read: a pid the system has given to another since is left alone.
    const same = (pid: number) => { const start = startOf(pid); return start === null || start === starts.get(pid); };
    const send = (pids: readonly number[], value: NodeJS.Signals) => { for (const pid of pids) if (same(pid)) try { signal(pid, value); } catch {} };
    try {
      send(engine, "SIGTERM");
      const closing = browser.size ? this.#options.closeBrowsers?.(botId).catch(() => undefined) : undefined;
      await new Promise((resolve) => { const timer = setTimeout(resolve, this.#options.graceMs ?? STOP_GRACE_MS); timer.unref?.(); });
      send(engine, "SIGKILL");
      await closing;
      // A browser that would not close (a turn still held it after its engine was gone) goes as the engine did.
      if (browser.size && !this.#options.closeBrowsers) send([...browser], "SIGKILL");
    } finally { this.#stopping.delete(botId); }
    return stop;
  }

  /** The last stop of this bot for memory, while a turn that failed because of it should say so. */
  stopOf(botId: string, at: number = Date.now()): CapStop | null {
    const stop = this.#stops.get(botId);
    if (!stop) return null;
    if (at - stop.at > EXPLAIN_FOR_MS) { this.#stops.delete(botId); return null; }
    return stop;
  }

  /** Whether this engine process was stopped for its bot's memory: its driver does not start it again at once. */
  stoppedPid(pid: number | undefined, at: number = Date.now()): boolean {
    const when = pid === undefined ? undefined : this.#stoppedPids.get(pid);
    return when !== undefined && at - when <= EXPLAIN_FOR_MS;
  }

  /** Bots stopped since the server started. */
  stops(): number { return this.#count; }
}

const rowRss = (rows: readonly ProcessRow[], pid: number) => rows.find((row) => row.pid === pid)?.rssBytes ?? 0;

/** The line a turn ends with when its bot was stopped for using more memory than one bot may. */
export function capStopFailure(botName: string, stop: CapStop): ReturnType<typeof noticeFailure> {
  return noticeFailure("chat.notice.botMemoryCap", { bot: botName, used: String(Math.round(stop.usedBytes / MB)), cap: String(Math.round(stop.capBytes / MB)) });
}

let watchdog: BotMemoryWatchdog | null = null;
let nameOf: (botId: string) => string = (botId) => botId;

/** The server's one watchdog, once started (host/bot-memory-cap-host.ts). */
export function useBotMemoryWatchdog(dog: BotMemoryWatchdog | null, botName?: (botId: string) => string): void {
  watchdog = dog;
  if (botName) nameOf = botName;
}

/** Whether this engine (`pid`) was stopped for its bot's memory (session-idle.ts stoppedForRoom). */
export const stoppedForBotMemory = (pid?: number): boolean => watchdog?.stoppedPid(pid) === true;

/**
 * Every engine's adapter: a turn of a bot the watchdog stopped for memory fails with that reason, never in silence or
 * as the engine's own failure. The instance is changed in place, as withEngineMemory does.
 */
export function withBotMemoryCap(instance: ProviderInstance, dog: () => BotMemoryWatchdog | null = () => watchdog, name: (botId: string) => string = (botId) => nameOf(botId),
  now: () => number = Date.now): ProviderInstance {
  const adapter = instance.adapter;
  const turns = new Map<string, { botId: string; at: number }>();
  const explained = new Set<string>();
  const stopFor = (threadId: string) => {
    const turn = turns.get(threadId), stop = turn ? dog()?.stopOf(turn.botId, now()) ?? null : null;
    return turn && stop && stop.at >= turn.at ? stop : null;
  };
  const present = (item: RuntimeEvent): RuntimeEvent[] => {
    if (item.type !== "runtime.error" && item.type !== "turn.completed") return [item];
    const stop = stopFor(item.threadId);
    if (stop && item.type === "runtime.error" && !explained.has(item.threadId)) {
      explained.add(item.threadId);
      return [{ ...item, ...capStopFailure(name(stop.botId), stop) }];
    }
    if (stop && item.type === "turn.completed" && !item.ok && item.stopReason !== "interrupted" && !explained.has(item.threadId)) {
      explained.add(item.threadId);
      const failure = capStopFailure(name(stop.botId), stop);
      return [{ eventId: newEventId(), provider: instance.driverKind, threadId: item.threadId, createdAt: new Date().toISOString(), turnId: item.turnId, type: "runtime.error", ...failure } as RuntimeEvent, item];
    }
    return [item];
  };
  adapter.onEvent((item) => {
    if (item.type !== "turn.completed") return;
    queueMicrotask(() => { turns.delete(item.threadId); explained.delete(item.threadId); });
  });
  (instance as { adapter: ProviderAdapter }).adapter = {
    ...adapter,
    onEvent: (listener) => adapter.onEvent((item) => { for (const shown of present(item)) listener(shown); }),
    sendTurn: async (input) => {
      if (input.botId) turns.set(input.threadId, { botId: input.botId, at: now() });
      explained.delete(input.threadId);
      return adapter.sendTurn(input);
    },
  };
  return instance;
}

export interface CapReport { mb: number | null; rung: CapRung; offered: CapRung[]; stops: number }
let report: () => CapReport = () => ({ mb: null, rung: "none", offered: [], stops: 0 });

/** Starts the server's watchdog where a cap is set and a process list can be read (Linux): the cap is worked out again
 * each look, as the most turns at once may change (a plan's limit arrives after start). */
export function startBotMemoryCap(deps: {
  gate: GateHost; turns: () => number | undefined; owners: () => readonly FootprintOwner[]; botName: (botId: string) => string;
  closeBrowsers: (botId: string) => Promise<void>; list: () => readonly ProcessRow[]; startOf: (pid: number) => string | null;
  env?: NodeJS.ProcessEnv; memoryBytes?: number; log?: (line: string) => void; platform?: NodeJS.Platform;
}): BotMemoryWatchdog | null {
  const env = deps.env ?? process.env, log = deps.log ?? ((line: string) => console.warn(line));
  let warned = false;
  const cap = () => botMemoryCapBytes(env, { gate: deps.gate, memoryBytes: deps.memoryBytes ?? boxMemory().bytes, ...(deps.turns() === undefined ? {} : { turns: deps.turns() }) },
    (line) => { if (!warned) { warned = true; log(`memory: ${line}`); } });
  const first = cap(), ladder = capLadder(first, { platform: deps.platform ?? process.platform });
  const dog = ladder.rung === "watchdog" ? new BotMemoryWatchdog({ cap, list: deps.list, owners: deps.owners, pss: (pid) => pssBytes(pid), closeBrowsers: deps.closeBrowsers, startOf: deps.startOf, log }) : null;
  report = () => ({ mb: dog ? Math.round((cap() ?? 0) / MB) || null : null, rung: dog ? ladder.rung : "none", offered: ladder.offered, stops: dog?.stops() ?? 0 });
  useBotMemoryWatchdog(dog, deps.botName);
  if (dog) {
    dog.start();
    const others = ladder.offered.filter((rung) => rung !== "watchdog");
    log(`memory: one bot may use up to ${Math.round((first ?? 0) / MB)} MB (${env[BOT_MEMORY_ENV]?.trim() ? BOT_MEMORY_ENV : "the default for this server's memory and turns"}); `
      + `this server checks every ${Math.round(WATCHDOG_MS / 1000)} s${others.length ? `; also offered here, not used yet: ${others.join(", ")}` : ""}`);
  }
  return dog;
}

/** The cap in force, how it is enforced and how often it stopped a bot: for the health report. */
export const botMemoryCapReport = (): CapReport => report();
