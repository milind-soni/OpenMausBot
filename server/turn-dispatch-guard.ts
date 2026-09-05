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

export type ProviderTurnGenerationOwner = { threadId: string; generation: string };

/** Correlate an internal capability generation with its provider turn without
 * leaving a bearer alive when a very fast provider completes before
 * sendTurn() returns its id. Completed ids are kept in a bounded tombstone
 * registry, so a late bind fails closed instead of publishing stale ownership. */
export class ProviderTurnGenerationRegistry {
  readonly #owners = new Map<string, ProviderTurnGenerationOwner>();
  readonly #completed: RetiredTurnRegistry;

  constructor(limit = 4_096) {
    this.#completed = new RetiredTurnRegistry(limit);
  }

  bind(threadId: string, generation: string, turnId: string): boolean {
    if (this.#completed.has(turnId)) return false;
    this.#owners.set(turnId, { threadId, generation });
    return true;
  }

  complete(threadId: string, turnId: string): ProviderTurnGenerationOwner | null {
    this.#completed.retire(turnId);
    const owner = this.#owners.get(turnId);
    if (!owner || owner.threadId !== threadId) return null;
    this.#owners.delete(turnId);
    return owner;
  }

  deleteGeneration(threadId: string, generation: string): void {
    for (const [turnId, owner] of this.#owners) {
      if (owner.threadId === threadId && owner.generation === generation) {
        this.#owners.delete(turnId);
      }
    }
  }

  clear(): void {
    this.#owners.clear();
  }
}

/** Thread gate for the narrow interval after Stop wins but before an async
 * adapter returns the provider turn id that can be retired. Multiple queued
 * room operations may share a thread, so ownership is reference-counted.
 *
 * A broken adapter is allowed to leave its sendTurn promise pending forever.
 * The gate therefore expires each owner independently: by then any turn id
 * observed during the vulnerable handshake has been moved to the longer-lived
 * RetiredTurnRegistry, while a replacement turn's new id can flow normally. */
export class PendingTurnCancellations {
  readonly #ownersByThread = new Map<
    string,
    Map<string, ReturnType<typeof setTimeout>>
  >();
  readonly #clearWaitersByThread = new Map<string, Set<() => void>>();
  readonly #ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.#ttlMs = Math.max(1, Math.floor(ttlMs));
  }

  mark(threadId: string, ownerId: string): void {
    const owners = this.#ownersByThread.get(threadId) ?? new Map<string, ReturnType<typeof setTimeout>>();
    const previous = owners.get(ownerId);
    if (previous) clearTimeout(previous);
    const expiry = setTimeout(() => {
      // A clear + re-mark may have installed a newer timer for the same
      // owner. The stale callback must not clear that renewed quarantine.
      if (this.#ownersByThread.get(threadId)?.get(ownerId) !== expiry) return;
      this.clear(threadId, ownerId);
    }, this.#ttlMs);
    expiry.unref?.();
    owners.set(ownerId, expiry);
    this.#ownersByThread.set(threadId, owners);
  }

  clear(threadId: string, ownerId: string): void {
    const owners = this.#ownersByThread.get(threadId);
    const expiry = owners?.get(ownerId);
    if (expiry) clearTimeout(expiry);
    owners?.delete(ownerId);
    if (owners?.size !== 0) return;
    this.#ownersByThread.delete(threadId);
    const waiters = this.#clearWaitersByThread.get(threadId);
    this.#clearWaitersByThread.delete(threadId);
    for (const resolve of waiters ?? []) resolve();
  }

  /** Do not overlap a replacement dispatch with the ambiguous pre-id window.
   * Re-check after every wake: a cancellation can be renewed in the same
   * microtask turn that clears an older owner. Each owner has its own bounded
   * expiry, so a broken adapter cannot strand this await forever. */
  async waitForClear(threadId: string): Promise<void> {
    while (this.has(threadId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.#clearWaitersByThread.get(threadId) ?? new Set<() => void>();
        waiters.add(resolve);
        this.#clearWaitersByThread.set(threadId, waiters);
        // clear() cannot interleave with this synchronous block, but keeping
        // the second check makes the registration safe if the implementation
        // later gains an externally supplied scheduler.
        if (!this.has(threadId)) {
          waiters.delete(resolve);
          if (waiters.size === 0) this.#clearWaitersByThread.delete(threadId);
          resolve();
        }
      });
    }
  }

  has(threadId: string): boolean {
    return this.#ownersByThread.has(threadId);
  }
}

/** Apply the two-stage cancellation quarantine. While the unresolved
 * handshake owns the thread, every event is ignored and any stable provider
 * turn id it reveals is retired. After the bounded gate expires, that old id
 * remains ignored but an unrelated replacement id is admitted. */
export function isTurnEventQuarantined(
  pending: PendingTurnCancellations,
  retired: RetiredTurnRegistry,
  event: { threadId: string; turnId?: string },
): boolean {
  if (retired.has(event.turnId)) return true;
  if (!pending.has(event.threadId)) return false;
  if (event.turnId) retired.retire(event.turnId);
  return true;
}
