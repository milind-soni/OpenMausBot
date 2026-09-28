/** Consent, cost, and idle-stop policy for overflowing a local computer
 * wait onto a per-second-billed cloud seat (#1655).
 *
 * Like server/claim-idle.ts this module is deliberately synchronous and
 * clock-injected: the server decides every transition on its single
 * thread and tests pin time exactly. Nothing here starts or stops a
 * machine — the wiring does, and only when the decision says to. Keep
 * this module free of server imports. */

import { computerWaitDuration } from "./computer-wait.ts";

/** Default idle stop: a cloud seat no real screen work has touched for
 * this long is stopped (archived), because billing runs per second while
 * it runs. "A few idle minutes" per the issue. */
export const CLOUD_SEAT_IDLE_STOP_MS = 5 * 60_000;

/** Retry cadence for an idle stop that failed (#1655): the first retry
 * after one minute, doubling per failure up to ten. A failed stop keeps
 * its lease — the seat still bills — so the sweep always retries instead
 * of abandoning a running machine. */
export const CLOUD_SEAT_SLEEP_RETRY_MS = 60_000;
export const CLOUD_SEAT_SLEEP_RETRY_MAX_MS = 10 * 60_000;

/** What the wait loop should do about cloud overflow, evaluated fresh on
 * every poll. `off` is fail-closed: the feature is disabled, the cloud
 * is not usable, or no per-second cost is configured — no card, no
 * start, and never an invented price. `offer` posts the consent card
 * once per conversation. `start` is the only path that may start a
 * seat, and it requires consent that already exists. */
export type CloudOverflowAction =
  | { kind: "off" }
  | { kind: "none" }
  | { kind: "offer" }
  | { kind: "start" };

export interface CloudOverflowSituation {
  featureEnabled: boolean;
  cloudConfigured: boolean;
  /** The operator's own verified rate; null means do not guess. */
  perSecondCostUsd: number | null;
  consented: boolean;
  offered: boolean;
  started: boolean;
}

export function cloudOverflowAction(situation: CloudOverflowSituation): CloudOverflowAction {
  if (!situation.featureEnabled || !situation.cloudConfigured || situation.perSecondCostUsd === null) return { kind: "off" };
  if (situation.started) return { kind: "none" };
  if (situation.consented) return { kind: "start" };
  if (situation.offered) return { kind: "none" };
  return { kind: "offer" };
}

/** Per-conversation consent plus the offer bookkeeping that keeps the
 * card to one per conversation until it is revoked. A thread the operator
 * allowlisted in config carries standing consent and never needs the
 * card. */
export class CloudOverflowConsent {
  private readonly grants = new Map<string, { at: number; perSecondCostUsd: number }>();
  private readonly offers = new Map<string, { at: number; perSecondCostUsd: number }>();
  private readonly revocations = new Set<string>();

  /** Consent for this conversation. With `perSecondCostUsd`, a card
   * consent counts only at the rate its card showed — an allowlisted
   * thread carries the operator's standing consent, and the operator is
   * also the one who sets the rate. */
  consented(threadId: string, allowlistedThreads: ReadonlySet<string> = new Set(), perSecondCostUsd?: number): boolean {
    if (this.revocations.has(threadId)) return false;
    if (allowlistedThreads.has(threadId)) return true;
    const grant = this.grants.get(threadId);
    if (!grant) return false;
    return perSecondCostUsd === undefined || grant.perSecondCostUsd === perSecondCostUsd;
  }

  /** `perSecondCostUsd` is the rate the answered card showed. */
  grant(threadId: string, perSecondCostUsd: number, now = Date.now()): void {
    this.revocations.delete(threadId);
    this.grants.set(threadId, { at: now, perSecondCostUsd });
  }

  /** Revoking also clears the offered mark, so a later wait in the same
   * conversation may ask again instead of meeting silence. */
  revoke(threadId: string): boolean {
    const had = this.grants.delete(threadId);
    this.revocations.add(threadId);
    this.offers.delete(threadId);
    return had;
  }

  /** A card is outstanding for this conversation — at the given rate
   * when one is supplied, so a config change re-offers with the new
   * price instead of meeting silence at the old one. */
  offered(threadId: string, perSecondCostUsd?: number): boolean {
    const offer = this.offers.get(threadId);
    if (!offer) return false;
    return perSecondCostUsd === undefined || offer.perSecondCostUsd === perSecondCostUsd;
  }

  /** The rate the outstanding card showed, or null when no card is out. */
  offeredRate(threadId: string): number | null {
    return this.offers.get(threadId)?.perSecondCostUsd ?? null;
  }

  markOffered(threadId: string, perSecondCostUsd: number, now = Date.now()): void {
    this.offers.set(threadId, { at: now, perSecondCostUsd });
  }
}

/** One running cloud seat started by overflow. `touch` is called only
 * for real computer tool completions on that seat — screen-poller frames
 * never reach it, exactly like #1653's activity clock, so preview
 * traffic cannot keep a paid machine awake. */
export class CloudSeatLease {
  readonly botId: string;
  readonly threadId: string;
  /** The claim generation that started the seat: a stop releases the Box
   * claim for exactly this owner, never a newer turn's. */
  readonly generation: string;
  readonly startedAt: number;
  readonly idleStopMs: number;
  private lastActivityAt: number;
  private sleepRetryNotBefore = 0;
  private sleepRetryMs = CLOUD_SEAT_SLEEP_RETRY_MS;

  constructor(init: { botId: string; threadId: string; generation: string; now?: number; idleStopMs?: number }) {
    const idleStopMs = init.idleStopMs ?? CLOUD_SEAT_IDLE_STOP_MS;
    if (!Number.isFinite(idleStopMs) || idleStopMs <= 0) throw new Error("Cloud seat idle stop window must be positive");
    this.botId = init.botId;
    this.threadId = init.threadId;
    this.generation = init.generation;
    this.startedAt = init.now ?? Date.now();
    this.lastActivityAt = this.startedAt;
    this.idleStopMs = idleStopMs;
  }

  touch(now = Date.now()): void {
    this.lastActivityAt = now;
    // Real work earns a fresh stop attempt: the backoff only paces
    // retries against an idle seat that keeps failing to sleep.
    this.sleepRetryNotBefore = 0;
    this.sleepRetryMs = CLOUD_SEAT_SLEEP_RETRY_MS;
  }

  /** An idle stop may run now — true until a failure defers it. */
  sleepDue(now = Date.now()): boolean {
    return now >= this.sleepRetryNotBefore;
  }

  /** The idle stop failed: keep the lease and back off, bounded, so the
   * sweep retries gently instead of hammering a sick Box — and never
   * abandons a seat that still bills. */
  deferSleep(now = Date.now()): void {
    this.sleepRetryNotBefore = now + this.sleepRetryMs;
    this.sleepRetryMs = Math.min(this.sleepRetryMs * 2, CLOUD_SEAT_SLEEP_RETRY_MAX_MS);
  }

  idleFor(now = Date.now()): number {
    return Math.max(0, now - this.lastActivityAt);
  }

  idleElapsed(now = Date.now()): boolean {
    return now - this.lastActivityAt >= this.idleStopMs;
  }
}

/** Dollars per second at rate-card precision: enough places for small
 * per-second rates to stay visible, trailing zeros trimmed but never
 * past two decimals. */
export function formatPerSecondUsd(perSecondCostUsd: number): string {
  let text = perSecondCostUsd.toFixed(6).replace(/0+$/, "");
  if (text.endsWith(".")) text += "00";
  else {
    const decimals = text.length - text.indexOf(".") - 1;
    if (decimals < 2) text += "0".repeat(2 - decimals);
  }
  return "$" + text;
}

/** The consent card (#1655): the per-second cost sits beside the local
 * wait picture before any choice is made, and nothing starts without an
 * explicit consent the person still has to give. */
export function cloudOverflowOfferText(opts: { perSecondCostUsd: number; waitEstimateMs?: number; idleStopMs?: number }): string {
  const idleStopMs = opts.idleStopMs ?? CLOUD_SEAT_IDLE_STOP_MS;
  const estimate = opts.waitEstimateMs === undefined ? "" : ` Recent local waits here have taken about ${computerWaitDuration(opts.waitEstimateMs)}.`;
  return `This computer is busy. Its work can overflow to a cloud computer for ${formatPerSecondUsd(opts.perSecondCostUsd)} per second.${estimate} Nothing starts without your consent — allow cloud overflow for this conversation to start it; the cloud computer stops after ${computerWaitDuration(idleStopMs)} idle.`;
}

export function cloudSeatStartedText(opts: { perSecondCostUsd: number; idleStopMs?: number }): string {
  const idleStopMs = opts.idleStopMs ?? CLOUD_SEAT_IDLE_STOP_MS;
  return `Cloud computer started at ${formatPerSecondUsd(opts.perSecondCostUsd)} per second. It stops automatically after ${computerWaitDuration(idleStopMs)} idle, and the local wait continues until this computer is free.`;
}

export function cloudSeatStoppedText(idleMs: number): string {
  return `Cloud computer stopped after ${computerWaitDuration(idleMs)} idle — billing pauses while it sleeps.`;
}

export function cloudOverflowConsentText(allowed: boolean, idleStopMs: number = CLOUD_SEAT_IDLE_STOP_MS): string {
  return allowed
    ? `Cloud overflow allowed for this conversation. A waiting turn may start the cloud computer; it stops after ${computerWaitDuration(idleStopMs)} idle.`
    : "Cloud overflow consent revoked. Waits stay local, and no cloud computer starts without a new consent.";
}
