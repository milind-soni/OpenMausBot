/** Who holds a pool seat right now, as the per-seat LocalVmLease reports it. */
export interface LocalVmSeatHolder {
  threadId: string;
  expiresAt: number;
}

/** How long a conversation keeps preferring its previous seat after its last
 * turn settles. Matches the lease TTL's half-hour scale: long enough for a
 * person's pause between messages, short enough that an abandoned
 * conversation stops steering assignment within the hour. */
export const DEFAULT_LOCAL_VM_SEAT_AFFINITY_TTL_MS = 30 * 60_000;

interface SeatAffinityEntry {
  seat: number;
  expiresAt: number;
}

/**
 * Seat assignment for `localVm.mode: "pool"` (issue #1654).
 *
 * The lease pool stays the ownership fence: one `LocalVmLease` lane per
 * seat decides who may use a desktop right now. This class only decides
 * WHICH seat a conversation addresses. A TTL-bounded affinity keeps a thread
 * returning to the desktop that holds its login state, and hands the seat
 * back to the pool once the conversation has been idle past the TTL.
 */
export class LocalVmSeatPool {
  private readonly affinity = new Map<string, SeatAffinityEntry>();
  private readonly seatCount: () => number;
  private readonly affinityTtlMs: number;
  private readonly now: () => number;

  // Explicit fields, not parameter properties: the group e2e harness boots
  // the server under node's strip-only TypeScript loader, which rejects
  // constructor parameter properties.
  constructor(
    seatCount: () => number,
    affinityTtlMs: number = DEFAULT_LOCAL_VM_SEAT_AFFINITY_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.seatCount = seatCount;
    this.affinityTtlMs = affinityTtlMs;
    this.now = now;
    if (!Number.isFinite(affinityTtlMs) || affinityTtlMs <= 0) {
      throw new Error("Local VM seat affinity TTL must be positive");
    }
  }

  private count(): number {
    const seats = Math.floor(this.seatCount());
    return Number.isFinite(seats) && seats >= 1 ? seats : 1;
  }

  private prune(now: number): void {
    const seats = this.count();
    for (const [threadId, entry] of this.affinity) {
      if (entry.expiresAt <= now || entry.seat >= seats) this.affinity.delete(threadId);
    }
  }

  /** The seat a thread still has affinity with, or null once the TTL — or a
   * smaller configured seat count — has lapsed. Read-only: never records. */
  affinitySeat(threadId: string): number | null {
    const entry = this.affinity.get(threadId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now() || entry.seat >= this.count()) {
      this.affinity.delete(threadId);
      return null;
    }
    return entry.seat;
  }

  /** The seat a thread's next Local VM claim addresses, without recording
   * or renewing anything: a status probe or a skipped fast path must not
   * steer a later turn onto a desktop its claim would not choose. */
  candidate(threadId: string, holderOf: (seat: number) => LocalVmSeatHolder | null): number {
    const now = this.now();
    this.prune(now);
    const live = this.affinitySeat(threadId);
    if (live !== null) return live;
    return this.selectSeat(threadId, holderOf, now);
  }

  /**
   * Choose the seat a thread's next Local VM claim addresses. Live
   * affinity wins outright and is returned untouched: reusing the desktop
   * that holds the conversation's login state is worth queueing behind its
   * current holder, but a retry that has not won its lease must not extend
   * how long it waits there — touch(), called only after a successful
   * claim, is what renews the TTL. A first-time choice is recorded
   * immediately: two threads assigning concurrently must diverge even
   * before their lease claims land.
   */
  assign(threadId: string, holderOf: (seat: number) => LocalVmSeatHolder | null): number {
    const now = this.now();
    this.prune(now);
    const live = this.affinitySeat(threadId);
    if (live !== null) return live;
    return this.take(threadId, this.selectSeat(threadId, holderOf, now), now);
  }

  /** Renew a thread's existing affinity without creating one. Called after
   * a successful lease claim: only a turn that actually owns its desktop
   * extends how long the conversation keeps preferring it. */
  touch(threadId: string): void {
    const seat = this.affinitySeat(threadId);
    if (seat === null) return;
    this.affinity.set(threadId, { seat, expiresAt: this.now() + this.affinityTtlMs });
  }

  /** Renew a thread's affinity with the seat its settled turn ran on. A
   * turn that outlasted the affinity TTL finds its entry expired —
   * touch() treats it as gone — but the conversation still used that
   * desktop for the whole turn, so settlement re-records it. */
  renew(threadId: string, seat: number): void {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count()) return;
    this.affinity.set(threadId, { seat, expiresAt: this.now() + this.affinityTtlMs });
  }

  /** Drop a thread's affinity explicitly, without waiting for the TTL. */
  forget(threadId: string): void {
    this.affinity.delete(threadId);
  }

  /** Prefer a seat nobody holds and no other thread has live affinity
   * with, then any unheld seat, and when every seat is held, the seat whose
   * lease expires first, so the caller waits where capacity returns
   * soonest. */
  private selectSeat(threadId: string, holderOf: (seat: number) => LocalVmSeatHolder | null, now: number): number {
    const seats = this.count();
    const holders: Array<LocalVmSeatHolder | null> = [];
    for (let seat = 0; seat < seats; seat += 1) holders.push(holderOf(seat));
    const softHeld = new Set<number>();
    for (const [otherId, entry] of this.affinity) {
      if (otherId !== threadId && entry.expiresAt > now && entry.seat < seats) softHeld.add(entry.seat);
    }
    for (let pass = 0; pass < 2; pass += 1) {
      for (let seat = 0; seat < seats; seat += 1) {
        if (holders[seat] !== null) continue;
        if (pass === 0 && softHeld.has(seat)) continue;
        return seat;
      }
    }
    let soonest = 0;
    for (let seat = 1; seat < seats; seat += 1) {
      const best = holders[soonest];
      const current = holders[seat];
      if (best && current && current.expiresAt < best.expiresAt) soonest = seat;
    }
    return soonest;
  }

  private take(threadId: string, seat: number, now: number): number {
    this.affinity.set(threadId, { seat, expiresAt: now + this.affinityTtlMs });
    return seat;
  }
}
