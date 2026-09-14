import { TurnResources } from "./turn-resources.ts";

/** A local desktop call competes with ordinary bot turns for the same screen.
 * Leases expire if Electron crashes; human takeover always wins renewal. */
export class SharedComputerControl {
  private leases = new Map<string, NodeJS.Timeout>();
  private resources: TurnResources;
  private held: () => boolean;
  constructor(resources: TurnResources, held: () => boolean) { this.resources = resources; this.held = held; }
  acquire(id: string) {
    const owner = { threadId: `shared:${id}`, generation: id };
    if (this.held() || !this.resources.claim("computer:host", owner)) {
      this.release(id);
      throw Object.assign(new Error("This computer is in use locally or held by a person. Wait, then observe it again before acting."), { status: 409 });
    }
    clearTimeout(this.leases.get(id));
    this.leases.set(id, setTimeout(() => this.release(id), 40_000));
  }
  release(id: string) {
    clearTimeout(this.leases.get(id)); this.leases.delete(id);
    this.resources.release({ threadId: `shared:${id}`, generation: id });
  }
  close() { for (const id of this.leases.keys()) this.release(id); }
}
