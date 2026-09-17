/** Lazy exclusive claims for auto-resolved Local VM attaches (issue #1361).
 * The table is keyed by thread and owned by the dispatch generation; the
 * claim closure itself lives in index.ts next to the turn state it needs.
 * Kept free of index.ts imports so the fire-once semantics stay unit-testable. */

export interface AutoVmClaimOwner {
  threadId: string;
  generation: string;
}

export interface AutoVmClaimSlot {
  owner: AutoVmClaimOwner;
  /** Runs the exclusive claim sequence: bind, lease, boot. At most once. */
  claim: () => Promise<void>;
  /** Set by startAutoVmClaim; presence means the claim already fired. */
  begin?: Promise<void>;
  /** Set when the fired claim rejected. The slot stays so the gate keeps
   * refusing screen calls for this generation instead of forwarding them
   * onto a VM the turn never claimed (gate finding F1). */
  failed?: boolean;
  /** The rejection's message, so the gate can refuse honestly instead of
   * blaming another thread. */
  failure?: string;
  /** Set when the fired claim resolved: this turn now holds the desktop. */
  claimed?: boolean;
  /** True when dispatch mounted the computer tools without claiming, so
   * the gate must fire the claim on the first screen call. Eager attaches
   * register the same slot shape but never need the gate. */
  lazy?: boolean;
  /** What the gate calls this computer when a fired claim has failed
   * ("the Local VM", "the VPS computer"). The table serves every lazily
   * claimed desktop, not only the Local VM it was written for. */
  label?: string;
}

export type AutoVmClaimTable = Map<string, AutoVmClaimSlot>;

/** Fire a thread's lazy claim exactly once, fenced by the dispatch
 * generation. A rejected claim KEEPS the slot and marks it failed: the
 * computer-control gate then keeps answering held for that generation, so
 * the bridge refuses every later screen call instead of forwarding it onto
 * a VM this turn never claimed. `begin` staying set means the claim never
 * re-fires; turn settle (releaseTurnResources / releaseLocalVmThread in
 * index.ts) clears the slot, fenced by owner generation. A rejection
 * mutates only the slot it fired from, so a stale claim can never remove
 * or mark a newer generation's slot on the same thread. */
export function startAutoVmClaim(table: AutoVmClaimTable, threadId: string, generation: string): void {
  const slot = table.get(threadId);
  if (!slot || slot.owner.threadId !== threadId || slot.owner.generation !== generation || slot.begin) return;
  slot.begin = slot.claim().then(
    () => { slot.claimed = true; },
    (error: unknown) => {
      slot.failed = true;
      slot.failure = error instanceof Error ? error.message : String(error);
    },
  );
}
