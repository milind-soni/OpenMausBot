import {
  MAX_MCP_CALL_TIMEOUT_MINUTES,
  MAX_ROOM_TURN_TIMEOUT_MINUTES,
  MIN_ROOM_TURN_TIMEOUT_MINUTES,
} from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { serverLine } from "./server-lines.ts";

/** What the engine sends while it works. Retries, session news and cards are not progress. */
export const ROOM_TURN_PROGRESS = new Set<RuntimeEvent["type"]>([
  "content.delta", "item.started", "item.updated", "item.completed", "item.output", "turn.progress",
]);

export function roomTurnTimeoutMs(minutes: number): number {
  return minutes * 60_000;
}

export function parseConversationTurnTimeout(
  value: unknown,
): { ok: true; minutes: number | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, minutes: null };
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_ROOM_TURN_TIMEOUT_MINUTES ||
    value > MAX_ROOM_TURN_TIMEOUT_MINUTES
  ) {
    return {
      ok: false,
      error: "Turn limit must be a whole number from 1 to 1,440, or null to use the group default.",
    };
  }
  return { ok: true, minutes: value };
}

export function effectiveRoomTurnTimeoutMinutes(
  globalMinutes: number,
  override: number | null | undefined,
): number {
  if (
    typeof override === "number" &&
    Number.isInteger(override) &&
    override >= MIN_ROOM_TURN_TIMEOUT_MINUTES &&
    override <= MAX_ROOM_TURN_TIMEOUT_MINUTES
  ) {
    return override;
  }
  return globalMinutes;
}

/** How long a turn may show nothing while one of its tools runs: as long as an MCP call may be set to take. */
export const ROOM_TOOL_QUIET_LIMIT_MS = MAX_MCP_CALL_TIMEOUT_MINUTES * 60_000;

export const ROOM_TURN_CLOCK_LOOK_MS = 5_000;
/** Two looks more than this many periods apart: the process was suspended or its event loop blocked, which no timer can
 * tell apart, and neither is the turn's silence. On macOS (Electron 43) Node's timers and monotonic clock keep counting
 * while the computer sleeps, so a deadline due during the sleep fires the moment it wakes: only the gap between looks
 * tells the sleep apart. */
const SUSPENDED_LOOKS = 3;

export interface RoomTurnClock {
  now(): number;
  /** Returns the cancel. */
  after(ms: number, run: () => void): () => void;
  /** Returns the cancel. */
  every(ms: number, run: () => void): () => void;
}

const systemClock: RoomTurnClock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  every: (ms, run) => {
    const timer = setInterval(run, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/** Stops a turn that shows no progress for the limit, or for ROOM_TOOL_QUIET_LIMIT_MS while a tool runs; the clock
 * holds while the turn waits on a person or the computer, and while the computer sleeps; stray ends clamp the count at
 * zero. */
export class RoomTurnDeadline {
  private limitMs: number;
  private clock: RoomTurnClock;
  private progressAt = 0;
  private heldAt = 0;
  private lookedAt = 0;
  private stopLooking: (() => void) | null = null;
  private cancelTimer: (() => void) | null = null;
  private openWaits = 0;
  private runningTools = new Set<string>();
  private stopped = false;
  private fired = false;
  private fire: () => void;

  // No parameter properties: Node's type-stripping cannot transform them.
  constructor(minutes: number, fire: () => void, clock: RoomTurnClock = systemClock) {
    this.limitMs = roomTurnTimeoutMs(minutes);
    this.fire = fire;
    this.clock = clock;
  }

  start(): void {
    if (this.stopped || this.fired || this.stopLooking !== null) return;
    this.progressAt = this.clock.now();
    this.lookedAt = this.progressAt;
    this.stopLooking = this.clock.every(ROOM_TURN_CLOCK_LOOK_MS, () => this.discountSleep());
    this.arm();
  }

  observe(e: RuntimeEvent): void {
    this.discountSleep();
    if (ROOM_TURN_PROGRESS.has(e.type)) this.progress();
    if (e.type === "request.opened" || e.type === "turn.wait_started") this.setWaiting(true);
    else if (e.type === "request.resolved" || e.type === "turn.wait_ended") this.setWaiting(false);
    else if ((e.type === "item.started" || e.type === "item.completed") && e.itemType === "tool" && e.itemId) {
      if (e.type === "item.started") this.runningTools.add(e.itemId);
      else this.runningTools.delete(e.itemId);
      this.rearm();
    }
  }

  progress(): void {
    // A delayed event loop can deliver progress after the limit, before the timer ran: it must not revive an idle turn.
    if (this.cancelTimer !== null && this.idleMs() >= this.quietLimitMs()) {
      this.expired();
      return;
    }
    this.progressAt = this.clock.now();
  }

  setWaiting(waiting: boolean): void {
    if (this.stopped || this.fired) return;
    this.discountSleep();
    if (waiting) {
      const wasIdle = this.openWaits === 0;
      this.openWaits += 1;
      if (wasIdle) this.hold();
    } else if (this.openWaits > 0) {
      this.openWaits -= 1;
      if (this.openWaits === 0) {
        // The wait paused the clock: idle time from before it still counts, progress during it counts as now.
        const idleBefore = this.progressAt >= this.heldAt ? 0 : this.heldAt - this.progressAt;
        this.progressAt = this.clock.now() - idleBefore;
        this.arm();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.release();
  }

  private release(): void {
    this.stopLooking?.();
    this.stopLooking = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** A look late enough moves the turn's progress, and a wait's start, on by the whole gap. */
  private discountSleep(): void {
    if (this.stopLooking === null) return;
    const at = this.clock.now();
    const gapMs = at - this.lookedAt;
    this.lookedAt = at;
    if (gapMs <= SUSPENDED_LOOKS * ROOM_TURN_CLOCK_LOOK_MS) return;
    this.progressAt = Math.min(at, this.progressAt + gapMs);
    if (this.openWaits > 0) this.heldAt = Math.min(at, this.heldAt + gapMs);
  }

  private idleMs(): number {
    this.discountSleep();
    return this.clock.now() - this.progressAt;
  }

  private quietLimitMs(): number {
    return this.runningTools.size > 0 ? Math.max(this.limitMs, ROOM_TOOL_QUIET_LIMIT_MS) : this.limitMs;
  }

  private hold(): void {
    this.heldAt = this.clock.now();
    if (this.cancelTimer === null) return;
    this.cancelTimer();
    this.cancelTimer = null;
    // A delayed event loop can deliver the wait after the deadline: a wait must not revive an idle turn.
    if (this.idleMs() >= this.quietLimitMs()) this.expired();
  }

  private rearm(): void {
    if (this.cancelTimer === null) return;
    this.cancelTimer();
    this.cancelTimer = null;
    this.arm();
  }

  private arm(): void {
    if (this.stopped || this.fired || this.openWaits > 0) return;
    const leftMs = this.quietLimitMs() - this.idleMs();
    if (leftMs <= 0) {
      this.expired();
      return;
    }
    this.cancelTimer = this.clock.after(leftMs, () => {
      this.cancelTimer = null;
      this.arm();
    });
  }

  private expired(): void {
    if (this.stopped || this.fired) return;
    this.fired = true;
    this.release();
    this.fire();
  }
}

export class RoomTurnStallRegistry {
  private handlers = new Map<string, (cause: string) => void>();

  register(threadId: string, handler: (cause: string) => void): () => void {
    this.handlers.set(threadId, handler);
    return () => {
      if (this.handlers.get(threadId) === handler) this.handlers.delete(threadId);
    };
  }

  stall(threadId: string, cause: string): boolean {
    const handler = this.handlers.get(threadId);
    if (!handler) return false;
    this.handlers.delete(threadId);
    handler(cause);
    return true;
  }
}

/** In the room's language for its status row; a coordinator reads it in English. */
export function roomTurnTimeoutMessage(botName: string, minutes: number, language?: string): string {
  return serverLine(language, minutes === 1 ? "server.rooms.turnStalled.one" : "server.rooms.turnStalled.many", { bot: botName, count: minutes });
}
