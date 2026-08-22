// Noticing a bot that is going in circles: the same tool call, the same
// arguments, again and again in one turn. Nothing watched for that, and
// it is the user's money. This only OBSERVES — it counts and says so; the
// human has Stop. Cutting a call off, or steering the model, needs the
// harness to own the call or to be able to speak mid-turn, neither of which
// is true for CLI drivers today (see plan items 3.2 / 3.3).

/** Tool name plus its arguments, whitespace-normalized. A bare tool name
 * is not a call worth counting: "Bash" five times may be five different
 * commands, and Claude's item.started carries only the name. */
export function callKey(tool: string, args: string | undefined): string | null {
  const a = (args ?? "").replace(/\s+/g, " ").trim();
  if (!a || a === tool) return null;
  return `${tool}:${a}`;
}

export class RepeatDetector {
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly thresholds: readonly number[];
  private readonly maxKeysPerThread: number;

  constructor(opts: { thresholds: readonly number[]; maxKeysPerThread?: number }) {
    this.thresholds = [...opts.thresholds].sort((a, b) => a - b);
    this.maxKeysPerThread = opts.maxKeysPerThread ?? 256;
    if (!Number.isInteger(this.maxKeysPerThread) || this.maxKeysPerThread < 1) {
      throw new Error("maxKeysPerThread must be a positive integer");
    }
  }

  /** Count one call. `threshold` is set exactly when the count lands on one. */
  record(threadId: string, key: string): { count: number; threshold?: number } {
    let per = this.counts.get(threadId);
    if (!per) this.counts.set(threadId, (per = new Map()));
    const previous = per.get(key);
    // Keep a bounded, recency-ordered set instead of retaining every unique
    // command an arbitrarily long turn ever issued. Existing keys move to
    // the back; when full, the least-recently-seen signature falls out.
    if (previous !== undefined) per.delete(key);
    else if (per.size >= this.maxKeysPerThread) per.delete(per.keys().next().value!);
    const count = (previous ?? 0) + 1;
    per.set(key, count);
    return this.thresholds.includes(count) ? { count, threshold: count } : { count };
  }

  /** The turn ended: a new turn starts its own count. */
  settle(threadId: string) {
    this.counts.delete(threadId);
  }
}
