import type { ThreadRows } from "./message-db.ts";
import type { Message } from "./store.ts";

export interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

/** A conversation nobody read or wrote for this long gives its parsed transcript back; the next read reloads it from messages.db. */
export const THREAD_IDLE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;

export class ThreadCache {
  private entries = new Map<string, { state: ThreadState; usedAt: number }>();
  private sweptAt = Date.now();
  private readonly busyThreadIds: () => ReadonlySet<string>;

  constructor(busyThreadIds: () => ReadonlySet<string>) {
    this.busyThreadIds = busyThreadIds;
  }

  get(threadId: string): ThreadState | undefined {
    const now = Date.now();
    this.sweep(now);
    const entry = this.entries.get(threadId);
    if (entry) entry.usedAt = now;
    return entry?.state;
  }

  /** Rows stored without a parentId chain onto the row before them. */
  load(threadId: string, rows: ThreadRows): ThreadState {
    const { messages } = rows;
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    const state = { messages, activeLeafId: rows.activeLeafId || (messages.at(-1)?.id ?? null) };
    this.entries.set(threadId, { state, usedAt: Date.now() });
    return state;
  }

  delete(threadId: string): void {
    this.entries.delete(threadId);
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    if (now - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = now;
    let busy: ReadonlySet<string> | undefined;
    for (const [threadId, entry] of this.entries) {
      if (now - entry.usedAt < THREAD_IDLE_MS) continue;
      busy ??= this.busyThreadIds();
      if (!busy.has(threadId)) this.entries.delete(threadId);
    }
  }
}
