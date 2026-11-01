// Observes only: counts a repeated tool call in one turn and says so; the person has Stop.

/** Null for a bare tool name: Claude's item.started carries only the name, and five "Bash" calls may be five commands. */
export function callKey(tool: string, args: string | undefined): string | null {
  const a = (args ?? "").replace(/\s+/g, " ").trim();
  if (!a || a === tool) return null;
  return `${tool}:${a}`;
}

/** Cursor's ACP adapter titles every MCP call "MCP: tool" and sends an empty input: like a bare tool name, it names no call. */
const NAMELESS_TITLE = /^MCP:\s*tool$/i;

/** Antigravity's ACP adapter titles every call alike ("Running list_directory") and carries what differs only in the input. */
export function toolItemKey(title: string | undefined, input: string | undefined): string | null {
  const t = (title ?? "").trim();
  if (!/\s|\//.test(t)) return null;
  if (!input && NAMELESS_TITLE.test(t)) return null;
  return input ? `tool:${JSON.stringify([t, input])}` : callKey("tool", t);
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

  record(threadId: string, key: string): { count: number; threshold?: number } {
    let per = this.counts.get(threadId);
    if (!per) this.counts.set(threadId, (per = new Map()));
    const previous = per.get(key);
    if (previous !== undefined) per.delete(key);
    else if (per.size >= this.maxKeysPerThread) per.delete(per.keys().next().value!);
    const count = (previous ?? 0) + 1;
    per.set(key, count);
    return this.thresholds.includes(count) ? { count, threshold: count } : { count };
  }

  settle(threadId: string) {
    this.counts.delete(threadId);
  }
}
