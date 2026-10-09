import {
  MAX_ROOM_TURN_TIMEOUT_MINUTES,
  MIN_ROOM_TURN_TIMEOUT_MINUTES,
} from "./config.ts";

export function roomTurnTimeoutMs(minutes: number): number {
  return minutes * 60_000;
}

/** A conversation may replace the global group ceiling. Null clears that
 * choice. Anything else is refused rather than silently clamped. */
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

/** The ceiling captured for one turn. An override wins; a missing or
 * unusable one keeps the global group limit. */
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

/**
 * One room turn's slice of the configured room ceiling.
 *
 * Counts work, not wall time: the clock holds while the turn is parked on
 * an approval or question card (request.opened → request.resolved) —
 * waiting on a person is not work, and stopping the turn under an open
 * card manufactures the stranded-approval state the harness otherwise has
 * to repair after the fact. Streaming, tool runs, and provider latency
 * still burn the budget normally; a turn that goes silent entirely is
 * separately caught by the stall watchdog.
 *
 * Requests pair opened→resolved per thread, but resolves can also arrive
 * for cards this turn never opened (stale cleanup after an interrupt), so
 * the count clamps at zero instead of trusting perfect pairing.
 */
export class RoomTurnDeadline {
  private remainingMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openRequests = 0;
  private stopped = false;
  private fired = false;
  private armedAt = 0;
  private fire: () => void;

  // plain field assignments, not parameter properties — the server runs
  // under Node's type-stripping, which cannot transform the latter
  constructor(minutes: number, fire: () => void) {
    this.remainingMs = roomTurnTimeoutMs(minutes);
    this.fire = fire;
  }

  /** Begin counting down the budget. */
  start(): void {
    this.arm();
  }

  /** request.opened → true (a person is deciding; hold however long they take),
   * request.resolved → false (the budget resumes where it left off). */
  setWaitingOnHuman(waiting: boolean): void {
    if (this.stopped || this.fired) return;
    if (waiting) {
      const wasIdle = this.openRequests === 0;
      this.openRequests += 1;
      if (wasIdle) this.hold();
    } else if (this.openRequests > 0) {
      this.openRequests -= 1;
      if (this.openRequests === 0) this.arm();
    }
  }

  /** The turn settled — cancel whatever remains. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private hold(): void {
    if (this.timer === null) return;
    this.remainingMs -= Date.now() - this.armedAt;
    clearTimeout(this.timer);
    this.timer = null;
    // A delayed event loop can deliver the card event after the deadline
    // already passed; a person's wait must not extend an exhausted budget.
    if (this.remainingMs <= 0) this.expired();
  }

  private arm(): void {
    if (this.stopped || this.fired || this.openRequests > 0) return;
    if (this.remainingMs <= 0) {
      this.expired();
      return;
    }
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.expired();
    }, this.remainingMs);
  }

  private expired(): void {
    if (this.stopped || this.fired) return;
    this.fired = true;
    this.fire();
  }
}

/** Completes the active room turn when its activity watchdog stalls. */
export class RoomTurnStallRegistry {
  private handlers = new Map<string, () => void>();

  register(threadId: string, handler: () => void): () => void {
    this.handlers.set(threadId, handler);
    return () => {
      if (this.handlers.get(threadId) === handler) this.handlers.delete(threadId);
    };
  }

  stall(threadId: string): boolean {
    const handler = this.handlers.get(threadId);
    if (!handler) return false;
    this.handlers.delete(threadId);
    handler();
    return true;
  }
}

export function roomTurnTimeoutMessage(botName: string, minutes: number): string {
  const unit = minutes === 1 ? "minute" : "minutes";
  return `${botName}'s room turn exceeded ${minutes} ${unit} and was stopped`;
}
