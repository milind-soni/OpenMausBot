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

interface Entry {
  heldSinceMs: number | null;
  /** Open pleas, oldest first; the newest is the one shown. */
  pleas: Array<{ reason: string; ref: ComputerHelpRef }>;
  /** Opaque workspace lease. It is deliberately absent from every snapshot. */
  controlLeaseId: string | null;
}

export class ComputerControl {
  private entries = new Map<string, Entry>();
  private onChange: (botId: string, snapshot: ControlSnapshot) => void;
  private now: () => number;

  constructor(
    onChange: (botId: string, snapshot: ControlSnapshot) => void = () => {},
    now: () => number = Date.now,
  ) {
    this.onChange = onChange;
    this.now = now;
  }

  snapshot(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (!entry) return NO_CONTROL;
    const plea = entry.pleas.at(-1);
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

  /** The opaque lease is never returned in a snapshot, broadcast or API response. */
  acquireLease(botId: string, controlLeaseId: string): ControlLeaseResult {
    const entry = this.entries.get(botId);
    if (entry?.heldSinceMs != null) {
      return {
        snapshot: this.snapshot(botId),
        owned: entry.controlLeaseId === controlLeaseId,
        acquired: false,
      };
    }
    this.entries.set(botId, { heldSinceMs: this.now(), pleas: entry?.pleas ?? [], controlLeaseId });
    return { snapshot: this.changed(botId), owned: true, acquired: true };
  }

  ownsLease(botId: string, controlLeaseId: string): boolean {
    const entry = this.entries.get(botId);
    return entry?.heldSinceMs != null && entry.controlLeaseId === controlLeaseId;
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

  /** Open pleas on this key, oldest first. */
  pleas(botId: string): ComputerHelpRef[] {
    return this.entries.get(botId)?.pleas.map((plea) => plea.ref) ?? [];
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

  forget(botId: string): void {
    if (this.entries.delete(botId)) this.onChange(botId, NO_CONTROL);
  }

  private drop(botId: string, entry: Entry): void {
    if (entry.pleas.length) this.entries.set(botId, { heldSinceMs: null, pleas: entry.pleas, controlLeaseId: null });
    else this.entries.delete(botId);
  }

  private changed(botId: string): ControlSnapshot {
    const snapshot = this.snapshot(botId);
    this.onChange(botId, snapshot);
    return snapshot;
  }
}
