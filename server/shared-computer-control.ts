import { TurnResources, type TurnOwner } from "./turn-resources.ts";

/** Leases expire if Electron crashes. */
const LEASE_EXPIRY_MS = 40_000;
const HOST = "computer:host";
const SHARED = "shared:";

/** Said when another bot's turn on this computer holds its screen. Never a person: a person at this computer is noticed by
 * the desktop itself, from its own keyboard and mouse. */
export function hostScreenBusyText(holder?: string): string {
  return `${holder ? `Another bot on this computer, ${holder},` : "Another bot on this computer"} is using its screen right now, so this call was not performed. ` +
    "It is not a person. Work on something that does not need the screen, then try again in a minute.";
}

type SharedComputerLease = { timer: NodeJS.Timeout; generation: number; lastActivity: number };

/** Keeps this desktop's own bot turns and a lent screen call from the person's Cloud from using the screen at once. */
export class SharedComputerControl {
  private leases = new Map<string, SharedComputerLease>();
  private resources: TurnResources;
  private holderName: (owner: TurnOwner) => string | undefined;
  constructor(resources: TurnResources, holderName: (owner: TurnOwner) => string | undefined = () => undefined) {
    this.resources = resources; this.holderName = holderName;
  }
  /** Undefined when the screen is now this call's; otherwise the plain reason it is not. */
  acquire(id: string): string | undefined {
    const owner = { threadId: `${SHARED}${id}`, generation: id };
    // The desktop runs one lent call at a time, so an older lent call's lease is always stale: a newer call frees it.
    const holder = this.resources.holder(HOST);
    if (holder?.threadId.startsWith(SHARED) && holder.generation !== id) this.release(holder.generation);
    if (!this.resources.claim(HOST, owner)) {
      const blocker = this.resources.blocker(HOST, owner);
      this.release(id);
      return hostScreenBusyText(blocker && this.holderName(blocker));
    }
    this.arm(id);
    return undefined;
  }
  /** A heartbeat for a pending operation: never loses its own screen. */
  renew(id: string) {
    if (this.leases.has(id)) this.arm(id);
  }
  /** The generation counter makes a stale timer a no-op: only the newest arming may release the lease. */
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
    this.resources.release({ threadId: `${SHARED}${id}`, generation: id });
  }
  close() { for (const id of this.leases.keys()) this.release(id); }
}
