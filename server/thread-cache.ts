import type { ThreadRows } from "./message-db.ts";
import type { Message } from "./store.ts";

export interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

/** A conversation nobody read or wrote for this long gives its parsed transcript back; the next read reloads it from messages.db. */
export const THREAD_IDLE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;
/** Parsed transcripts kept in memory at most, as approxBytes counts them; OMB_THREAD_CACHE_MB overrides. Past it the
 * least recently used go first, but never a busy conversation's, the one just read, or one read in the last few seconds. */
export const THREAD_CACHE_MAX_BYTES = (Number(process.env.OMB_THREAD_CACHE_MB) > 0 ? Number(process.env.OMB_THREAD_CACHE_MB) : 256) * 1024 * 1024;
const MIN_RESIDENCY_MS = 5_000;

/** About what a value holds: its strings' lengths and a few bytes per field. Walks fields, never copies text. */
export function approxBytes(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length;
  if (value === null || typeof value !== "object" || depth > 8) return 8;
  let bytes = 16;
  if (Array.isArray(value)) for (const item of value) bytes += approxBytes(item, depth + 1);
  else for (const key in value) bytes += key.length + approxBytes((value as Record<string, unknown>)[key], depth + 1);
  return bytes;
}

interface Entry { state: ThreadState; usedAt: number; bytes: number }

export class ThreadCache {
  private entries = new Map<string, Entry>();
  private sweptAt = Date.now();
  private nextBudgetRetryAt = 0;
  private bytes = 0;
  private readonly busyThreadIds: () => ReadonlySet<string>;
  private readonly maxBytes: number;

  constructor(busyThreadIds: () => ReadonlySet<string>, maxBytes = THREAD_CACHE_MAX_BYTES) {
    this.busyThreadIds = busyThreadIds;
    this.maxBytes = maxBytes;
  }

  get(threadId: string): ThreadState | undefined {
    const now = Date.now();
    this.sweep(now);
    const entry = this.entries.get(threadId);
    if (!entry) return undefined;
    // Last in the map is the most recently used.
    entry.usedAt = now;
    this.entries.delete(threadId);
    this.entries.set(threadId, entry);
    // A burst of loads or busy turns can defer every eviction. Reads must
    // retry once those protections expire, even when no transcript grows.
    if (now >= this.nextBudgetRetryAt) this.shrink(threadId);
    return entry.state;
  }

  /** Rows stored without a parentId chain onto the row before them. */
  load(threadId: string, rows: ThreadRows): ThreadState {
    const { messages } = rows;
    let prev: string | null = null;
    let bytes = 0;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
      bytes += approxBytes(m);
    }
    const state = { messages, activeLeafId: rows.activeLeafId || (messages.at(-1)?.id ?? null) };
    this.delete(threadId);
    this.entries.set(threadId, { state, usedAt: Date.now(), bytes });
    this.bytes += bytes;
    this.shrink(threadId);
    return state;
  }

  /** A cached transcript gained `added` (and lost `removed`, a message it replaced). */
  grew(threadId: string, added: Message, removed?: Message): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    const change = approxBytes(added) - (removed ? approxBytes(removed) : 0);
    entry.bytes += change;
    this.bytes += change;
    if (change > 0) this.shrink(threadId);
  }

  delete(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(threadId);
  }

  get size(): number {
    return this.entries.size;
  }

  get approxBytes(): number {
    return this.bytes;
  }

  private shrink(keep: string): void {
    if (this.bytes <= this.maxBytes) return;
    const now = Date.now();
    // Keep repeated reads cheap while every remaining entry is protected.
    this.nextBudgetRetryAt = now + MIN_RESIDENCY_MS;
    const busy = this.busyThreadIds();
    for (const [threadId, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      if (threadId === keep || busy.has(threadId) || now - entry.usedAt < MIN_RESIDENCY_MS) continue;
      this.delete(threadId);
    }
  }

  private sweep(now: number): void {
    if (now - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = now;
    let busy: ReadonlySet<string> | undefined;
    for (const [threadId, entry] of this.entries) {
      if (now - entry.usedAt < THREAD_IDLE_MS) continue;
      busy ??= this.busyThreadIds();
      if (!busy.has(threadId)) this.delete(threadId);
    }
  }
}
