export function roomTurnTimeoutMs(minutes: number): number {
  return minutes * 60_000;
}

export function scheduleRoomTurnTimeout(
  minutes: number,
  onTimeout: () => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(onTimeout, roomTurnTimeoutMs(minutes));
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
