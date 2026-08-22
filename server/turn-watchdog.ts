// Stall watchdog for dispatched turns.
//
// ask_bot has a 4-minute ceiling, while room turns have a separately
// configurable absolute ceiling. The main 1:1 path had none: a wedged CLI
// (hung network call, dead MCP child,
// a provider that stops streaming without exiting) left its bot busy
// forever — composer locked, screen poller running — until an interrupt or
// an app restart. This watchdog watches ACTIVITY, not duration: a turn may
// legitimately run for an hour while events keep flowing, but a turn whose
// thread has emitted nothing at all for `stallMs` is wedged. Turns parked
// on a human approval are exempt — waiting on a person is not a stall.
export interface WatchedTurn {
  threadId: string;
  botId: string;
  startedAt: number;
  lastEventAt: number;
  waitingOnHuman: boolean;
}

export interface TurnWatchdogOptions {
  stallMs: number;
  checkMs: number;
  /** Called once per stalled turn, after the entry is removed. */
  onStall: (turn: WatchedTurn) => void;
  now?: () => number;
}

export class TurnWatchdog {
  private turns = new Map<string, WatchedTurn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: TurnWatchdogOptions;

  // a plain field assignment, not a parameter property — the server runs
  // under Node's type-stripping, which cannot transform the latter
  constructor(opts: TurnWatchdogOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
    // never hold the process open just to watch for stalls
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
  }

  /** A turn was dispatched on this thread. */
  watch(threadId: string, botId: string): void {
    const at = this.now();
    this.turns.set(threadId, { threadId, botId, startedAt: at, lastEventAt: at, waitingOnHuman: false });
  }

  /** Any provider event for the thread proves the turn is alive. */
  touch(threadId: string): void {
    const turn = this.turns.get(threadId);
    if (turn) turn.lastEventAt = this.now();
  }

  /** request.opened → true (a human is deciding; not a stall however long
   * they take); request.resolved → false (the clock restarts). */
  setWaitingOnHuman(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnHuman = waiting;
    turn.lastEventAt = this.now();
  }

  /** The turn settled normally — stop watching it. */
  settle(threadId: string): void {
    this.turns.delete(threadId);
  }

  watching(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  /** Visible for tests; the interval calls this. */
  sweep(): void {
    const at = this.now();
    for (const turn of this.turns.values()) {
      if (turn.waitingOnHuman) continue;
      if (at - turn.lastEventAt < this.opts.stallMs) continue;
      this.turns.delete(turn.threadId);
      this.opts.onStall(turn);
    }
  }
}
