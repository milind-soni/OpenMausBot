import { USAGE_REFRESH_MS } from "./usage-types.ts";

/** Shared cadence gate for idle reads: multiple windows never multiply requests. */
export class UsageRefreshGate {
  private last = new Map<string, number>();
  private pending = new Set<string>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  async run(id: string, windowOpen: boolean, idle: boolean, read: () => Promise<void>): Promise<void> {
    if (!windowOpen || !idle || this.pending.has(id) || this.now() - (this.last.get(id) ?? -Infinity) < USAGE_REFRESH_MS) return;
    this.last.set(id, this.now());
    this.pending.add(id);
    try { await read(); } finally { this.pending.delete(id); }
  }
  noteRead(id: string) { this.last.set(id, this.now()); }
}
