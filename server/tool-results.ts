// Short-lived overflow for built-in agents tools, not another history store.
// Authorize the live turn before using this cache; ownership is BOTH the bot
// and conversation, so room speakers and sibling threads cannot share IDs.
import { randomUUID } from "node:crypto";
import { redactSecretsInText } from "../shared/redact.ts";

export const TOOL_RESULT_PREVIEW_CHARS = 16_000;
export const TOOL_RESULT_MAX_CHARS = 128 * 1024;
export const TOOL_RESULT_TTL_MS = 60 * 60_000;
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

/** Bounded in memory; lost on restart, expired after an hour, or evicted
 * oldest-first under pressure. Reads do not extend retention. The transcript
 * remains the durable record; this cache is only a way to page a large answer. */
export class ToolResults {
  private readonly results = new Map<string, SavedResult>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  private expire(): void {
    const now = this.now();
    for (const [id, result] of this.results) {
      if (result.expiresAt <= now) this.results.delete(id);
    }
  }

  save(owner: Owner, text: string, truncated = false) {
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
    return { id, length: bounded.length, truncated: result.truncated, expiresAt: result.expiresAt };
  }

  read(owner: Owner, id: string, offset: number) {
    this.expire();
    const result = this.results.get(id);
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
