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

/** Stops a turn that shows no progress for the limit, or for ROOM_TOOL_QUIET_LIMIT_MS while a tool runs; the clock
 * holds while the turn waits on a person or the computer, and stray ends clamp the count at zero. */
export class RoomTurnDeadline {
  private limitMs: number;
  private progressAt = 0;
  private heldAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openWaits = 0;
  private runningTools = new Set<string>();
  private stopped = false;
  private fired = false;
  private fire: () => void;

  // No parameter properties: Node's type-stripping cannot transform them.
  constructor(minutes: number, fire: () => void) {
    this.limitMs = roomTurnTimeoutMs(minutes);
    this.fire = fire;
  }

  start(): void {
    this.progressAt = Date.now();
    this.arm();
  }

  observe(e: RuntimeEvent): void {
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
    if (this.timer !== null && this.idleMs() >= this.quietLimitMs()) {
      this.expired();
      return;
    }
    this.progressAt = Date.now();
  }

  setWaiting(waiting: boolean): void {
    if (this.stopped || this.fired) return;
    if (waiting) {
      const wasIdle = this.openWaits === 0;
      this.openWaits += 1;
      if (wasIdle) this.hold();
    } else if (this.openWaits > 0) {
      this.openWaits -= 1;
      if (this.openWaits === 0) {
        // The wait paused the clock: idle time from before it still counts, progress during it counts as now.
        const idleBefore = this.progressAt >= this.heldAt ? 0 : this.heldAt - this.progressAt;
        this.progressAt = Date.now() - idleBefore;
        this.arm();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private idleMs(): number {
    return Date.now() - this.progressAt;
  }

  private quietLimitMs(): number {
    return this.runningTools.size > 0 ? Math.max(this.limitMs, ROOM_TOOL_QUIET_LIMIT_MS) : this.limitMs;
  }

  private hold(): void {
    this.heldAt = Date.now();
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    // A delayed event loop can deliver the wait after the deadline: a wait must not revive an idle turn.
    if (this.idleMs() >= this.quietLimitMs()) this.expired();
  }

  private rearm(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.arm();
  }

  private arm(): void {
    if (this.stopped || this.fired || this.openWaits > 0) return;
    const leftMs = this.quietLimitMs() - this.idleMs();
    if (leftMs <= 0) {
      this.expired();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.arm();
    }, leftMs);
  }

  private expired(): void {
    if (this.stopped || this.fired) return;
    this.fired = true;
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
