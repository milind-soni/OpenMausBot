// Covers the gap before a member turn marks the bot busy: woken waiters must claim in the same synchronous step, or all read the bot as free.

export type RoomMemberReleaseListener = (botId: string) => void;

export class RoomMemberLock {
  private readonly holders = new Map<string, string>();
  private readonly listeners = new Set<RoomMemberReleaseListener>();

  holder(botId: string): string | undefined {
    return this.holders.get(botId);
  }

  heldElsewhere(botId: string, threadId: string): boolean {
    const holder = this.holders.get(botId);
    return holder !== undefined && holder !== threadId;
  }

  claim(botId: string, threadId: string): boolean {
    if (this.heldElsewhere(botId, threadId)) return false;
    this.holders.set(botId, threadId);
    return true;
  }

  release(botId: string, threadId: string): boolean {
    if (this.holders.get(botId) !== threadId) return false;
    this.holders.delete(botId);
    this.notify(botId);
    return true;
  }

  releaseThread(threadId: string): string[] {
    const released: string[] = [];
    for (const [botId, holder] of this.holders) {
      if (holder === threadId) released.push(botId);
    }
    for (const botId of released) this.holders.delete(botId);
    for (const botId of released) this.notify(botId);
    return released;
  }

  onRelease(listener: RoomMemberReleaseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(botId: string): void {
    // A snapshot: a woken waiter may unsubscribe, or a new one subscribe, during this loop.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...this.listeners]) {
      try {
        listener(botId);
      } catch {
      }
    }
  }
}
