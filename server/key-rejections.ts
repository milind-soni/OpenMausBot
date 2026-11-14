// The key itself is never kept, only a hash of it beside the provider's base URL.
import { createHash } from "node:crypto";

export const KEY_REJECTED_REASON = "The provider rejected this key. Change it in Settings → API keys.";

const rejected = new Set<string>();
const listeners = new Set<() => void>();

const fingerprint = (key: string) => createHash("sha256").update(key.trim()).digest("hex").slice(0, 32);
const markOf = (url: string, key: string) => `${url.trim().replace(/\/+$/, "")} ${fingerprint(key)}`;
const changed = () => { for (const listener of listeners) listener(); };

export function keyRejected(url: string, key: string): boolean {
  return rejected.size > 0 && rejected.has(markOf(url, key));
}

export function noteKeyRejected(url: string, key: string): void {
  const mark = markOf(url, key);
  if (rejected.has(mark)) return;
  rejected.add(mark);
  changed();
}

export function noteKeyAccepted(url: string, key: string): void {
  if (rejected.size > 0 && rejected.delete(markOf(url, key))) changed();
}

export function forgetKey(key: string): void {
  if (rejected.size === 0) return;
  const suffix = ` ${fingerprint(key)}`;
  const before = rejected.size;
  for (const mark of rejected) if (mark.endsWith(suffix)) rejected.delete(mark);
  if (rejected.size !== before) changed();
}

export function onKeyRejectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** xAI answers a wrong key with HTTP 400, not 401. */
export function rejectsKey(status: number, body: string): boolean {
  if (/\b(?:quota|billing|credits?|rate.?limit|insufficient.?(?:balance|funds))\b/i.test(body)) return false;
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  return /\binvalid_api_key\b|\b(?:invalid|incorrect|revoked|expired|disabled|deactivated)[ _-]?(?:api[ _-]?)?key\b|\bapi[ _-]?key (?:is |was |has been )?(?:invalid|incorrect|revoked|expired|disabled|not valid)\b/i.test(body);
}
