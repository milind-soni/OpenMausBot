import type { ServerResponse } from "node:http";

import type { json as sendJson } from "../harness/http.ts";
import { blockingCap, capStates, dayKey, effectiveCaps, type CapState, type UsageCapsConfig } from "../usage-caps.ts";
import { flushUsageLedger, parseUsageRange, readLatestUsage, readUsage, summarizeUsage, type UsageRow } from "../usage-ledger.ts";
import { PASS } from "./table.ts";
import { notBilledShare } from "./usage.ts";

interface BotUsageDeps {
  dataDir: string;
  guestDriven(threadId: string): boolean;
  readableFrom(threadId: string): (otherThreadId: string) => boolean;
  crossThreadReads(): boolean;
  knownThread(botId: string, threadId: string): boolean;
  canReadCapTotals(threadId: string): boolean;
  caps(): UsageCapsConfig | undefined;
  onPlan(instanceId: string): boolean;
  env?: NodeJS.ProcessEnv;
  now?(): Date;
}

const GUEST_REFUSAL = "Bot usage belongs to this workspace, and this conversation was started by someone else.";

function usageReadableFrom(deps: BotUsageDeps, botId: string, threadId: string, currentOnly: boolean) {
  const canReadThread = deps.readableFrom(threadId);
  const checked = new Map<string, boolean>();
  return (other: string): boolean => {
    if (typeof other !== "string" || !other || (currentOnly && other !== threadId)) return false;
    const cached = checked.get(other);
    if (cached !== undefined) return cached;
    const visible = deps.knownThread(botId, other) && canReadThread(other) && !deps.guestDriven(other);
    checked.set(other, visible);
    return visible;
  };
}

function capStatus(cap: CapState) {
  const { scope, period, unit, limit, reached, resetsAt } = cap;
  return { scope, period, unit, limit, reached, resetsAt };
}

function capHeadroom(cap: CapState) {
  const { used, limit, percent, warn } = cap;
  return { ...capStatus(cap), used, remaining: Math.max(0, limit - used), percent, warn };
}

export function createBotUsageRoute(deps: BotUsageDeps) {
  return async (ctx: { method: string; path: string; url: URL; res: ServerResponse; json: typeof sendJson; botId: string; threadId: string; requireActive(): void }): Promise<typeof PASS | void> => {
    if (ctx.method !== "GET" || ctx.path !== "/api/internal/engine-limits" || ctx.url.searchParams.get("scope") !== "bot") return PASS;
    if (deps.guestDriven(ctx.threadId)) return void ctx.json(ctx.res, 403, { error: GUEST_REFUSAL });
    const period = ctx.url.searchParams.get("period") ?? "today";
    const thread = ctx.url.searchParams.get("thread");
    if ((period !== "today" && period !== "month") || (thread !== null && thread !== "this")) {
      return void ctx.json(ctx.res, 400, { error: "period must be today or month, and thread must be this or omitted." });
    }

    await flushUsageLedger(deps.dataDir);
    ctx.requireActive();
    if (deps.guestDriven(ctx.threadId)) return void ctx.json(ctx.res, 403, { error: GUEST_REFUSAL });
    const now = deps.now?.() ?? new Date();
    const month = parseUsageRange(null, null, now)!;
    let ledger: UsageRow[];
    try {
      ledger = readUsage(deps.dataDir, month, { requireReadable: true });
    } catch {
      return void ctx.json(ctx.res, 503, { error: "The usage ledger could not be read. Try again shortly." });
    }
    const readable = usageReadableFrom(deps, ctx.botId, ctx.threadId, thread === "this" || !deps.crossThreadReads());
    const today = dayKey(now);
    const rows = ledger.filter((row) => row.botId === ctx.botId
      && (period === "month" || row.at.startsWith(today)) && readable(row.threadId));
    const { turns, input, output, cachedInput, barTokens, costUsd, unpriced } = summarizeUsage(rows, "bot").total;
    const currentReadable = readable(ctx.threadId);
    const latest = currentReadable ? readLatestUsage(deps.dataDir, now, (row) => row.botId === ctx.botId && row.threadId === ctx.threadId
      && Number.isFinite(row.contextTokens) && Number.isFinite(row.contextWindow)) : undefined;

    const config = deps.caps();
    const states = capStates(config, deps.dataDir, now, deps.env, ctx.botId);
    const exactCaps = currentReadable && deps.canReadCapTotals(ctx.threadId);
    // A shared reply can carry only the cap details that a refusal would disclose.
    const blocking = exactCaps ? null : blockingCap(states);
    const caps = exactCaps ? states.map(capHeadroom) : blocking ? [capStatus(blocking)] : [];
    return void ctx.json(ctx.res, 200, { text: JSON.stringify({
      period, thread: thread ?? "visible", timeZone: "UTC",
      totals: { turns, input, output, cachedInput, barTokens, costUsd, unpricedTurns: unpriced, notBilled: notBilledShare(rows, deps.onPlan) },
      context: latest ? { contextTokens: latest.contextTokens, contextWindow: latest.contextWindow } : null,
      caps, capsComplete: exactCaps || states.length === 0, stops: caps.length ? effectiveCaps(config, deps.env).stops : null,
      note: "Usage covers settled turns visible to this conversation. Dollar amounts are estimates; unpriced turns have no cost estimate. When exact headroom is unavailable, only the cap that would refuse work is shown.",
    }) });
  };
}
