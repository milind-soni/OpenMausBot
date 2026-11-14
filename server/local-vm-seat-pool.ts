export interface LocalVmSeatHolder {
  threadId: string;
  expiresAt: number;
}

export const DEFAULT_LOCAL_VM_SEAT_AFFINITY_TTL_MS = 30 * 60_000;

interface SeatAffinityEntry {
  seat: number;
  expiresAt: number;
}

export class LocalVmSeatPool {
  private readonly affinity = new Map<string, SeatAffinityEntry>();
  private readonly seatCount: () => number;
  private readonly affinityTtlMs: number;
  private readonly now: () => number;

  // Explicit fields: Node's strip-only TypeScript loader rejects constructor parameter properties.
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

  affinitySeat(threadId: string): number | null {
    const entry = this.affinity.get(threadId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now() || entry.seat >= this.count()) {
      this.affinity.delete(threadId);
      return null;
    }
    return entry.seat;
  }

  /** Records nothing: a status probe must not steer a later turn onto another desktop. */
  candidate(threadId: string, holderOf: (seat: number) => LocalVmSeatHolder | null): number {
    const now = this.now();
    this.prune(now);
    const live = this.affinitySeat(threadId);
    if (live !== null) return live;
    return this.selectSeat(threadId, holderOf, now);
  }

  /** Live affinity is returned without renewal (only touch() after a won claim renews); a first choice is recorded at once so concurrent threads diverge. */
  assign(threadId: string, holderOf: (seat: number) => LocalVmSeatHolder | null): number {
    const now = this.now();
    this.prune(now);
    const live = this.affinitySeat(threadId);
    if (live !== null) return live;
    return this.take(threadId, this.selectSeat(threadId, holderOf, now), now);
  }

  touch(threadId: string): void {
    const seat = this.affinitySeat(threadId);
    if (seat === null) return;
    this.affinity.set(threadId, { seat, expiresAt: this.now() + this.affinityTtlMs });
  }

  renew(threadId: string, seat: number): void {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count()) return;
    this.affinity.set(threadId, { seat, expiresAt: this.now() + this.affinityTtlMs });
  }

  forget(threadId: string): void {
    this.affinity.delete(threadId);
  }

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
