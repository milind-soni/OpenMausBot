export interface LocalVmLeaseRecord {
  threadId: string;
  botId: string;
  /** Monotonic claim ordinal for this lane. Direct threads reuse their
   * thread id across turns, so a late release distinguishes its own claim
   * from a replacement's by generation, never by thread id alone. */
  generation: number;
  expiresAt: number;
}

/** A short, renewable ownership fence for one Local VM desktop.
 * Runtime events keep an active turn's lease alive; a dead provider cannot
 * pin the VM forever. All methods are synchronous so lifecycle routes and
 * turn dispatch can claim their side of the race before either awaits. */
export class LocalVmLease {
  private record: LocalVmLeaseRecord | null = null;
  private readonly ttlMs: number;
  private nextGeneration = 1;

  constructor(ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Local VM lease TTL must be positive");
    this.ttlMs = ttlMs;
  }

  current(isBotBusy: (botId: string) => boolean, now = Date.now()): LocalVmLeaseRecord | null {
    if (this.record && (this.record.expiresAt <= now || !isBotBusy(this.record.botId))) this.record = null;
    return this.record ? { ...this.record } : null;
  }

  claim(
    threadId: string,
    botId: string,
    isBotBusy: (ownerBotId: string) => boolean,
    now = Date.now(),
  ): boolean {
    const current = this.current(isBotBusy, now);
    if (current && current.threadId !== threadId) return false;
    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    this.record = { threadId, botId, generation, expiresAt: now + this.ttlMs };
    return true;
  }

  touch(threadId: string, now = Date.now()): void {
    if (this.record && this.record.expiresAt <= now) {
      this.record = null;
      return;
    }
    if (this.record?.threadId === threadId) this.record.expiresAt = now + this.ttlMs;
  }

  /** The generation this thread's claim last stamped, without resolving
   * liveness: unlike current(), a fence read must never clear the expired
   * or idle record it is about to be compared against. */
  generationOf(threadId: string): number | undefined {
    return this.record?.threadId === threadId ? this.record.generation : undefined;
  }

  release(threadId: string, generation?: number): void {
    if (this.record?.threadId !== threadId) return;
    // A superseded turn's late callback must never release its
    // replacement's claim; on a reused thread id only the generation
    // tells the two claims apart.
    if (generation !== undefined && this.record.generation !== generation) return;
    this.record = null;
  }
}

/** Independent lease lanes keyed by an already-validated Local VM target.
 * Shared mode uses one key; per-bot mode uses one digest-derived key per bot,
 * so separate desktops never block each other while each desktop remains a
 * strict singleton. */
export class LocalVmLeasePool {
  private readonly leases = new Map<string, LocalVmLease>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Local VM lease TTL must be positive");
    this.ttlMs = ttlMs;
  }

  forTarget(targetKey: string): LocalVmLease {
    let lease = this.leases.get(targetKey);
    if (!lease) {
      lease = new LocalVmLease(this.ttlMs);
      this.leases.set(targetKey, lease);
    }
    return lease;
  }

  /** Drop an idle per-target lane after its owning bot and VM are gone. */
  forget(targetKey: string): void {
    this.leases.delete(targetKey);
  }
}
