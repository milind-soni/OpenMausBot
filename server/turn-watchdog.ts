import type { RuntimeEvent } from "./contracts.ts";

// A turn whose thread emits nothing for stallMs is wedged; waiting on a person or a computer is not a stall.
// Drivers report a tool only when it starts and when it ends, so a turn with a tool running may stay silent for toolStallMs.
// Each tool also has a deadline of its own, toolStallMs of its own running time, that no other event on the turn extends:
// a hung tool beside a parallel one that keeps reporting still ends the turn. Only the part of a wait that fell within the
// tool's own lifetime is left out of that time, and a cap of twice the tool limit from its first start counts every wait:
// the waits are the turn's, not the tool's, so a hung tool beside one that keeps asking a person still ends.
export interface WatchedTurn {
  threadId: string;
  botId: string;
  startedAt: number;
  lastEventAt: number;
  waitingOnHuman: boolean;
  waitingOnComputer: boolean;
  /** Time the turn spent waiting on a person or a computer in waits that have ended; overlapping waits count once. */
  parkedMs: number;
  parkedSince: number | null;
  runningTools: Map<string, RunningTool>;
}

export interface RunningTool {
  startedAt: number;
  /** The turn's waited time when the tool started: what it waits from then on is the difference. */
  parkedBefore: number;
}

/** Which limit stopped the turn: the silence window, one tool's own running time, or one tool's cap including waits. */
export interface StallLimit {
  kind: "silence" | "tool" | "tool-cap";
  ms: number;
}

/** Says which limit stopped a turn, to start a sentence: "no activity for 20 minutes". */
export function stallDescription(limit: StallLimit): string {
  const minutes = Math.round(limit.ms / 60_000);
  return limit.kind === "tool-cap" ? `a tool ran too long: ${minutes} minutes since it started, waits included`
    : limit.kind === "tool" ? `a tool ran for ${minutes} minutes without finishing` : `no activity for ${minutes} minutes`;
}

// Number() also reads "Infinity" and "1e309" as numbers, and an endless limit would switch the watchdog off.
export function stallLimitMs(raw: string | undefined, fallback: number): number {
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

const parked = (turn: WatchedTurn): boolean => turn.waitingOnHuman || turn.waitingOnComputer;
const parkedTotal = (turn: WatchedTurn, at: number): number =>
  turn.parkedMs + (turn.parkedSince === null ? 0 : at - turn.parkedSince);

export interface TurnWatchdogOptions {
  stallMs: number;
  toolStallMs: number;
  checkMs: number;
  onStall: (turn: WatchedTurn, limit: StallLimit) => void;
  now?: () => number;
}

export class TurnWatchdog {
  private turns = new Map<string, WatchedTurn>();
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
    this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
  }

  watch(threadId: string, botId: string): void {
    const at = this.now();
    this.turns.set(threadId, { threadId, botId, startedAt: at, lastEventAt: at, waitingOnHuman: false, waitingOnComputer: false,
      parkedMs: 0, parkedSince: null, runningTools: new Map() });
  }

  observe(event: RuntimeEvent): void {
    const turn = this.turns.get(event.threadId);
    if (!turn) return;
    const at = this.now();
    turn.lastEventAt = at;
    if ((event.type !== "item.started" && event.type !== "item.completed") || event.itemType !== "tool" || !event.itemId) return;
    if (event.type === "item.completed") turn.runningTools.delete(event.itemId);
    else if (!turn.runningTools.has(event.itemId)) turn.runningTools.set(event.itemId, { startedAt: at, parkedBefore: parkedTotal(turn, at) });
  }

  setWaitingOnHuman(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (turn) this.park(turn, () => { turn.waitingOnHuman = waiting; });
  }

  setWaitingOnComputer(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (turn) this.park(turn, () => { turn.waitingOnComputer = waiting; });
  }

  private park(turn: WatchedTurn, update: () => void): void {
    const was = parked(turn);
    update();
    const at = this.now();
    turn.lastEventAt = at;
    if (!was && parked(turn)) turn.parkedSince = at;
    else if (was && !parked(turn)) {
      turn.parkedMs = parkedTotal(turn, at);
      turn.parkedSince = null;
    }
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

  sweep(): void {
    const at = this.now();
    const toolMs = Math.max(this.opts.stallMs, this.opts.toolStallMs);
    const capMs = 2 * toolMs;
    for (const turn of this.turns.values()) {
      const waited = parkedTotal(turn, at);
      let limit: StallLimit | null = null;
      // Enforced while the turn waits too: no wait extends the cap.
      for (const tool of turn.runningTools.values()) {
        if (at - tool.startedAt >= capMs) {
          limit = { kind: "tool-cap", ms: capMs };
          break;
        }
        if (at - tool.startedAt - (waited - tool.parkedBefore) >= toolMs) limit ??= { kind: "tool", ms: toolMs };
      }
      if (!limit && !parked(turn)) {
        const silentMs = turn.runningTools.size > 0 ? toolMs : this.opts.stallMs;
        if (!(at - turn.lastEventAt < silentMs)) limit = { kind: "silence", ms: silentMs };
      }
      if (!limit) continue;
      this.turns.delete(turn.threadId);
      this.opts.onStall(turn, limit);
    }
  }
}
