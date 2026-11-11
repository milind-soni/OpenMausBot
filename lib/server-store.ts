import { integrationBridge } from "./integration-bridge";

// The frontend keeps no state of its own: rate limits, leases, GitHub and MCP OAuth credentials live in Convex
// (convex/serverStore.ts, convex/mcpOAuth.ts) behind the signed /integrations HTTP action. Secrets are sealed and
// unsealed by Convex with ORIGIN_SEALING_KEY; this process never holds key material.

export function store<T>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
  return integrationBridge<T>(operation, args);
}

export class TooManyRequests extends Error {
  constructor() { super("Too many requests. Please try again shortly."); }
}

/** Counts one request against `key`'s fixed window (shared by every instance); throws TooManyRequests past `maximum`. */
export async function limitAction(key: string, maximum: number, durationMs: number) {
  if (!await store<boolean>("store.limit", { key, maximum, durationMs })) throw new TooManyRequests();
}

/** True when `key` already used up `maximum` in its current window; counts nothing. */
export function limitReached(key: string, maximum: number) {
  return store<boolean>("store.limitReached", { key, maximum });
}

/**
 * Runs `task` while holding the named lease, or returns `{ busy: true }` when another instance holds it. The lease
 * expires on its own after `durationMs`, so a crashed function never blocks the next one for long.
 */
export async function withLease<T>(name: string, durationMs: number, task: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  const owner = await store<string | null>("store.leaseAcquire", { name, durationMs });
  if (!owner) return { busy: true };
  try { return { busy: false, value: await task() }; }
  finally { await store("store.leaseRelease", { name, owner }).catch(() => {}); }
}
