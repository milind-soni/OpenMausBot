import { processAlive } from "./browser-processes.ts";
import type { ProviderAdapter, RuntimeEvent } from "./contracts.ts";
import { sampleProcessTree, type ProcessSample } from "./drivers/acp/quiet-status.ts";
import { redactSecretsInText } from "../shared/redact.ts";

// A turn whose thread emits nothing for stallMs is wedged; waiting on a person or a computer is not a stall unless the
// turn's engine is known to have no process left. Drivers report a tool only when it starts and when it ends, so a turn
// with a tool running may stay silent for toolStallMs, and one whose shell command's processes keep using CPU is working,
// not silent, however long the command runs.
export interface WatchedTurn {
  threadId: string;
  botId: string;
  startedAt: number;
  lastEventAt: number;
  waitingOnHuman: boolean;
  waitingOnComputer: boolean;
  runningTools: Map<string, RunningTool>;
}

/** A tool call the turn's engine started and has not ended; command: the shell command it runs, when it runs one. */
export interface RunningTool {
  startedAt: number;
  command?: string;
}

/** The longest-running shell command of a turn, or undefined when no running tool runs one. */
function oldestCommand(turn: Partial<Pick<WatchedTurn, "runningTools">>): (RunningTool & { command: string }) | undefined {
  let oldest: RunningTool | undefined;
  for (const tool of turn.runningTools?.values() ?? []) {
    if (tool.command && (!oldest || tool.startedAt < oldest.startedAt)) oldest = tool;
  }
  return oldest as (RunningTool & { command: string }) | undefined;
}

/** The longest-running shell command of a turn stopped at stopAt, with the whole minutes it ran: what the person is told
 * looks stuck, with any secret in it scrubbed. null when no running tool runs a shell command. */
export function stuckCommand(turn: Partial<Pick<WatchedTurn, "runningTools">>, stopAt: number): { command: string; minutes: number } | null {
  const oldest = oldestCommand(turn);
  return oldest ? { command: redactSecretsInText(oldest.command), minutes: Math.max(1, Math.round((stopAt - oldest.startedAt) / 60_000)) } : null;
}

/** What the person is told when the watchdog stops a turn silent for silentMs: the shell command still running, with how
 * long it ran, so they know what looked stuck; otherwise how long the turn was silent. */
export function stallNotice(turn: Partial<Pick<WatchedTurn, "runningTools">>, silentMs: number, stopAt: number) {
  const stuck = stuckCommand(turn, stopAt);
  return stuck ? { key: "chat.notice.stalledCommand" as const, params: stuck } : { key: "chat.notice.stalled" as const, params: { minutes: Math.round(silentMs / 60_000) } };
}

// Number() also reads "Infinity" and "1e309" as numbers, and an endless limit would switch the watchdog off.
export function stallLimitMs(raw: string | undefined, fallback: number): number {
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/** The engine is known to run no process for the thread's turn: its driver tracks one and has none, or the one it names has
 * exited. A driver that tracks no process proves nothing, so this is false for it. */
export function engineProcessGone(adapter: Pick<ProviderAdapter, "enginePid"> | null | undefined, threadId: string, alive = processAlive): boolean {
  if (!adapter?.enginePid) return false;
  const pid = adapter.enginePid(threadId);
  return pid === undefined || !alive(pid);
}

/** The CPU time used by the processes the thread's engine started since `since` (what a tool call started then runs, not
 * the engine or its tool servers); null when the driver tracks no engine process or the time cannot be read. */
export async function engineCommandCpuMs(adapter: Pick<ProviderAdapter, "enginePid"> | null | undefined, threadId: string, since: number,
  sample: (pid: number, since: number) => Promise<ProcessSample> = sampleProcessTree): Promise<number | null> {
  const pid = adapter?.enginePid?.(threadId);
  return pid === undefined ? null : (await sample(pid, since)).cpuMs;
}

const SUSPENDED_SWEEPS = 3;

const parked = (turn: WatchedTurn): boolean => turn.waitingOnHuman || turn.waitingOnComputer;

export interface TurnWatchdogOptions {
  stallMs: number;
  toolStallMs: number;
  /** The silence that stops a parked turn whose engine is known to be gone: longer than any wait the harness bounds itself. */
  parkedStallMs: number;
  checkMs: number;
  /** The turn's engine is known to have no process left for it; absent or false, a parked turn waits on. */
  engineGone?: (turn: WatchedTurn) => boolean;
  /** The CPU time the processes of the turn's shell command started at `since` have used, null when unknown. Read once
   * per sweep after a turn running one has been silent for stallMs: time gained since the last read counts as an event. */
  commandCpuMs?: (turn: WatchedTurn, since: number) => Promise<number | null>;
  /** silentMs: the silence that stopped the turn, stallMs, toolStallMs or parkedStallMs. */
  onStall: (turn: WatchedTurn, silentMs: number) => void;
  /** The conversations shown working that nothing holds but a watched turn (no dispatch, engine or settling turn): one no
   * watched turn holds either is freed once it has stayed so for stallMs. */
  unheld?: { threads(): Iterable<{ threadId: string; botId: string }>; free(threadId: string, botId: string): void };
  now?: () => number;
}

export class TurnWatchdog {
  private turns = new Map<string, WatchedTurn>();
  private unheldSince = new Map<string, number>();
  /** Each turn's last read of its shell command's CPU time: the command it was read for (by start) and whether a read is out. */
  private cpu = new WeakMap<WatchedTurn, { since: number; ms: number | null; reading: boolean }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: TurnWatchdogOptions;

  // No parameter properties: Node's type-stripping cannot transform them.
  constructor(opts: TurnWatchdogOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    // Real time, not now(): a sleeping computer suspends the process while the wall clock runs on, so the timer fires
    // that much late, and that time was not the turns' silence.
    let lastTickAt = Date.now();
    this.timer = setInterval(() => {
      const at = Date.now();
      const gap = at - lastTickAt;
      lastTickAt = at;
      this.sweep(gap > SUSPENDED_SWEEPS * this.opts.checkMs ? gap : 0);
    }, this.opts.checkMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
    this.unheldSince.clear();
  }

  watch(threadId: string, botId: string): void {
    const at = this.now();
    this.turns.set(threadId, { threadId, botId, startedAt: at, lastEventAt: at, waitingOnHuman: false, waitingOnComputer: false,
      runningTools: new Map() });
  }

  observe(event: RuntimeEvent): void {
    const turn = this.turns.get(event.threadId);
    if (!turn) return;
    turn.lastEventAt = this.now();
    if ((event.type !== "item.started" && event.type !== "item.completed") || event.itemType !== "tool" || !event.itemId) return;
    if (event.type === "item.completed") turn.runningTools.delete(event.itemId);
    else turn.runningTools.set(event.itemId, { startedAt: turn.lastEventAt, ...(event.summary ? { command: event.summary } : {}) });
  }

  setWaitingOnHuman(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnHuman = waiting;
    turn.lastEventAt = this.now();
  }

  setWaitingOnComputer(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnComputer = waiting;
    turn.lastEventAt = this.now();
  }

  settle(threadId: string): void {
    this.turns.delete(threadId);
  }

  /** A Stop that discards the turn's later events leaves no way for a tool or a wait to report its end: watch the teardown as a fresh silent turn. */
  eventsDiscarded(threadId: string): void {
    const turn = this.turns.get(threadId);
    if (turn) this.watch(threadId, turn.botId);
  }

  watching(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  waiting(threadId: string): boolean {
    const turn = this.turns.get(threadId);
    return turn !== undefined && parked(turn);
  }

  /** A turn of this bot is answering now: running and not parked on a person or a computer. One that goes silent is
   * stopped by the sweep, so this never holds anything for longer than toolStallMs without events or a command's CPU use. */
  answering(botId: string): boolean {
    for (const turn of this.turns.values()) if (turn.botId === botId && !parked(turn)) return true;
    return false;
  }

  /**
   * sleptMs: the real time since the last sweep when the process was suspended; it is forgiven, not counted as silence.
   * It may include up to one checkMs of awake time, so a stall after a sleep is caught up to one checkMs late, the
   * same lag a sweep already has; never early.
   */
  sweep(sleptMs = 0): void {
    const at = this.now();
    for (const turn of this.turns.values()) {
      if (sleptMs) turn.lastEventAt = Math.min(at, turn.lastEventAt + sleptMs);
      const silentMs = this.silenceLimit(turn);
      if (silentMs === null) continue;
      if (at - turn.lastEventAt >= this.opts.stallMs) this.readCommandCpu(turn);
      if (at - turn.lastEventAt < silentMs) continue;
      this.turns.delete(turn.threadId);
      this.opts.onStall(turn, silentMs);
    }
    this.freeUnheld(at);
  }

  /** null: the turn may wait on, parked while its engine is not known to be gone. */
  private silenceLimit(turn: WatchedTurn): number | null {
    if (parked(turn)) return this.opts.engineGone?.(turn) ? this.opts.parkedStallMs : null;
    return turn.runningTools.size > 0 ? Math.max(this.opts.stallMs, this.opts.toolStallMs) : this.opts.stallMs;
  }

  /** Reads the CPU time of a silent turn's shell command; one whose time changed since the last read is working (it gained
   * some, or a process came or went, as a build's compiler runs do), and that counts as an event, so a command that keeps
   * working is never stopped and one that stops for toolStallMs is. */
  private readCommandCpu(turn: WatchedTurn): void {
    const read = this.opts.commandCpuMs, command = parked(turn) ? undefined : oldestCommand(turn);
    if (!read || !command) return;
    const last = this.cpu.get(turn);
    if (last?.reading) return;
    const since = command.startedAt, previous = last?.since === since ? last.ms : null;
    this.cpu.set(turn, { since, ms: previous, reading: true });
    void Promise.resolve().then(() => read(turn, since)).catch(() => null).then((ms) => {
      // A read that failed keeps the last one to compare with.
      this.cpu.set(turn, { since, ms: ms ?? previous, reading: false });
      if (ms !== null && previous !== null && ms !== previous && this.turns.get(turn.threadId) === turn) turn.lastEventAt = Math.max(turn.lastEventAt, this.now());
    });
  }

  private freeUnheld(at: number): void {
    const unheld = this.opts.unheld;
    if (!unheld) return;
    const still = new Map<string, number>();
    for (const { threadId, botId } of unheld.threads()) {
      if (this.turns.has(threadId)) continue;
      const since = this.unheldSince.get(threadId) ?? at;
      if (at - since < this.opts.stallMs) still.set(threadId, since);
      else unheld.free(threadId, botId);
    }
    this.unheldSince = still;
  }
}
