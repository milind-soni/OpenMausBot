import type { YourComputerCall } from "../shared/your-computer.ts";

export interface AutoVmClaimOwner {
  threadId: string;
  generation: string;
}

export interface AutoVmClaimSlot {
  owner: AutoVmClaimOwner;
  /** Bind, lease, boot; again only after a network failure. `call` is what the first screen call would open. */
  claim: (call?: YourComputerCall) => Promise<void>;
  /** Set by startAutoVmClaim; presence means the claim already fired. */
  begin?: Promise<void>;
  /** The fired claim rejected; the slot stays so the gate keeps refusing screen calls instead of forwarding them to an unclaimed VM. */
  failed?: boolean;
  failure?: string;
  /** The last claim failed on the network; the next screen call claims again. */
  retryReason?: string;
  attempts?: number;
  claimed?: boolean;
  /** Dispatch mounted the computer tools without claiming, so the gate fires the claim on the first screen call. */
  lazy?: boolean;
  label?: string;
  localVm?: boolean;
  pendingReason?: string;
  boxId?: string;
  startsComputer?: true;
  /** Called once after the slot is marked failed, unless the person declined; the fail-closed refusal does not depend on it firing. */
  onRejected?: (failure: string, error?: unknown) => void;
}

export type AutoVmClaimTable = Map<string, AutoVmClaimSlot>;

export const MAX_CLAIM_ATTEMPTS = 3;
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

/** A claim that never got an answer: marked `transient`, a fetch timeout, or Node's fetch failing on a socket error (its `cause`). */
export function transientClaimFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const failure = current as { transient?: unknown; name?: unknown; code?: unknown };
    if (failure.transient === true || failure.name === "TimeoutError" || (typeof failure.code === "string" && NETWORK_CODES.has(failure.code))) return true;
  }
  return false;
}

/** Keeps a claim's network failure recognizable through a wrapper that rewords it for the person. */
export function keepTransient(original: unknown, shown: unknown): unknown {
  return shown instanceof Error && transientClaimFailure(original) ? Object.assign(shown, { transient: true }) : shown;
}

/** Once per dispatch generation, or again after a network failure, at most MAX_CLAIM_ATTEMPTS times. Any other rejection keeps
 * its slot marked failed, and a rejection mutates only the slot it fired from, so a stale claim never touches a newer generation's. */
export function startAutoVmClaim(table: AutoVmClaimTable, threadId: string, generation: string, call?: YourComputerCall): void {
  const slot = table.get(threadId);
  if (!slot || slot.owner.threadId !== threadId || slot.owner.generation !== generation || slot.begin || slot.failed) return;
  const attempt = (slot.attempts ?? 0) + 1;
  slot.attempts = attempt;
  slot.retryReason = undefined;
  const begin: Promise<void> = slot.claim(call).then(
    () => { slot.claimed = true; },
    (error: unknown) => {
      const failure = error instanceof Error ? error.message : String(error);
      if (transientClaimFailure(error) && attempt < MAX_CLAIM_ATTEMPTS) {
        slot.retryReason = failure;
        if (slot.begin === begin) slot.begin = undefined;
        return;
      }
      slot.failed = true;
      slot.failure = failure;
      // A person's No is an answer, not a failure: the screen calls say so, and nothing reports a broken turn.
      if ((error as { declined?: unknown } | null)?.declined !== true) slot.onRejected?.(slot.failure, error);
    },
  );
  slot.begin = begin;
}

export function lazyClaimRetryText(slot: Pick<AutoVmClaimSlot, "label" | "retryReason">): string {
  return `This turn could not reach ${slot.label ?? "this computer"} just now (${slot.retryReason}). This call was not performed; try it again in a moment.`;
}

export function settledWithin(work: Promise<unknown> | null, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
    work?.then(done, done);
  });
}

export function withinBudget<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
