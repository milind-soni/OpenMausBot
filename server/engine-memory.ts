// On a Cloud home each engine process and the MCP servers it starts take hundreds of MB, and a Linux machine without swap
// that runs out keeps reclaiming, unresponsive, long before its OOM killer acts.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { newEventId, newId, TurnNotStartedError, type ProviderAdapter, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "./contracts.ts";

const MB = 1024 * 1024;
const PAGE_BYTES = 4096;
/** What one engine and its MCP servers take until one has been measured here: `opencode acp` 1.19.3 measured 361 MB on a
 * Cloud home before its first prompt and 623 MB with six stdio MCP servers, and about 466 MB while working. */
export const ENGINE_DEFAULT_BYTES = 700 * MB;
const ENGINE_MIN_BYTES = 300 * MB, ENGINE_MAX_BYTES = 1500 * MB;
/** One more session in a running shared process: OpenCode 1.19.3 grew about 110 MB a session with three stdio MCP
 * servers after a prompt; more MCP servers cost more. */
export const SESSION_BYTES = 200 * MB;
/** One bot's browser (agent-browser's daemon and its Chrome) on a page or two: 270 to 390 MB per bot on an 8 GB Cloud home,
 * 2026-10-21. It runs outside the engine's process group, so an engine's measured size never includes it. */
export const BROWSER_BYTES = 400 * MB;
/** A new engine's share is held back this long while it starts and grows; it is measured once it has run this long. */
const RESERVE_MS = 90_000, SETTLED_MS = 30_000;
const TICK_MS = 2_000, RELIEF_COOLDOWN_MS = 15_000, NOTICE_REPEAT_MS = 10 * 60_000, STOP_GRACE_MS = 5_000;
/** Engines that run each thread's turns in processes of their own. */
export const ENGINE_PROCESS_KINDS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "opencodeGo", "grokAgent", "geminiAgent", "kimiAgent",
  "droidAgent", "cursorAgent", "qwenAgent", "hermesAgent", "clineAgent", "customAcp", "piAgent", "antigravityAgent"]);

export interface HostMemory { totalBytes: number; availableBytes: number; swapFreeBytes: number; oomKills: number | null; fullStall10: number | null }

const procText = (path: string) => readFileSync(path, "utf8");

/** /proc/meminfo, the kernel's OOM kill count and memory stall; null where there is no /proc (not Linux). */
export function readHostMemory(read: (path: string) => string = procText): HostMemory | null {
  let meminfo: string;
  try { meminfo = read("/proc/meminfo"); } catch { return null; }
  const field = (name: string) => { const found = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(meminfo); return found ? Number(found[1]) * 1024 : null; };
  const totalBytes = field("MemTotal"), availableBytes = field("MemAvailable");
  if (totalBytes === null || availableBytes === null) return null;
  const number = (path: string, pattern: RegExp) => { try { const found = pattern.exec(read(path)); return found ? Number(found[1]) : null; } catch { return null; } };
  return { totalBytes, availableBytes, swapFreeBytes: field("SwapFree") ?? 0,
    oomKills: number("/proc/vmstat", /^oom_kill (\d+)$/m), fullStall10: number("/proc/pressure/memory", /^full avg10=([\d.]+)/m) };
}

/** Resident bytes per process group (an engine and the MCP servers it started). Shared pages count once per process, so it
 * errs high. */
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
    groups.set(group, (groups.get(group) ?? 0) + (Number(fields[21]) * PAGE_BYTES || 0));
  }
  return groups;
}

const tasks = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;
const running = (count: number) => `${tasks(count)} ${count === 1 ? "is" : "are"} running on this Cloud`;
export const memoryStopText = (count: number) => `This Cloud ran out of memory while ${tasks(count)} ran at once, so this one was stopped. `
  + "It was not a problem with the AI provider. New tasks now wait until there is memory for them.";
export const memoryWaitText = (count: number) => `Waiting for memory: ${running(count)}, and one more could run it out of memory. `
  + "This one starts by itself when there is room.";
export const memoryStillWaitingText = (count: number) => `Still waiting for memory: ${running(count)}.`;
export const memoryStallText = (cause: string, count: number) => `${cause}. This Cloud ran out of memory while ${tasks(count)} ran at once (not a problem with the AI provider)`;

/** The bots' browsers, which start during a turn rather than with its engine. */
export interface EngineBrowsers {
  /** Whether this thread's bot may browse and its browser is not running yet. */
  starts(threadId: string): boolean;
  /** This thread's engine was stopped for memory: its browser can close too once no turn holds it. */
  stopped(threadId: string): void;
}

/** An engine process and the threads whose sessions it runs: one, or several when the driver shares processes. */
interface Engine { child: ChildProcess; threads: Set<string>; startedAt: number; stopping: boolean }
interface Waiter { wake: () => void }

export interface EngineMemoryOptions {
  enabled: boolean;
  read?: () => HostMemory | null;
  groups?: () => Map<number, number>;
  now?: () => number;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (line: string) => void;
  tickMs?: number;
}

export class EngineMemory {
  readonly enabled: boolean;
  private readonly read: () => HostMemory | null;
  private readonly groups: () => Map<number, number>;
  private readonly now: () => number;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly log: (line: string) => void;
  private readonly tickMs: number;
  private readonly context = new AsyncLocalStorage<string>();
  private readonly engines = new Map<number, Engine>();
  private readonly active = new Set<string>();
  /** Threads admitted in the last RESERVE_MS: when, and what they were let in for. */
  private readonly reserved = new Map<string, { at: number; start: "process" | "session"; browser: boolean; browserSince?: number }>();
  private readonly queue: Waiter[] = [];
  /** Threads whose engine was stopped for memory: how many tasks ran then. */
  private readonly stops = new Map<string, number>();
  /** Threads that ran while memory was short: the most tasks running then. */
  private readonly pressure = new Map<string, number>();
  private oomKills: number | null = null;
  private lastRelief = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private browsers: EngineBrowsers | null = null;

  constructor(options: EngineMemoryOptions) {
    this.enabled = options.enabled;
    this.read = options.read ?? (() => readHostMemory());
    this.groups = options.groups ?? (() => processGroupBytes());
    this.now = options.now ?? Date.now;
    this.signal = options.signal ?? ((pid, signal) => process.kill(-pid, signal));
    this.log = options.log ?? ((line) => console.warn(`memory: ${line}`));
    this.tickMs = options.tickMs ?? TICK_MS;
  }

  useBrowsers(browsers: EngineBrowsers): void { this.browsers = browsers; }

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
    child.once("exit", (_code, signal) => this.exited(pid, engine, signal));
    this.arm();
  }

  /** A thread's session now runs in this already tracked engine process. */
  attach(child: ChildProcess, threadId: string): void {
    if (child.pid) this.engines.get(child.pid)?.threads.add(threadId);
  }

  detach(child: ChildProcess, threadId: string): void {
    if (child.pid) this.engines.get(child.pid)?.threads.delete(threadId);
  }

  turnStarted(threadId: string): void { if (this.enabled) this.active.add(threadId); }

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
    this.stops.delete(threadId);
    this.wake();
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

  /** Resolves once a new engine process, or a session in the running one `joining` names by pid, fits for this thread;
   * `notify` tells the person when it has to wait. False when aborted. A thread joining a process counts on it at once, so
   * that process is never stopped as idle to make room for its own new session. */
  async admit(threadId: string, abort: AbortSignal, notify: (text: string) => void, start: "process" | "session" = "process",
    joining?: number): Promise<boolean> {
    if (!this.enabled) return true;
    if (joining !== undefined) this.engines.get(joining)?.threads.add(threadId);
    const waiter: Waiter = { wake: () => {} };
    this.queue.push(waiter);
    let announced: number | null = null;
    try {
      for (;;) {
        if (abort.aborted) return false;
        if (this.queue[0] === waiter) {
          const room = this.room(start, threadId);
          if (room === "admit") {
            this.reserved.set(threadId, { at: this.now(), start, browser: this.browserStarts(threadId) });
            this.arm();
            return true;
          }
          if (room !== "wait") { await this.stop(room, "idle"); continue; }
        }
        if (announced === null || this.now() - announced >= NOTICE_REPEAT_MS) {
          const others = this.othersBusy(threadId);
          notify(announced === null ? memoryWaitText(others) : memoryStillWaitingText(others));
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
      this.wake();
    }
  }

  /** The sentence for a turn of this thread whose engine was stopped for memory; null when it was not. */
  stopText(threadId: string): string | null {
    const count = this.stops.get(threadId);
    return count === undefined ? null : memoryStopText(count);
  }

  /** A stalled turn's cause, saying so when memory ran short while it ran. */
  stallCause(threadId: string, cause: string): string {
    const count = this.stops.get(threadId) ?? this.pressure.get(threadId);
    return count === undefined ? cause : memoryStallText(cause, count);
  }

  /** Every couple of seconds while engines run: notes short memory against the running turns, and stops an engine before
   * the machine runs out: an idle one first, else the newest of two or more busy ones. */
  tick(): void {
    const memory = this.read();
    if (!memory) return;
    // The kernel's OOM killer just stopped something (an engine first: oom-score.ts): its memory comes back first.
    const killed = memory.oomKills !== null && this.oomKills !== null && memory.oomKills > this.oomKills;
    this.oomKills = memory.oomKills ?? this.oomKills;
    if (killed) return;
    const free = this.free(memory), count = this.busy();
    if (free < this.floor(memory)) for (const threadId of this.active) this.pressure.set(threadId, Math.max(this.pressure.get(threadId) ?? 1, count));
    const critical = free < Math.max(160 * MB, memory.totalBytes * 0.04) || ((memory.fullStall10 ?? 0) >= 40 && free < this.floor(memory));
    if (!critical || this.now() - this.lastRelief < RELIEF_COOLDOWN_MS) return;
    const idle = this.idle();
    const newest = [...this.engines.values()].filter((engine) => !engine.stopping && this.working(engine).length).sort((a, b) => b.startedAt - a.startedAt);
    const victim = idle ?? (newest.length >= 2 ? newest[0]! : null);
    if (!victim) return;
    this.lastRelief = this.now();
    if (idle) { void this.stop(victim, "idle"); return; }
    const stopped = this.working(victim);
    for (const threadId of stopped) this.stops.set(threadId, count);
    void this.stop(victim, "relief").then(() => this.closeBrowsers(stopped));
  }

  /** How much of an idle engine's keep-alive memory allows: 1 with half the machine free above the floor, down to a tenth
   * as it runs out; 1 where memory can't be read or the gate is off. */
  headroom(): number {
    const memory = this.enabled ? this.read() : null;
    if (!memory) return 1;
    return Math.min(1, Math.max(0.1, (this.free(memory) - this.floor(memory)) / (memory.totalBytes / 2)));
  }

  /** Memory the server, Chrome and the page cache keep: below it a machine without swap starts to thrash. */
  private floor(memory: HostMemory): number { return Math.max(320 * MB, memory.totalBytes * 0.1); }

  private free(memory: HostMemory): number { return memory.availableBytes + memory.swapFreeBytes / 2; }

  private working(engine: Engine): string[] {
    return [...engine.threads].filter((threadId) => this.active.has(threadId));
  }

  private idle(): Engine | null {
    return [...this.engines.values()].filter((engine) => !engine.stopping && !this.working(engine).length)
      .sort((a, b) => a.startedAt - b.startedAt)[0] ?? null;
  }

  private room(start: "process" | "session", threadId: string): "admit" | "wait" | Engine {
    const memory = this.read();
    if (!memory) return "admit";
    const groups = this.groups(), at = this.now();
    const live = [...this.engines.entries()].filter(([, engine]) => !engine.stopping);
    const measured = live.filter(([, engine]) => at - engine.startedAt >= SETTLED_MS).map(([pid]) => groups.get(pid)).filter((bytes) => bytes !== undefined);
    const process = Math.min(ENGINE_MAX_BYTES, Math.max(ENGINE_MIN_BYTES, measured.length ? measured.reduce((sum, bytes) => sum + bytes, 0) / measured.length : ENGINE_DEFAULT_BYTES));
    let held = 0;
    for (const [threadId, admitted] of this.reserved) {
      if (at - admitted.at >= RESERVE_MS) { this.reserved.delete(threadId); continue; }
      // A browser grows as it starts and loads its first pages: its share is held until it has run SETTLED_MS.
      if (admitted.browser) {
        if (!this.browserStarts(threadId)) admitted.browserSince ??= at;
        if (admitted.browserSince === undefined || at - admitted.browserSince < SETTLED_MS) held += BROWSER_BYTES;
      }
      // A session's growth hides inside its shared process's total, so it stays held in full until it settles.
      if (admitted.start === "session") { held += SESSION_BYTES; continue; }
      const pid = live.find(([, engine]) => engine.threads.has(threadId))?.[0];
      held += Math.max(0, process - (pid === undefined ? 0 : groups.get(pid) ?? 0));
    }
    const need = (start === "session" ? SESSION_BYTES : process) + (this.browserStarts(threadId) ? BROWSER_BYTES : 0);
    if (this.free(memory) - this.floor(memory) - held >= need) return "admit";
    return this.idle() ?? (this.othersBusy(threadId) === 0 ? "admit" : "wait");
  }

  private browserStarts(threadId: string): boolean { return this.browsers?.starts(threadId) === true; }

  private closeBrowsers(threadIds: string[]): void { for (const threadId of threadIds) this.browsers?.stopped(threadId); }

  private async stop(engine: Engine, why: "idle" | "relief"): Promise<void> {
    const pid = engine.child.pid!, gone = () => engine.child.exitCode !== null || engine.child.signalCode !== null;
    engine.stopping = true;
    this.log(`stopping ${why === "idle" ? "an idle engine" : "the newest engine"} (pid ${pid}) to free memory; ${tasks(this.busy())} running`);
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
    if (signal === "SIGKILL" && !engine.stopping && working.length) {
      const kills = this.read()?.oomKills ?? null;
      if (kills !== null && this.oomKills !== null && kills > this.oomKills) {
        for (const threadId of working) this.stops.set(threadId, this.busy(threadId));
        this.log(`the kernel stopped an engine (pid ${pid}) for memory`);
        this.closeBrowsers(working);
      }
      this.oomKills = kills ?? this.oomKills;
    }
    if (!this.engines.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    this.wake();
  }

  private wake(): void { for (const waiter of this.queue) waiter.wake(); }

  private arm(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }
}

export const engineMemory = new EngineMemory({ enabled: (process.env.OMB_CLOUD_ROLE === "home" || process.env.OMB_CLOUD_ROLE === "team") && process.platform === "linux" });

/**
 * One engine's adapter on a Cloud home: a turn that needs a new engine process waits for memory first (saying so in the
 * chat, and again every ten minutes, which also keeps both stall checks from firing), and a turn whose engine was stopped
 * for memory fails with that reason. The instance is changed in place: its `models` may be a getter a copy would freeze.
 */
export function withEngineMemory(instance: ProviderInstance, memory: EngineMemory = engineMemory): ProviderInstance {
  if (!memory.enabled || !ENGINE_PROCESS_KINDS.has(instance.driverKind)) return instance;
  const adapter = instance.adapter;
  const listeners = new Set<RuntimeEventListener>();
  const waiting = new Map<string, AbortController>();
  const explained = new Set<string>();
  const event = (threadId: string, fields: Record<string, unknown>) =>
    ({ eventId: newEventId(), provider: instance.driverKind, threadId, createdAt: new Date().toISOString(), ...fields }) as RuntimeEvent;
  adapter.onEvent((item) => {
    if (item.type !== "turn.completed") return;
    // Once every listener has seen this event: they read the stop while it is delivered.
    queueMicrotask(() => { explained.delete(item.threadId); memory.turnEnded(item.threadId); });
  });
  const present = (item: RuntimeEvent): RuntimeEvent[] => {
    const stopped = memory.stopText(item.threadId);
    if (!stopped) return [item];
    if (item.type === "runtime.error") {
      explained.add(item.threadId);
      return [{ ...item, message: `${stopped} (${item.message.slice(0, 200)})` }];
    }
    if (item.type === "turn.completed" && !item.ok && !explained.has(item.threadId)) {
      explained.add(item.threadId);
      return [event(item.threadId, { turnId: item.turnId, type: "runtime.error", message: stopped }), item];
    }
    return [item];
  };
  (instance as { adapter: ProviderAdapter }).adapter = {
    ...adapter,
    onEvent: (listener) => {
      listeners.add(listener);
      const off = adapter.onEvent((item) => { for (const shown of present(item)) listener(shown); });
      return () => { listeners.delete(listener); off(); };
    },
    sendTurn: async (input) => {
      const { threadId } = input;
      const admit = async (start: "process" | "session", joining?: number) => {
        const controller = new AbortController();
        const executionSignal = input.executionContext?.signal;
        const cancel = () => controller.abort();
        executionSignal?.addEventListener("abort", cancel, { once: true });
        if (executionSignal?.aborted) controller.abort();
        waiting.get(threadId)?.abort();
        waiting.set(threadId, controller);
        try {
          await input.engineAdmission?.(start, joining);
          if (controller.signal.aborted) throw new TurnNotStartedError(newId(), "stopped while waiting for memory");
          const admitted = await memory.admit(threadId, controller.signal, (message) => {
            for (const listener of listeners) listener(event(threadId, { type: "runtime.notice", message }));
          }, start, joining);
          if (!admitted) throw new TurnNotStartedError(newId(), "stopped while waiting for memory");
        } finally {
          executionSignal?.removeEventListener("abort", cancel);
          if (waiting.get(threadId) === controller) waiting.delete(threadId);
        }
      };
      const driverAdmits = adapter.capabilities.engineAdmission === true;
      if (!driverAdmits && !memory.hasEngine(threadId)) await admit("process");
      memory.turnStarted(threadId);
      try {
        return await memory.within(threadId, () => adapter.sendTurn(driverAdmits ? { ...input, engineAdmission: admit } : input));
      } catch (error) {
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
