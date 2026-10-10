import { TurnResources } from "./turn-resources.ts";

/** A local desktop call competes with ordinary bot turns for the same screen.
 * Leases expire if Electron crashes; human takeover always wins renewal. */
const LEASE_EXPIRY_MS = 40_000;

type SharedComputerLease = { timer: NodeJS.Timeout; generation: number; lastActivity: number };

export class SharedComputerControl {
  private leases = new Map<string, SharedComputerLease>();
  private resources: TurnResources;
  private held: () => boolean;
  constructor(resources: TurnResources, held: () => boolean) { this.resources = resources; this.held = held; }
  acquire(id: string) {
    const owner = { threadId: `shared:${id}`, generation: id };
    if (this.held() || !this.resources.claim("computer:host", owner)) {
      this.release(id);
      throw Object.assign(new Error("This computer is in use locally or held by a person. Wait, then observe it again before acting."), { status: 409 });
    }
    this.arm(id);
  }
  /** Extends a held lease for one long desktop action without re-running the
   * takeover checks: a heartbeat while the operation is pending must not be
   * able to lose its own screen. Renewing an expired or released id is a
   * no-op — the lease is gone and only acquire can bring it back. */
  renew(id: string) {
    if (this.leases.has(id)) this.arm(id);
  }
  /** (Re)arm the expiry timer. The generation counter makes a stale timer a
   * no-op: only the callback of the newest arming may release the lease. */
  private arm(id: string) {
    const previous = this.leases.get(id);
    if (previous) clearTimeout(previous.timer);
    const generation = (previous?.generation ?? 0) + 1;
    this.leases.set(id, {
      timer: setTimeout(() => {
        if (this.leases.get(id)?.generation === generation) this.release(id);
      }, LEASE_EXPIRY_MS),
      generation,
      lastActivity: Date.now(),
    });
  }
  release(id: string) {
    const lease = this.leases.get(id);
    if (lease) { clearTimeout(lease.timer); this.leases.delete(id); }
    this.resources.release({ threadId: `shared:${id}`, generation: id });
  }
  close() { for (const id of this.leases.keys()) this.release(id); }
}
