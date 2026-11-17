// How much of the server's memory one bot may use. By default this only watches and writes down: a bot over its cap is
// recorded ("would have stopped": its measured memory, the cap, its engines, the room left) in the health report's perf
// part and the server log, and nothing is signalled or closed. Only a number of MB set in OMB_BOT_MEMORY_MAX_MB makes it
// act, and then only when the server is short of memory, only on the bot using the most, and in steps: what the bot left
// running and its idle engines first, then (measured again, still over) its largest busy engine, never all at once; a
// stopped engine's conversations then have their browsers closed. A process several bots share, or one other
// conversations may join, is never stopped.
//
// The design's ladder is a systemd scope, then a delegated cgroup v2, then this server's own watchdog, then nothing (the
// desktop). The kernel rungs are probed and reported but not used yet: putting each bot's processes in a cgroup of its
// own needs the server moved into a leaf of its own first, which nothing here has verified on a real host. Every few
// seconds, while an engine runs, the watchdog reads the process list (no spawn), sums each bot's processes as the
// per-bot footprint attributes them (perf/bot-footprint.ts: never another bot's, never a shared process) and checks a bot
// over its cap by proportional set size (shared pages counted once).
import { accessSync, constants, existsSync, readFileSync } from "node:fs";

import { boxMemory } from "./box-memory.ts";
import { noticeFailure } from "./chat-notices.ts";
import { newEventId, type ProviderAdapter, type ProviderInstance, type RuntimeEvent } from "./contracts.ts";
import { BROWSER_BYTES, ENGINE_DEFAULT_BYTES } from "./engine-memory.ts";
import { attributeRows, type BotTally, type FootprintOwner, type FootprintUnit } from "./perf/bot-footprint.ts";
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
/** A bot over its cap this long (or, with memory short, on two looks in a row) is due. */
export const OVER_FOR_MS = 30_000;
/** This far over (by proportional size) with memory short, and one look is enough. */
const FAR_OVER = 1.5;
/** Room for engines below this share (EngineMemory.roomFactor: 1 with room to spare, down to 0.1) is pressure. */
export const PRESSURE_ROOM = 0.3;
/** A process's proportional size is read again after this long: a look every few seconds reads few files. */
const PSS_FRESH_MS = 15_000;
const STOP_GRACE_MS = 3_000;
/** A turn that fails this long after its engine was stopped for memory says so. */
const EXPLAIN_FOR_MS = 60_000;
/** The health report carries this many recent events; the server keeps a few more. */
export const EVENTS_SHOWN = 5;
const EVENTS_KEPT = 20;

export interface CapInputs {
  /** Where turns wait for room (process-room.ts gateHost): a Cloud home or a self-hosted Linux server; null on the desktop. */
  gate: GateHost;
  /** The memory the server may use: its container's limit, else the machine's. */
  memoryBytes: number;
  /** The most turns that run at once, where known. */
  turns?: number;
}

/** "log": watch and write down only (the default); "enforce": act, set by a number in OMB_BOT_MEMORY_MAX_MB. */
export type CapMode = "log" | "enforce";
/** The memory one engine of a bot may use: a bot with several engines running (several conversations) may use that many. */
export interface CapSetting { mode: CapMode; bytes: number }

/** OMB_BOT_MEMORY_MAX_MB: a number of MB to enforce (any Linux host, desktop included: the watchdog reads /proc); "off" or 0 for no watchdog at all;
 * unset or "auto" to only write down where a bot goes over the default, which is computed wherever turns wait for room
 * (never on the desktop): twice one bot's fair share of the memory (the memory over the turns that may run at once), at
 * least an engine at its largest with its browser, at most 80% of the memory. */
export function botMemoryCap(env: NodeJS.ProcessEnv, inputs: CapInputs, warn: (line: string) => void = () => undefined): CapSetting | null {
  const raw = env[BOT_MEMORY_ENV]?.trim().toLowerCase();
  if (raw === "off" || raw === "0") return null;
  if (raw && /^\d+$/.test(raw)) return { mode: "enforce", bytes: Math.max(SMALLEST_CAP_BYTES, Number(raw) * MB) };
  if (raw && raw !== "auto") warn(`${BOT_MEMORY_ENV}=${JSON.stringify(env[BOT_MEMORY_ENV])} is not a number of MB, "auto" or "off", so the default (watch only) is used`);
  if (inputs.gate === null || !(inputs.memoryBytes > 0)) return null;
  const turns = Math.max(1, inputs.turns ?? Math.floor(inputs.memoryBytes / ENGINE_DEFAULT_BYTES));
  const fair = (FAIR_SHARES * inputs.memoryBytes) / turns;
  return { mode: "log", bytes: Math.round(Math.min(inputs.memoryBytes * CAP_SHARE, Math.max(BOT_CAP_FLOOR_BYTES, fair))) };
}

export type CapRung = "systemd-scope" | "cgroup" | "watchdog" | "none";
type Read = (path: string) => string | null;
const readText: Read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const writable = (path: string) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } };

/** Which rungs of the ladder this host offers, best first, and the one in use (the watchdog wherever a cap is set and a
 * process list can be read: Linux). */
export function capLadder(cap: CapSetting | null, deps: { platform?: NodeJS.Platform; read?: Read; writable?: (path: string) => boolean; exists?: (path: string) => boolean } = {}): { rung: CapRung; offered: CapRung[] } {
  const platform = deps.platform ?? process.platform, read = deps.read ?? readText, canWrite = deps.writable ?? writable, exists = deps.exists ?? existsSync;
  if (platform !== "linux") return { rung: "none", offered: [] };
  const offered: CapRung[] = [];
  const own = /^0::(\/.*)$/m.exec(read("/proc/self/cgroup") ?? "")?.[1];
  const dir = own === undefined ? null : `/sys/fs/cgroup${own === "/" ? "" : own}`;
  const memory = dir !== null && /(^|\s)memory(\s|$)/.test(read(`${dir}/cgroup.controllers`) ?? "");
  if (memory && exists("/run/systemd/system") && /\.(service|scope)$/.test(own ?? "")) offered.push("systemd-scope");
  if (memory && dir !== null && canWrite(`${dir}/cgroup.subtree_control`) && canWrite(`${dir}/cgroup.procs`)) offered.push("cgroup");
  offered.push("watchdog");
  return { rung: cap === null ? "none" : "watchdog", offered };
}

/** A process's proportional set size from /proc/<pid>/smaps_rollup; null where it can't be read. */
export function pssBytes(pid: number, read: Read = readText): number | null {
  const found = /^Pss:\s+(\d+) kB$/m.exec(read(`/proc/${pid}/smaps_rollup`) ?? "");
  return found ? Number(found[1]) * 1024 : null;
}

/** The server's room when the watchdog looks: engine-memory's room factor (1 with room to spare, down to 0.1), whether
 * admission would hold a new engine back (memory below its floor), and the memory free, where read. */
export interface CapPressure { room: number; short: boolean; freeBytes: number | null }

/** What the watchdog did, or would have done, about one bot: bot ids and numbers only. */
export interface CapEvent {
  at: number;
  botId: string;
  usedMB: number;
  /** "pss": every process's proportional size read; "estimated": some read as resident size, which errs high. */
  measured: "pss" | "estimated";
  /** The cap for this bot now: the cap for one engine times its engines running. */
  capMB: number;
  engines: number;
  room: number;
  freeMB: number | null;
  /** Whether the server was short of memory then: the opt-in cap acts only then. */
  pressure: boolean;
  /** logged: watch only (the default); held: an opt-in cap with room to spare; idle: stopped what it left running and its
   * idle engines; engine: stopped its largest busy engine; nothing: all it runs may serve other conversations. */
  action: "logged" | "held" | "idle" | "engine" | "nothing";
}

/** An engine stopped for its bot's memory: the conversations it ran, for the line their turn ends with. */
export interface CapStop { at: number; pid: number; threads: readonly string[]; botId: string; usedBytes: number; capBytes: number }

/** Conversations with a turn running now, as every engine's adapter sees them (withBotMemoryCap). */
const runningTurns = new Set<string>();

export interface WatchdogOptions {
  cap: () => CapSetting | null;
  list: () => readonly ProcessRow[];
  owners: () => readonly FootprintOwner[];
  pressure: () => CapPressure;
  pss?: (pid: number) => number | null;
  /** Closes the browsers of these conversations (their stopped engines') the way a memory stop closes one: its sign-ins
   * saved, once no turn holds it. */
  closeBrowsers?: (threadIds: readonly string[]) => Promise<void>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** What each pid's start is now (Linux's start tick): only the process that was read is signalled. */
  startOf?: (pid: number) => string | null;
  /** Whether a conversation runs a turn now; every engine's adapter tells by default. */
  busy?: (threadId: string) => boolean;
  log?: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
  graceMs?: number;
}

const mb = (bytes: number) => Math.round(bytes / MB);

export class BotMemoryWatchdog {
  readonly #options: WatchdogOptions;
  /** By bot: since when it has been over its cap, how many looks in a row, and whether its first step was taken. */
  readonly #over = new Map<string, { since: number; looks: number; logged: boolean; stepped: boolean }>();
  readonly #pss = new Map<number, { start: string; bytes: number | null; at: number }>();
  /** Engines stopped, by pid: a pid the system later gives to another engine is not one of them for long. */
  readonly #stopped = new Map<number, CapStop>();
  readonly #events: CapEvent[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #acting: Promise<unknown> = Promise.resolve();
  #running = false;
  #stops = 0;
  #flagged = 0;

  constructor(options: WatchdogOptions) { this.#options = options; }

  start(): void {
    if (this.#timer || this.#options.cap() === null) return;
    this.#timer = setInterval(() => void this.tick(), this.#options.intervalMs ?? WATCHDOG_MS);
    this.#timer.unref?.();
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  /** The timer's body: never rejects (an unhandled rejection every few seconds would restart the server). */
  async tick(): Promise<void> {
    try { await this.check(); } catch (error) { this.#log(`memory: the per-bot check failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  #log(line: string): void { try { (this.#options.log ?? ((text) => console.warn(text)))(line); } catch {} }

  /** One look at every bot; resolves with what it did or would have done. */
  async check(): Promise<CapEvent[]> {
    if (this.#running) return [];
    this.#running = true;
    try { return await this.#look(); } finally { this.#running = false; }
  }

  async #look(): Promise<CapEvent[]> {
    const setting = this.#options.cap();
    if (setting === null) return [];
    const owners = this.#options.owners();
    // Nothing a bot runs without an engine is worth a look.
    if (!owners.some((owner) => owner.kind === "engine" && !owner.exited)) { this.#over.clear(); return []; }
    const now = (this.#options.now ?? Date.now)();
    const rows = this.#options.list();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    for (const pid of this.#pss.keys()) if (!byPid.has(pid)) this.#pss.delete(pid);
    const { bots } = attributeRows(rows, owners);
    for (const id of this.#over.keys()) if (!bots.has(id)) this.#over.delete(id);
    const due: Array<{ id: string; tally: BotTally; used: number; estimated: boolean; cap: number; sizes: Map<number, number> }> = [];
    let pressure: CapPressure | null = null;
    /** The bot over its cap using the most, due or not: the opt-in cap acts on no other. */
    let largest: { id: string; used: number } | null = null;
    for (const [id, tally] of bots) {
      const cap = setting.bytes * Math.max(1, tally.engines);
      if (tally.rssBytes <= cap) { this.#over.delete(id); continue; }
      // Resident pages count what several processes share once each; their proportional share counts it once. Where a
      // process's share can't be read (another user's, a sandboxed one), its resident pages stand in; they err high, so
      // a bot counted that way is due only when it is far over.
      let used = 0, estimated = false;
      const sizes = new Map<number, number>();
      for (const pid of tally.pids) {
        const share = this.#share(pid, byPid.get(pid), now);
        if (share === null) estimated = true;
        const size = share ?? byPid.get(pid)?.rssBytes ?? 0;
        sizes.set(pid, size);
        used += size;
      }
      if (used <= cap || (estimated && used < cap * FAR_OVER)) { this.#over.delete(id); continue; }
      if (!largest || used > largest.used) largest = { id, used };
      const over = this.#over.get(id) ?? { since: now, looks: 0, logged: false, stepped: false };
      over.looks += 1;
      this.#over.set(id, over);
      pressure ??= this.#options.pressure();
      // Far over counts at once only before a first step: after one, the next waits for two new measures.
      const long = now - over.since >= OVER_FOR_MS, critical = pressure.short && (over.looks >= 2 || (!over.stepped && !estimated && used >= cap * FAR_OVER));
      if (long || critical) due.push({ id, tally, used, estimated, cap, sizes });
    }
    if (!due.length || pressure === null) return [];
    const pressed = pressure.short || pressure.room < PRESSURE_ROOM;
    const event = (bot: (typeof due)[number], action: CapEvent["action"]): CapEvent => ({
      at: now, botId: bot.id, usedMB: mb(bot.used), measured: bot.estimated ? "estimated" : "pss", capMB: mb(bot.cap), engines: bot.tally.engines,
      room: Math.round(pressure!.room * 100) / 100, freeMB: pressure!.freeBytes === null ? null : mb(pressure!.freeBytes), pressure: pressed, action,
    });
    due.sort((a, b) => b.used - a.used);
    if (setting.mode === "log" || !pressed) {
      // Each bot written down once while it stays over: a bot over for an hour is one event, not seven hundred.
      const noted: CapEvent[] = [];
      for (const bot of due) {
        const over = this.#over.get(bot.id)!;
        if (over.logged) continue;
        over.logged = true;
        noted.push(event(bot, setting.mode === "log" ? "logged" : "held"));
        this.#note(noted.at(-1)!, setting.mode === "log"
          ? "watch only, nothing stopped (set OMB_BOT_MEMORY_MAX_MB to a number of MB to enforce)"
          : "nothing stopped: the server has room to spare");
      }
      return noted;
    }
    // Only the bot using the most: one that is waiting for a new measure after a step keeps the others waiting too.
    const top = due[0]!;
    if (top.id !== largest?.id) return [];
    const over = this.#over.get(top.id)!;
    // Only engines are stopped: a browser goes with the engines of its conversations (it is closed once their turn lets
    // it go), so a browser a running turn holds is never the step, and a Team Cloud's other members keep theirs.
    const engines = [...top.tally.units.values()].filter((unit) => unit.kind === "engine" && !unit.shareable);
    const busy = this.#options.busy ?? ((threadId: string) => runningTurns.has(threadId));
    const first = over.stepped ? [] : engines.filter((unit) => unit.exited || !unit.threads.some(busy));
    const size = (unit: FootprintUnit) => unit.pids.reduce((sum, pid) => sum + (top.sizes.get(pid) ?? 0), 0);
    const largestBusy = engines.filter((unit) => !unit.exited).sort((a, b) => size(b) - size(a))[0];
    const step = first.length ? { action: "idle" as const, units: first } : largestBusy ? { action: "engine" as const, units: [largestBusy] } : null;
    if (!step) {
      // All it runs is shared or may be joined by other conversations: nothing it may stop, written down once.
      if (over.logged) return [];
      over.logged = true;
      const noted = event(top, "nothing");
      this.#note(noted, "nothing it may stop (its engines may serve other conversations)");
      return [noted];
    }
    // The next step waits for a new measure past the window (or memory still short on two looks).
    over.stepped = true;
    over.since = now;
    over.looks = 0;
    const done = event(top, step.action);
    this.#stops += 1;
    this.#note(done, step.action === "idle" ? `stopping what it left running and its idle engines (${step.units.length})` : "stopping its largest busy engine");
    for (const unit of step.units) {
      if (!unit.exited) this.#stopped.set(unit.root, { at: now, pid: unit.root, threads: [...unit.threads], botId: top.id, usedBytes: top.used, capBytes: top.cap });
    }
    for (const [pid, stop] of this.#stopped) if (now - stop.at > EXPLAIN_FOR_MS) this.#stopped.delete(pid);
    const starts = new Map(rows.map((row) => [row.pid, row.start]));
    await this.#signalUnits(top.id, step.units, starts);
    // Their conversations' browsers close on their own time (each waits for its stopped turn to let it go): the next look
    // does not wait.
    const threads = [...new Set(step.units.flatMap((unit) => unit.threads))];
    this.#acting = threads.length && this.#options.closeBrowsers ? this.#options.closeBrowsers(threads).catch(() => undefined) : Promise.resolve();
    return [done];
  }

  #note(event: CapEvent, what: string): void {
    this.#events.push(event);
    if (this.#events.length > EVENTS_KEPT) this.#events.splice(0, this.#events.length - EVENTS_KEPT);
    if (event.action === "logged" || event.action === "held") this.#flagged += 1;
    this.#log(`memory: bot ${event.botId} uses ${event.usedMB} MB (${event.measured === "pss" ? "proportional" : "estimated from resident"}), over the ${event.capMB} MB `
      + `one bot may use with ${event.engines} engine${event.engines === 1 ? "" : "s"} running; room ${event.room}, ${event.freeMB === null ? "free memory unknown" : `${event.freeMB} MB free`}: ${what}`);
  }

  /** A pid's proportional size, read again only when stale or the pid is another process now. */
  #share(pid: number, row: ProcessRow | undefined, now: number): number | null {
    if (!this.#options.pss) return null;
    const known = this.#pss.get(pid);
    if (known && row && known.start === row.start && now - known.at < PSS_FRESH_MS) return known.bytes;
    const bytes = this.#options.pss(pid);
    if (row) this.#pss.set(pid, { start: row.start, bytes, at: now });
    return bytes;
  }

  /** TERM to each unit's processes still the ones read; after the grace, the list is read and attributed again and KILL
   * goes only to what is still this bot's, through the same record, with the same start. */
  async #signalUnits(botId: string, units: readonly FootprintUnit[], starts: ReadonlyMap<number, string>): Promise<void> {
    if (!units.length) return;
    const signal = this.#options.signal ?? ((pid, value) => process.kill(pid, value));
    const startOf = this.#options.startOf ?? (() => null);
    // A pid whose start can't be read now, or reads as another's, is left alone.
    const same = (pid: number) => { const start = startOf(pid); return start !== null && start === starts.get(pid); };
    const send = (pids: readonly number[], value: NodeJS.Signals) => { for (const pid of pids) if (same(pid)) try { signal(pid, value); } catch {} };
    const roots = new Set(units.map((unit) => unit.root));
    send(units.flatMap((unit) => unit.pids), "SIGTERM");
    await new Promise((resolve) => { const timer = setTimeout(resolve, this.#options.graceMs ?? STOP_GRACE_MS); timer.unref?.(); });
    let still: number[] = [];
    try {
      const again = this.#options.list();
      const tally = attributeRows(again, this.#options.owners()).bots.get(botId);
      still = [...tally?.units.values() ?? []].filter((unit) => roots.has(unit.root) && !unit.shareable).flatMap((unit) => unit.pids)
        .filter((pid) => again.find((row) => row.pid === pid)?.start === starts.get(pid));
    } catch {}
    send(still, "SIGKILL");
  }

  /** The stop of the engine that ran this conversation, while its turn should say so. */
  stopFor(threadId: string, at: number = Date.now()): CapStop | null {
    for (const stop of this.#stopped.values()) if (stop.threads.includes(threadId) && at - stop.at <= EXPLAIN_FOR_MS) return stop;
    return null;
  }

  /** Whether this conversation's engine process (`pid`, the one that exited) was stopped for its bot's memory: its driver
   * does not start it again at once. */
  stoppedEngine(threadId: string, pid: number | undefined, at: number = Date.now()): boolean {
    const stop = pid === undefined ? undefined : this.#stopped.get(pid);
    return stop !== undefined && stop.threads.includes(threadId) && at - stop.at <= EXPLAIN_FOR_MS;
  }

  /** Resolves once the last step's browsers have closed: for tests. */
  closed(): Promise<unknown> { return this.#acting; }

  /** Steps taken since the server started (the opt-in cap only). */
  stops(): number { return this.#stops; }
  /** Bots written down as over their cap with nothing stopped. */
  flagged(): number { return this.#flagged; }
  /** The most recent events, newest last. */
  events(limit = EVENTS_SHOWN): CapEvent[] { return this.#events.slice(-limit); }
}

/** The line a turn ends with when its engine was stopped for its bot's memory. */
export function capStopFailure(botName: string, stop: Pick<CapStop, "usedBytes" | "capBytes">): ReturnType<typeof noticeFailure> {
  return noticeFailure("chat.notice.botMemoryCap", { bot: botName, used: String(mb(stop.usedBytes)), cap: String(mb(stop.capBytes)) });
}

let watchdog: BotMemoryWatchdog | null = null;
let nameOf: (botId: string) => string = (botId) => botId;

/** The server's one watchdog, once started (host/bot-memory-cap-host.ts). */
export function useBotMemoryWatchdog(dog: BotMemoryWatchdog | null, botName?: (botId: string) => string): void {
  watchdog = dog;
  if (botName) nameOf = botName;
}

/** Whether this conversation's engine (`pid`) was stopped for its bot's memory (session-idle.ts stoppedForRoom). */
export const stoppedForBotMemory = (threadId: string, pid?: number): boolean => watchdog?.stoppedEngine(threadId, pid) === true;

/**
 * Every engine's adapter: a turn whose engine the watchdog stopped for its bot's memory fails with that reason, never in
 * silence or as the engine's own failure; and the conversations running a turn, which the watchdog never takes for
 * idle. The instance is changed in place, as withEngineMemory does.
 */
export function withBotMemoryCap(instance: ProviderInstance, dog: () => BotMemoryWatchdog | null = () => watchdog, name: (botId: string) => string = (botId) => nameOf(botId),
  now: () => number = Date.now): ProviderInstance {
  const adapter = instance.adapter;
  const turns = new Map<string, number>();
  const explained = new Set<string>();
  const stopFor = (threadId: string) => {
    const at = turns.get(threadId), stop = at === undefined ? null : dog()?.stopFor(threadId, now()) ?? null;
    return at !== undefined && stop && stop.at >= at ? stop : null;
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
    runningTurns.delete(item.threadId);
    queueMicrotask(() => { turns.delete(item.threadId); explained.delete(item.threadId); });
  });
  (instance as { adapter: ProviderAdapter }).adapter = {
    ...adapter,
    onEvent: (listener) => adapter.onEvent((item) => { for (const shown of present(item)) listener(shown); }),
    sendTurn: async (input) => {
      turns.set(input.threadId, now());
      runningTurns.add(input.threadId);
      explained.delete(input.threadId);
      try { return await adapter.sendTurn(input); } catch (error) { runningTurns.delete(input.threadId); throw error; }
    },
  };
  return instance;
}

export interface CapReport {
  mb: number | null; mode: CapMode | null; rung: CapRung; offered: CapRung[];
  /** Steps the opt-in cap took, and bots written down as over with nothing stopped, since the server started. */
  stops: number; flagged: number;
  events: CapEvent[];
}
let report: () => CapReport = () => ({ mb: null, mode: null, rung: "none", offered: [], stops: 0, flagged: 0, events: [] });

/** Starts the server's watchdog where a cap is set and a process list can be read (Linux): the cap is worked out again
 * each look, as the most turns at once may change (a plan's limit arrives after start). */
export function startBotMemoryCap(deps: {
  gate: GateHost; turns: () => number | undefined; owners: () => readonly FootprintOwner[]; botName: (botId: string) => string;
  closeBrowsers: (threadIds: readonly string[]) => Promise<void>; list: () => readonly ProcessRow[]; startOf: (pid: number) => string | null; pressure: () => CapPressure;
  env?: NodeJS.ProcessEnv; memoryBytes?: number; log?: (line: string) => void; platform?: NodeJS.Platform;
}): BotMemoryWatchdog | null {
  const env = deps.env ?? process.env, log = deps.log ?? ((line: string) => console.warn(line));
  let warned = false;
  const cap = () => botMemoryCap(env, { gate: deps.gate, memoryBytes: deps.memoryBytes ?? boxMemory().bytes, ...(deps.turns() === undefined ? {} : { turns: deps.turns() }) },
    (line) => { if (!warned) { warned = true; log(`memory: ${line}`); } });
  const first = cap(), ladder = capLadder(first, { platform: deps.platform ?? process.platform });
  const dog = ladder.rung === "watchdog" ? new BotMemoryWatchdog({ cap, list: deps.list, owners: deps.owners, pressure: deps.pressure, pss: (pid) => pssBytes(pid), closeBrowsers: deps.closeBrowsers, startOf: deps.startOf, log }) : null;
  report = () => {
    const now = dog ? cap() : null;
    return { mb: now ? mb(now.bytes) : null, mode: now?.mode ?? null, rung: dog ? ladder.rung : "none", offered: ladder.offered, stops: dog?.stops() ?? 0, flagged: dog?.flagged() ?? 0, events: dog?.events() ?? [] };
  };
  useBotMemoryWatchdog(dog, deps.botName);
  if (dog && first) {
    dog.start();
    const others = ladder.offered.filter((rung) => rung !== "watchdog");
    log(`memory: one bot may use up to ${mb(first.bytes)} MB per engine it runs (${first.mode === "enforce" ? `${BOT_MEMORY_ENV}; enforced when memory runs short` : "the default for this server's memory and turns; watch only, nothing is stopped"}); `
      + `this server checks every ${Math.round(WATCHDOG_MS / 1000)} s while an engine runs${others.length ? `; also offered here, not used yet: ${others.join(", ")}` : ""}`);
  }
  return dog;
}

/** The cap in force, how it is enforced, and what it did or would have done: for the health report. */
export const botMemoryCapReport = (): CapReport => report();
