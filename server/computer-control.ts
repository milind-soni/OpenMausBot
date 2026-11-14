// Who drives a bot's computer. A bot can only ask for hands (requestHelp); only the person takes and releases. While the
// person holds control the bot's actions are refused, never queued: a queued click would land on whatever is under it later.
// A plea is settled only by its sign-in card. In memory on purpose: a hold that survived a restart would brick the computer.

import type { ComputerHelpRef } from "../shared/wire.ts";

export interface ControlSnapshot {
  /** True while the person is driving; the bot's hands are refused. */
  held: boolean;
  helpReason: string | null;
  heldSinceMs: number | null;
  help?: ComputerHelpRef;
}

export interface ControlLeaseResult {
  snapshot: ControlSnapshot;
  owned: boolean;
  /** True only when this call changed an unheld record into a held one. */
  acquired: boolean;
}

export interface ControlLeaseReleaseResult {
  snapshot: ControlSnapshot;
  /** True only when this call removed a hold owned by the supplied lease. */
  released: boolean;
}

const NO_CONTROL: ControlSnapshot = { held: false, helpReason: null, heldSinceMs: null };
const MAX_REASON_CHARS = 280;
const LEASE_GRACE_MS = 60_000;

interface Entry {
  heldSinceMs: number | null;
  /** Open pleas, oldest first; the newest whose card still waits is the one shown. */
  pleas: Array<{ reason: string; ref: ComputerHelpRef }>;
  /** Opaque workspace lease. It is deliberately absent from every snapshot. */
  controlLeaseId: string | null;
  expiry?: ReturnType<typeof setTimeout>;
}

export class ComputerControl {
  private entries = new Map<string, Entry>();
  private onChange: (botId: string, snapshot: ControlSnapshot) => void;
  private now: () => number;
  private waits: (ref: ComputerHelpRef) => boolean;

  constructor(
    onChange: (botId: string, snapshot: ControlSnapshot) => void = () => {},
    now: () => number = Date.now,
    /** Whether a plea's sign-in card still waits for the person. A plea whose card stopped, left the active branch or lost its
     * conversation is kept but neither shown nor counted, and counts again if its card waits again. */
    waits: (ref: ComputerHelpRef) => boolean = () => true,
  ) {
    this.onChange = onChange;
    this.now = now;
    this.waits = waits;
  }

  private waiting(entry: Entry): Entry["pleas"] {
    return entry.pleas.filter((plea) => this.waits(plea.ref));
  }

  snapshot(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (!entry) return NO_CONTROL;
    const plea = this.waiting(entry).at(-1);
    return {
      held: entry.heldSinceMs !== null,
      helpReason: plea?.reason ?? null,
      heldSinceMs: entry.heldSinceMs,
      ...(plea ? { help: plea.ref } : {}),
    };
  }

  /** Idempotent: a second click must not reset `heldSinceMs`. */
  take(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (entry?.heldSinceMs != null) return this.snapshot(botId);
    this.entries.set(botId, { heldSinceMs: this.now(), pleas: entry?.pleas ?? [], controlLeaseId: null });
    return this.changed(botId);
  }

  /**
   * The opaque lease is never returned in a snapshot, broadcast or API response.
   * `armed` starts the expiry clock at once, as a beat would, when the lease owns the hold.
   */
  acquireLease(botId: string, controlLeaseId: string, options: { armed?: boolean } = {}): ControlLeaseResult {
    const entry = this.entries.get(botId);
    if (entry?.heldSinceMs != null) {
      const owned = entry.controlLeaseId === controlLeaseId;
      if (owned && options.armed) this.beat(botId, controlLeaseId);
      return { snapshot: this.snapshot(botId), owned, acquired: false };
    }
    this.entries.set(botId, { heldSinceMs: this.now(), pleas: entry?.pleas ?? [], controlLeaseId });
    if (options.armed) this.beat(botId, controlLeaseId);
    return { snapshot: this.changed(botId), owned: true, acquired: true };
  }

  /** The key whose hold this lease owns: the first, should a client reuse one lease for several takes. */
  heldBy(controlLeaseId: string): string | undefined {
    for (const [key, entry] of this.entries) if (entry.heldSinceMs !== null && entry.controlLeaseId === controlLeaseId) return key;
    return undefined;
  }

  ownsLease(botId: string, controlLeaseId: string): boolean {
    const entry = this.entries.get(botId);
    return entry?.heldSinceMs != null && entry.controlLeaseId === controlLeaseId;
  }

  /**
   * Answers as `ownsLease`; when owned, the hold is released 60 s after the latest beat.
   * A hold that never beats never expires.
   */
  beat(botId: string, controlLeaseId: string): boolean {
    const entry = this.entries.get(botId);
    if (!entry || !this.ownsLease(botId, controlLeaseId)) return false;
    clearTimeout(entry.expiry);
    entry.expiry = setTimeout(() => this.releaseLease(botId, controlLeaseId), LEASE_GRACE_MS);
    entry.expiry.unref?.();
    return true;
  }

  /** An open plea stays: handing back is not answering the card that asked. */
  release(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (!entry || (entry.heldSinceMs === null && entry.pleas.length)) return this.snapshot(botId);
    this.drop(botId, entry);
    return this.changed(botId);
  }

  /** A newer or legacy holder is observed but never disturbed. */
  releaseLease(botId: string, controlLeaseId: string): ControlLeaseReleaseResult {
    const entry = this.entries.get(botId);
    if (!entry || entry.heldSinceMs === null || entry.controlLeaseId !== controlLeaseId) {
      return { snapshot: this.snapshot(botId), released: false };
    }
    this.drop(botId, entry);
    return { snapshot: this.changed(botId), released: true };
  }

  /** Open pleas on this key whose cards still wait, oldest first. */
  pleas(botId: string): ComputerHelpRef[] {
    const entry = this.entries.get(botId);
    return entry ? this.waiting(entry).map((plea) => plea.ref) : [];
  }

  /** Never grants anything by itself; the same card asking again replaces its own plea. */
  requestHelp(botId: string, reason: unknown, ref: ComputerHelpRef): ControlSnapshot {
    const text = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON_CHARS) : "";
    const entry = this.entries.get(botId) ?? { heldSinceMs: null, pleas: [], controlLeaseId: null };
    entry.pleas = [...entry.pleas.filter((plea) => plea.ref.messageId !== ref.messageId),
      { reason: text || `sign in to ${ref.site}`, ref }];
    this.entries.set(botId, entry);
    return this.changed(botId);
  }

  settleHelp(messageId: string): string[] {
    const settled: string[] = [];
    for (const [botId, entry] of this.entries) {
      if (!entry.pleas.some((plea) => plea.ref.messageId === messageId)) continue;
      entry.pleas = entry.pleas.filter((plea) => plea.ref.messageId !== messageId);
      if (entry.heldSinceMs === null && !entry.pleas.length) this.entries.delete(botId);
      settled.push(botId);
      this.changed(botId);
    }
    return settled;
  }

  /** Removes the deleted bot's pleas from every key; holds stay. */
  forgetBot(botId: string): void {
    this.forgetPleas((ref) => ref.botId === botId);
  }

  /** Removes the pleas of a deleted conversation's sign-in cards from every key, and returns the bots that asked; holds stay. */
  forgetThread(threadId: string): string[] {
    return this.forgetPleas((ref) => ref.threadId === threadId);
  }

  /** Tells every key with a plea from these conversations that its cards may have stopped or started waiting, and returns the
   * bots that asked. */
  recheck(threadIds: Iterable<string>): string[] {
    const threads = new Set(threadIds), askers = new Set<string>();
    for (const [key, entry] of this.entries) {
      const asked = entry.pleas.filter((plea) => threads.has(plea.ref.threadId));
      for (const plea of asked) askers.add(plea.ref.botId);
      if (asked.length) this.changed(key);
    }
    return [...askers];
  }

  private forgetPleas(gone: (ref: ComputerHelpRef) => boolean): string[] {
    const askers = new Set<string>();
    for (const [key, entry] of this.entries) {
      const pleas = entry.pleas.filter((plea) => !gone(plea.ref));
      if (pleas.length === entry.pleas.length) continue;
      for (const plea of entry.pleas) if (gone(plea.ref)) askers.add(plea.ref.botId);
      entry.pleas = pleas;
      if (entry.heldSinceMs === null && !pleas.length) this.entries.delete(key);
      this.changed(key);
    }
    return [...askers];
  }

  private drop(botId: string, entry: Entry): void {
    clearTimeout(entry.expiry);
    if (entry.pleas.length) this.entries.set(botId, { heldSinceMs: null, pleas: entry.pleas, controlLeaseId: null });
    else this.entries.delete(botId);
  }

  private changed(botId: string): ControlSnapshot {
    const snapshot = this.snapshot(botId);
    this.onChange(botId, snapshot);
    return snapshot;
  }
}
