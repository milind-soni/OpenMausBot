// Who is driving a bot's computer — the person or the bot. One record per
// bot, held in the harness because every consumer (the panel, the SSE
// stream, and the per-turn computer proxies) already talks to the harness.
//
// The rules this module exists to enforce:
//   - A bot can only ASK for hands (`requestHelp`); it can never take
//     control, and it cannot clear a hold. Only the person takes and
//     releases, from the computer panel.
//   - While the person holds control, the bot's computer actions are
//     REFUSED by the proxies, not queued. A queued click would land after
//     the person has moved on, on whatever happens to be under it.
//   - Releasing control also settles any open help request, so a bot
//     waiting on `requestHelp` wakes up from the same state change the
//     person made — there is no separate "done helping" step to forget.
//
// State is per-boot and in-memory on purpose: a hold is a live fact about
// who is at the screen right now, and surviving a harness restart would
// mean a stale hold silently bricking a bot's computer.

export interface ControlSnapshot {
  /** True while the person is driving; the bot's hands are refused. */
  held: boolean;
  /** The bot's open plea for help, verbatim, or null when none is open. */
  helpReason: string | null;
  heldSinceMs: number | null;
}

export interface ControlLeaseResult {
  snapshot: ControlSnapshot;
  /** True only when this lease currently owns the hold. */
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
/** Keep a shouted help reason card-sized; the transcript has the rest. */
const MAX_REASON_CHARS = 280;

interface Entry {
  heldSinceMs: number | null;
  helpReason: string | null;
  helpRequestId: string | null;
  /** Opaque workspace lease. It is deliberately absent from every snapshot. */
  controlLeaseId: string | null;
}

export class ComputerControl {
  private entries = new Map<string, Entry>();
  private onChange: (botId: string, snapshot: ControlSnapshot) => void;
  private now: () => number;
  private requestSequence = 0;

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
    return {
      held: entry.heldSinceMs !== null,
      helpReason: entry.helpReason,
      heldSinceMs: entry.heldSinceMs,
    };
  }

  /** The person takes the wheel. Idempotent — a second click must not
   * reset `heldSinceMs` and make the hold look newer than it is. */
  take(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (entry?.heldSinceMs != null) return this.snapshot(botId);
    this.entries.set(botId, {
      heldSinceMs: this.now(),
      helpReason: entry?.helpReason ?? null,
      helpRequestId: entry?.helpRequestId ?? null,
      controlLeaseId: null,
    });
    return this.changed(botId);
  }

  /** Atomically take or re-check a workspace-owned hold. The opaque lease is
   * never returned in a snapshot, broadcast, or API response. */
  acquireLease(botId: string, controlLeaseId: string): ControlLeaseResult {
    const entry = this.entries.get(botId);
    if (entry?.heldSinceMs != null) {
      return {
        snapshot: this.snapshot(botId),
        owned: entry.controlLeaseId === controlLeaseId,
        acquired: false,
      };
    }
    this.entries.set(botId, {
      heldSinceMs: this.now(),
      helpReason: entry?.helpReason ?? null,
      helpRequestId: entry?.helpRequestId ?? null,
      controlLeaseId,
    });
    return { snapshot: this.changed(botId), owned: true, acquired: true };
  }

  /** The person hands the wheel back. Also settles any open help request —
   * the waiting bot resumes from this one state change. */
  release(botId: string): ControlSnapshot {
    if (!this.entries.has(botId)) return NO_CONTROL;
    this.entries.delete(botId);
    return this.changed(botId);
  }

  /** Release only the hold created by this workspace lease. A newer or legacy
   * holder is observed but never disturbed. */
  releaseLease(botId: string, controlLeaseId: string): ControlLeaseReleaseResult {
    const entry = this.entries.get(botId);
    if (!entry || entry.heldSinceMs === null || entry.controlLeaseId !== controlLeaseId) {
      return { snapshot: this.snapshot(botId), released: false };
    }
    this.entries.delete(botId);
    return { snapshot: this.changed(botId), released: true };
  }

  /** The bot asks the person to take over. Never grants anything by
   * itself — it only surfaces the plea. A reason shouted while the person
   * is already driving is kept, but must not clobber an earlier one they
   * may still be reading. */
  requestHelp(botId: string, reason: unknown): ControlSnapshot {
    return this.requestHelpLease(botId, reason).snapshot;
  }

  /** Open a help request and return the lease that owns it. A proxy uses
   * this id to expire only its own unanswered plea when its wait ends. */
  requestHelpLease(botId: string, reason: unknown): { snapshot: ControlSnapshot; requestId: string } {
    const text = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON_CHARS) : "";
    const entry = this.entries.get(botId) ?? {
      heldSinceMs: null,
      helpReason: null,
      helpRequestId: null,
      controlLeaseId: null,
    };
    if (entry.helpReason === null) {
      entry.helpReason = text || "the bot asked you to take over";
      entry.helpRequestId = `${botId}-${++this.requestSequence}`;
    }
    this.entries.set(botId, entry);
    return { snapshot: this.changed(botId), requestId: entry.helpRequestId! };
  }

  /** The person declines without taking over; the waiting bot is told. */
  dismissHelp(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (!entry || entry.helpReason === null) return this.snapshot(botId);
    entry.helpReason = null;
    entry.helpRequestId = null;
    if (entry.heldSinceMs === null) this.entries.delete(botId);
    return this.changed(botId);
  }

  /** Expire an unanswered plea. The id comparison prevents an old proxy's
   * timeout from dismissing a newer request for the same bot. */
  expireHelp(botId: string, requestId: unknown): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (!entry || entry.helpRequestId !== requestId) return this.snapshot(botId);
    entry.helpReason = null;
    entry.helpRequestId = null;
    if (entry.heldSinceMs === null) this.entries.delete(botId);
    return this.changed(botId);
  }

  /** The bot is gone; a hold on a deleted bot's computer means nothing. */
  forget(botId: string): void {
    if (this.entries.delete(botId)) this.onChange(botId, NO_CONTROL);
  }

  private changed(botId: string): ControlSnapshot {
    const snapshot = this.snapshot(botId);
    this.onChange(botId, snapshot);
    return snapshot;
  }
}

/** Safely executes an async tool or desktop control call, catching runtime exceptions gracefully. */
export async function executeToolSafely<T>(
  toolName: string,
  fn: () => Promise<T>
): Promise<{ success: boolean; data?: T; error?: string }> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err: any) {
    const errorMessage = err?.message || String(err) || 'Unknown execution error';
    console.error(`[Tool Execution Error] Name: ${toolName} | Details: ${errorMessage}`);
    return {
      success: false,
      error: `Tool '${toolName}' failed to execute: ${errorMessage}`
    };
  }
}

