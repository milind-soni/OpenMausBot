/** Quiet-window policy for releasing a held seat while its turn lives.
 *
 * The policy is deliberately synchronous and clock-injected: like the
 * claim map it serves, expiry is evaluated when a claim is touched
 * (claim, blocker, owns) rather than by a timer, so the server's single
 * thread decides every transition and tests pin time exactly. Slice
 * #1655 reuses this window math for its own idle release; keep this
 * module free of server imports. */

/** Default quiet window: no screen activity for this long releases the seat. */
export const COMPUTER_CLAIM_QUIET_MS = 90_000;
/** Default reclaim window: the previous holder re-claims directly for this long. */
export const COMPUTER_CLAIM_RECLAIM_MS = 10 * 60_000;

export class IdleReleasePolicy {
  readonly quietMs: number;
  readonly reclaimMs: number;

  constructor(quietMs: number = COMPUTER_CLAIM_QUIET_MS, reclaimMs: number = COMPUTER_CLAIM_RECLAIM_MS) {
    if (!Number.isFinite(quietMs) || quietMs <= 0) throw new Error("Idle release quiet window must be positive");
    if (!Number.isFinite(reclaimMs) || reclaimMs <= 0) throw new Error("Idle release reclaim window must be positive");
    this.quietMs = quietMs;
    this.reclaimMs = reclaimMs;
  }

  /** True once the seat has been quiet for the full window. Screen-poller
   * frames never refresh the activity clock, so they cannot keep a seat. */
  quietElapsed(lastActivityAt: number, now: number): boolean {
    return now - lastActivityAt >= this.quietMs;
  }

  /** True while a released seat's previous holder still re-claims directly. */
  reclaimLive(releasedAt: number, now: number): boolean {
    return now < releasedAt + this.reclaimMs;
  }
}
