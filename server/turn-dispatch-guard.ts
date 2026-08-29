/** Close the Stop-vs-provider-handshake race shared by direct and room turns.
 * An adapter may not publish its active process until sendTurn resolves, so
 * an interrupt during that await can be an honest no-op. Re-check once setup
 * completes and issue a second interrupt only when cancellation won. */
export async function guardTurnDispatch<T>(
  started: Promise<T>,
  cancelled: () => boolean,
  stopAfterSetup: () => Promise<void>,
): Promise<{ value: T; cancelled: boolean }> {
  const value = await started;
  if (!cancelled()) return { value, cancelled: false };
  await stopAfterSetup();
  return { value, cancelled: true };
}

/** Bounded tombstones for provider turns cancelled during asynchronous
 * startup. Their late completion/session events must not settle a newer turn
 * that reused the same conversation thread. */
export class RetiredTurnRegistry {
  readonly #turnIds = new Set<string>();
  readonly #limit: number;

  constructor(limit = 4_096) {
    this.#limit = limit;
  }

  retire(turnId: string): void {
    this.#turnIds.add(turnId);
    while (this.#turnIds.size > this.#limit) {
      const oldest = this.#turnIds.values().next().value;
      if (oldest === undefined) break;
      this.#turnIds.delete(oldest);
    }
  }

  has(turnId: string | undefined): boolean {
    return turnId !== undefined && this.#turnIds.has(turnId);
  }
}

/** Thread gate for the narrow interval after Stop wins but before an async
 * adapter returns the provider turn id that can be retired. Multiple queued
 * room operations may share a thread, so ownership is reference-counted. */
export class PendingTurnCancellations {
  readonly #ownersByThread = new Map<string, Set<string>>();

  mark(threadId: string, ownerId: string): void {
    const owners = this.#ownersByThread.get(threadId) ?? new Set<string>();
    owners.add(ownerId);
    this.#ownersByThread.set(threadId, owners);
  }

  clear(threadId: string, ownerId: string): void {
    const owners = this.#ownersByThread.get(threadId);
    owners?.delete(ownerId);
    if (owners?.size === 0) this.#ownersByThread.delete(threadId);
  }

  has(threadId: string): boolean {
    return this.#ownersByThread.has(threadId);
  }
}
