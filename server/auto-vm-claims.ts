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
  /** This claim mounts a local workspace, not a remote Boat/VPS desktop. */
  localVm?: boolean;
  /** How long a computer call waits on this claim before it is answered,
   * when the claim itself is slow: a cloud computer that has to be created
   * or woken takes up to a minute. A slow claim is waited on by every call
   * while it runs, not only by the call that fired it. Unset: the gate's
   * short default, for a desktop that claims at once. */
  graceMs?: number;
  /** What the gate answers while this claim is still running, instead of
   * the contention text a fast claim earns. */
  pendingReason?: string;
  /** The Boat a cloud computer's claim created or woke (mountBotBoat):
   * its tools reach that Boat once the claim has landed. */
  boxId?: string;
  /** The claim itself creates or wakes the computer (mountBotBoat), so that
   * computer is this turn's even before it is up: select_computer counts it
   * as selected. The other lazy claims only lease a desktop that is up. */
  startsComputer?: true;
  /** Called once, after the slot is marked failed, when the fired claim
   * rejected (issue #1369): the turn surfaces a terminal error and ends
   * instead of staying busy behind a gate that can only refuse. The
   * fail-closed refusal below does not depend on it firing. `error` is what
   * the claim threw, so a failure already read as a place keeps its row. */
  onRejected?: (failure: string, error?: unknown) => void;
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
      slot.onRejected?.(slot.failure, error);
    },
  );
}

/** How long a computer call should wait on its thread's lazy claim, or null
 * when it should not wait: the first call waits while the claim it fires
 * lands; a slow claim (graceMs) is waited on by every call until it settles. */
export function lazyClaimWaitMs(slot: AutoVmClaimSlot | undefined, defaultGraceMs: number): number | null {
  if (!slot?.lazy) return null;
  if (!slot.begin) return slot.graceMs ?? defaultGraceMs;
  if (slot.graceMs !== undefined && !slot.claimed && !slot.failed) return slot.graceMs;
  return null;
}
