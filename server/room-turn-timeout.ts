import {
  MAX_ROOM_TURN_TIMEOUT_MINUTES,
  MIN_ROOM_TURN_TIMEOUT_MINUTES,
} from "./config.ts";

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

/** Counts work, not wall time: the clock holds while the turn waits on a card, and stray resolves clamp the count at zero. */
export class RoomTurnDeadline {
  private remainingMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openRequests = 0;
  private stopped = false;
  private fired = false;
  private armedAt = 0;
  private fire: () => void;

  // No parameter properties: Node's type-stripping cannot transform them.
  constructor(minutes: number, fire: () => void) {
    this.remainingMs = roomTurnTimeoutMs(minutes);
    this.fire = fire;
  }

  start(): void {
    this.arm();
  }

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
    // A delayed event loop can deliver the card event after the deadline: a person's wait must not extend an exhausted budget.
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

export function roomTurnTimeoutMessage(botName: string, minutes: number): string {
  const unit = minutes === 1 ? "minute" : "minutes";
  return `${botName}'s room turn exceeded ${minutes} ${unit} and was stopped`;
}
