// One read of an installation's connected apps for everyone asking together or soon after: the Apps page's list and its
// suggestions ask within moments of each other. It is for what a person is shown; a bot's tool call never reads it.

export interface KeptInventory<Service> {
  services: Record<string, Service>;
  complete: boolean;
}

interface ComparedService {
  connected?: boolean;
  pending?: boolean;
  accounts?: ReadonlyArray<{ id: string; status?: string }>;
}

export const INVENTORY_KEEP_MS = 20_000;

const kept = new Map<string, { at: number; inventory: KeptInventory<ComparedService> }>();
const reads = new Map<string, Promise<KeptInventory<ComparedService>>>();

/** The inventory kept for `identity` if under INVENTORY_KEEP_MS old, else the read already running, else `read`. `fresh`
 * always reads. Only a complete inventory is kept, and never one whose read began before forgetInventory. */
export function sharedInventory<Service extends ComparedService>(
  identity: string,
  read: () => Promise<KeptInventory<Service>>,
  fresh = false,
): Promise<KeptInventory<Service>> {
  if (!fresh) {
    const known = kept.get(identity);
    if (known && Date.now() - known.at < INVENTORY_KEEP_MS) return Promise.resolve(known.inventory as KeptInventory<Service>);
    const running = reads.get(identity);
    if (running) return running as Promise<KeptInventory<Service>>;
  }
  const reading: Promise<KeptInventory<Service>> = read().then((inventory) => {
    if (reads.get(identity) === reading) {
      if (inventory.complete) kept.set(identity, { at: Date.now(), inventory });
      else kept.delete(identity);
    }
    return inventory;
  }).finally(() => {
    if (reads.get(identity) === reading) reads.delete(identity);
  });
  reads.set(identity, reading);
  return reading;
}

/** A connection was started or removed: the next reader reads, and a read already running is not kept. */
export function forgetInventory(identity: string): void {
  kept.delete(identity);
  reads.delete(identity);
}

const accountsOf = (service: ComparedService | undefined) =>
  (service?.accounts ?? []).map((account) => `${account.id}:${account.status ?? ""}`).sort().join();

/** Whether a status check of some apps says other than the inventory kept for `identity`. Nothing kept: nothing differs. */
export function inventoryDiffers(identity: string, checked: Record<string, ComparedService>, canonical: (slug: string) => string): boolean {
  const known = kept.get(identity);
  if (!known) return false;
  return Object.entries(checked).some(([slug, now]) => {
    const before = known.inventory.services[canonical(slug)];
    return Boolean(before?.connected) !== Boolean(now.connected)
      || Boolean(before?.pending) !== Boolean(now.pending)
      || accountsOf(before) !== accountsOf(now);
  });
}

export function forgetInventories(): void {
  kept.clear();
  reads.clear();
}
