export const TURN_ENDED_REFUSAL = "This bot turn has already ended (it finished or was stopped), so this call was refused. " +
  "Anything the call started before the turn ended may still have run.";

/** Admission failures that can resume once a slot frees; never matched on error wording. */
export function isTurnAdmissionBlocked(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "thread_busy" || error.code === "thread_limit");
}

/** An adapter may publish its process only after sendTurn resolves, so a Stop during that await can be a no-op: re-check and interrupt again. */
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

/** Turns cancelled during async startup: their late events must not settle a newer turn on the same thread. */
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

/** A late bind for a completed provider id fails closed instead of publishing stale ownership or leaving a bearer alive. */
export class ProviderTurnGenerationRegistry<Outcome = never> {
  readonly #owners = new Map<string, ProviderTurnGenerationOwner>();
  readonly #completed: RetiredTurnRegistry;
  readonly #earlyCompletions = new Map<string, { threadId: string; outcome: Outcome }>();
  readonly #limit: number;

  constructor(limit = 4_096) {
    this.#completed = new RetiredTurnRegistry(limit);
    this.#limit = limit;
  }

  bind(threadId: string, generation: string, turnId: string): boolean {
    if (this.#completed.has(turnId)) return false;
    this.#owners.set(turnId, { threadId, generation });
    return true;
  }

  complete(threadId: string, turnId: string, outcome?: Outcome): ProviderTurnGenerationOwner | null {
    if (this.#completed.has(turnId)) return null;
    const owner = this.#owners.get(turnId);
    if (owner && owner.threadId !== threadId) return null;
    this.#completed.retire(turnId);
    if (!owner) {
      // Never attribute an unbound event to the thread's current generation.
      if (outcome !== undefined) {
        this.#earlyCompletions.set(turnId, { threadId, outcome });
        while (this.#earlyCompletions.size > this.#limit) {
          this.#earlyCompletions.delete(this.#earlyCompletions.keys().next().value!);
        }
      }
      return null;
    }
    this.#owners.delete(turnId);
    return owner;
  }

  takeEarlyCompletion(threadId: string, turnId: string): Outcome | undefined {
    const receipt = this.#earlyCompletions.get(turnId);
    if (receipt?.threadId !== threadId) return undefined;
    this.#earlyCompletions.delete(turnId);
    return receipt.outcome;
  }

  deleteGeneration(threadId: string, generation: string): string[] {
    const removed: string[] = [];
    for (const [turnId, owner] of this.#owners) {
      if (owner.threadId === threadId && owner.generation === generation) {
        this.#owners.delete(turnId);
        this.#completed.retire(turnId);
        removed.push(turnId);
      }
    }
    return removed;
  }

  clear(): void {
    this.#owners.clear();
    this.#earlyCompletions.clear();
  }
}

/** Gates a thread between a winning Stop and the async provider turn id; reference-counted, and each owner expires so a hung adapter cannot hold it. */
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
      // A clear + re-mark may have installed a newer timer: a stale callback must not clear it.
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

  /** Re-check after every wake: a cancellation can be renewed in the same microtask turn that clears an older owner. */
  async waitForClear(threadId: string): Promise<void> {
    while (this.has(threadId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.#clearWaitersByThread.get(threadId) ?? new Set<() => void>();
        waiters.add(resolve);
        this.#clearWaitersByThread.set(threadId, waiters);
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
