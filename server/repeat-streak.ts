// Stuck means the same shell command failing the same way, back to back; a success ends the streak, since a poll is work.
import { createHash } from "node:crypto";

import { previewIsPartial } from "./tool-summary.ts";

/** Muse Code cuts tool output at 4,000 characters without a marker, so an output this long may be a prefix. */
export const OUTCOME_TEXT_MAX = 4_000;

/** Only a digest of the output is kept, never the text. Null for a success and for output that may be cut or masked. */
export function failureDigest(ok: boolean, output: string | undefined): string | null {
  if (ok || output === undefined || !output.trim() || output.length >= OUTCOME_TEXT_MAX || previewIsPartial(output)) return null;
  return createHash("sha256").update(output).digest("base64");
}

interface Turn<C> {
  /** Null: a command the harness could not see whole. */
  pending: Map<string, C | null>;
  last?: { key: string; failure: string; streak: number };
}

export class RepeatStreak<C extends { readonly key: string }> {
  private readonly turns = new Map<string, Turn<C>>();
  private readonly maxPending: number;

  constructor(opts: { maxPending?: number } = {}) {
    this.maxPending = opts.maxPending ?? 256;
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1) {
      throw new Error("maxPending must be a positive integer");
    }
  }

  /** A null `call` still ran, so it ends the streak when it completes; one without an item id ends it now. */
  started(threadId: string, itemId: string | undefined, call: C | null): void {
    let turn = this.turns.get(threadId);
    if (!turn) this.turns.set(threadId, (turn = { pending: new Map() }));
    if (itemId === undefined) return void delete turn.last;
    turn.pending.delete(itemId);
    if (turn.pending.size >= this.maxPending) turn.pending.delete(turn.pending.keys().next().value!);
    turn.pending.set(itemId, call);
  }

  /** An item this did not track (a read or an edit between two runs) leaves the streak alone. */
  completed(threadId: string, itemId: string | undefined, failure: string | null): { call: C; streak: number } | null {
    const turn = this.turns.get(threadId);
    if (!turn || itemId === undefined || !turn.pending.has(itemId)) return null;
    const call = turn.pending.get(itemId) ?? null;
    turn.pending.delete(itemId);
    if (call === null || failure === null) {
      delete turn.last;
      return null;
    }
    const streak = turn.last?.key === call.key && turn.last.failure === failure ? turn.last.streak + 1 : 1;
    turn.last = { key: call.key, failure, streak };
    return { call, streak };
  }

  settle(threadId: string): void {
    this.turns.delete(threadId);
  }
}
