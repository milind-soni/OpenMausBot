import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const TOO_MANY_REQUESTS = "Too many requests. Please try again shortly.";

/**
 * Counts one request against a fixed window shared by every frontend instance. Returns false (and counts nothing more)
 * once `maximum` requests were made in the current window. Runs inside the caller's transaction.
 */
export async function countRequest(ctx: MutationCtx, key: string, maximum: number, durationMs: number) {
  const now = Date.now();
  const row = await ctx.db.query("requestLimits").withIndex("by_key", q => q.eq("key", key)).unique();
  if (!row) {
    await ctx.db.insert("requestLimits", { key, count: 1, expiresAt: now + durationMs });
    return maximum >= 1;
  }
  if (row.expiresAt < now) {
    await ctx.db.patch(row._id, { count: 1, expiresAt: now + durationMs });
    return maximum >= 1;
  }
  if (row.count >= maximum) return false;
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return true;
}

export async function requireRequestBudget(ctx: MutationCtx, key: string, maximum: number, durationMs: number) {
  if (!await countRequest(ctx, key, maximum, durationMs)) throw new ConvexError(TOO_MANY_REQUESTS);
}

/** True when `key` already used up `maximum` in its current window; counts nothing. */
export async function requestLimitReached(ctx: QueryCtx, key: string, maximum: number) {
  const row = await ctx.db.query("requestLimits").withIndex("by_key", q => q.eq("key", key)).unique();
  return Boolean(row && row.expiresAt >= Date.now() && row.count >= maximum);
}
