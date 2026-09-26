// Short-lived overflow for built-in agents tools, not another history store.
// Authorize the live turn before using this cache; ownership is BOTH the bot
// and conversation, so room speakers and sibling threads cannot share IDs.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { redactSecretsInText } from "../shared/redact.ts";
import { writeFileAtomic } from "./atomic.ts";

export const TOOL_RESULT_PREVIEW_CHARS = 16_000;
export const TOOL_RESULT_MAX_CHARS = 128 * 1024;
export const TOOL_RESULT_TTL_MS = 60 * 60_000;
/** How long a durably spilled result outlives its cache entry. The cache
 * holds an hour; a summarized result's pointer has to outlive that by as
 * long as a thread might reasonably revisit one. */
export const TOOL_RESULT_DURABLE_MS = 30 * 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
const MAX_RESULTS = 128;
const MAX_RESULTS_PER_OWNER = 16;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_OWNER_BYTES = 2 * 1024 * 1024;

export function toolResultPrefix(text: string, chars: number): string {
  const prefix = text.slice(0, chars);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}

type Owner = { botId: string; threadId: string };
type SavedResult = Owner & { text: string; bytes: number; expiresAt: number; truncated: boolean };

export interface ToolResultsOptions {
  /** Where durable spill lives. Unset — the spawned proxies' default — keeps
   * this cache pure memory, exactly as before triage existed. */
  durableDir?: string;
}

/** Same sanitizing rule the MCP gate's spill uses, so both live under the
 * data directory without trusting a thread id as a path. */
function safeThreadId(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "thread";
}

/** Bounded in memory; lost on restart, expired after an hour, or evicted
 * oldest-first under pressure. Reads do not extend retention. The transcript
 * remains the durable record; this cache is only a way to page a large answer. */
export class ToolResults {
  private readonly results = new Map<string, SavedResult>();
  private readonly now: () => number;
  private readonly durableDir?: string;
  private lastSweep = 0;

  constructor(now: () => number = Date.now, options: ToolResultsOptions = {}) {
    this.now = now;
    this.durableDir = options.durableDir;
  }

  private expire(): void {
    const now = this.now();
    for (const [id, result] of this.results) {
      if (result.expiresAt <= now) this.results.delete(id);
    }
  }

  save(owner: Owner, text: string, truncated = false, durable = false) {
    this.expire();
    // Redact before taking the prefix, including a secret crossing its edge.
    const redacted = redactSecretsInText(text);
    const bounded = toolResultPrefix(redacted, TOOL_RESULT_MAX_CHARS);
    const result = { botId: owner.botId, threadId: owner.threadId, text: bounded, bytes: Buffer.byteLength(bounded),
      expiresAt: this.now() + TOOL_RESULT_TTL_MS, truncated: truncated || bounded.length < redacted.length };
    const id = `r-${randomUUID()}`;
    this.results.set(id, result);
    // At most 129 entries are inspected here. Enforce the owner's limit
    // before the global one so one noisy thread does not evict its neighbours.
    for (const ownOnly of [true, false]) {
      const entries = [...this.results].filter(([, entry]) => !ownOnly ||
        (entry.botId === owner.botId && entry.threadId === owner.threadId));
      let bytes = entries.reduce((sum, [, entry]) => sum + entry.bytes, 0);
      let count = entries.length;
      for (const [oldId, entry] of entries) {
        if (bytes <= (ownOnly ? MAX_OWNER_BYTES : MAX_BYTES) && count <= (ownOnly ? MAX_RESULTS_PER_OWNER : MAX_RESULTS)) break;
        this.results.delete(oldId);
        bytes -= entry.bytes;
        count--;
      }
    }
    if (durable && this.durableDir) this.spill(owner, id, result);
    this.sweepDurable();
    return { id, length: bounded.length, truncated: result.truncated, expiresAt: result.expiresAt };
  }

  /** Best effort: the cache entry is live either way, and a spill that
   * cannot be written only shortens retrievability, never correctness. */
  private spill(owner: Owner, id: string, result: SavedResult): void {
    if (!this.durableDir) return;
    try {
      const dir = join(this.durableDir, safeThreadId(owner.threadId));
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(join(dir, `${id}.json`), JSON.stringify(
        { botId: result.botId, threadId: result.threadId, text: result.text, truncated: result.truncated }), { mode: 0o600 });
    } catch { /* best effort */ }
  }

  /** The durable copy of an evicted or expired entry, when one was spilled.
   * Ownership is re-checked from the file's own record, never the path. */
  private durable(owner: Owner, id: string): SavedResult | undefined {
    if (!this.durableDir || !/^r-[0-9a-f-]{36}$/.test(id)) return undefined;
    try {
      const file = join(this.durableDir, safeThreadId(owner.threadId), `${id}.json`);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedResult>;
      if (parsed.botId !== owner.botId || parsed.threadId !== owner.threadId ||
        typeof parsed.text !== "string" || typeof parsed.truncated !== "boolean") return undefined;
      // Retention is exact per entry; the hourly sweep only reclaims disk.
      const expiresAt = statSync(file).mtimeMs + TOOL_RESULT_DURABLE_MS;
      if (expiresAt <= this.now()) return undefined;
      return { botId: parsed.botId, threadId: parsed.threadId, text: parsed.text,
        bytes: Buffer.byteLength(parsed.text), truncated: parsed.truncated, expiresAt };
    } catch { return undefined; }
  }

  /** Drops spilled threads past retention, at most hourly: triage's raw
   * copies must not accumulate forever, and the sweep must not add a stat
   * storm to every save. */
  private sweepDurable(): void {
    if (!this.durableDir) return;
    const now = this.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    try {
      for (const entry of readdirSync(this.durableDir)) {
        const dir = join(this.durableDir, entry);
        if (statSync(dir).mtimeMs + TOOL_RESULT_DURABLE_MS <= now) rmSync(dir, { recursive: true });
      }
    } catch { /* best effort */ }
  }

  read(owner: Owner, id: string, offset: number) {
    this.expire();
    const result = this.results.get(id) ?? this.durable(owner, id);
    if (!result || result.botId !== owner.botId || result.threadId !== owner.threadId) return null;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > result.text.length) return null;
    // A supplied offset may point to the low half of a surrogate pair.
    const char = result.text.charCodeAt(offset);
    const start = char >= 0xdc00 && char <= 0xdfff ? Math.max(0, offset - 1) : offset;
    const text = toolResultPrefix(result.text.slice(start), TOOL_RESULT_PREVIEW_CHARS);
    return { id, text, offset: start, nextOffset: start + text.length, length: result.text.length,
      truncated: result.truncated, expiresAt: result.expiresAt };
  }
}
