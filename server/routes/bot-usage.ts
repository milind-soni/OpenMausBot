import type { ServerResponse } from "node:http";

import type { json as sendJson } from "../harness/http.ts";
import { capStates, capTokens, dayKey, effectiveCaps, type CapState, type UsageCapsConfig } from "../usage-caps.ts";
import { flushUsageLedger, parseUsageRange, readUsage, summarizeUsage, type UsageRow } from "../usage-ledger.ts";
import { PASS } from "./table.ts";
import { notBilledShare } from "./usage.ts";

interface BotUsageDeps {
  dataDir: string;
  guestDriven(threadId: string): boolean;
  readableFrom(threadId: string, botId: string): (row: UsageRow) => boolean;
  caps(): UsageCapsConfig | undefined;
  onPlan(instanceId: string): boolean;
  now?(): Date;
}

const GUEST_REFUSAL = "Bot usage belongs to this workspace, and this conversation was started by someone else.";

function capUsedBy(row: UsageRow, cap: CapState): number {
  if (cap.unit === "tokens") return capTokens(row);
  return typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd > 0 ? row.costUsd : 0;
}

function visibleCap(cap: CapState, rows: UsageRow[], visible: ReadonlySet<UsageRow>) {
  const { scope, period, unit, limit, used, percent, warn, reached, resetsAt } = cap;
  let visibleUsed = 0;
  for (const row of rows) {
    if (!row.at.startsWith(cap.periodKey) || (scope === "bot" && row.botId !== cap.botId)) continue;
    const amount = capUsedBy(row, cap);
    if (amount > 0 && !visible.has(row)) return null;
    visibleUsed += amount;
  }
  // A cap can count records the ledger snapshot did not include (for example, an in-memory append).
  if (visibleUsed !== used) return null;
  return { scope, period, unit, limit, used, remaining: Math.max(0, limit - used), percent, warn, reached, resetsAt };
}

export function createBotUsageRoute(deps: BotUsageDeps) {
  return async (ctx: { method: string; path: string; url: URL; res: ServerResponse; json: typeof sendJson; botId: string; threadId: string; requireActive(): void }): Promise<typeof PASS | void> => {
    if (ctx.method !== "GET" || ctx.path !== "/api/internal/usage") return PASS;
    if (deps.guestDriven(ctx.threadId)) return void ctx.json(ctx.res, 403, { error: GUEST_REFUSAL });
    const period = ctx.url.searchParams.get("period") ?? "today";
    const thread = ctx.url.searchParams.get("thread");
    if ((period !== "today" && period !== "month") || (thread !== null && thread !== "this")) {
      return void ctx.json(ctx.res, 400, { error: "period must be today or month, and thread must be this or omitted." });
    }

    await flushUsageLedger(deps.dataDir);
    ctx.requireActive();
    const now = deps.now?.() ?? new Date();
    const month = parseUsageRange(null, null, now)!;
    const ledger = readUsage(deps.dataDir, month);
    const readable = deps.readableFrom(ctx.threadId, ctx.botId);
    const visible = new Set(ledger.filter((row) => typeof row.threadId === "string" && row.threadId && readable(row)));
    const today = dayKey(now);
    const rows = [...visible].filter((row) => row.botId === ctx.botId
      && (period === "month" || row.at.startsWith(today)) && (thread === null || row.threadId === ctx.threadId));
    const { turns, input, output, cachedInput, barTokens, costUsd, unpriced } = summarizeUsage(rows, "bot").total;
    const latest = rows.filter((row) => row.threadId === ctx.threadId && Number.isFinite(row.contextTokens) && Number.isFinite(row.contextWindow))
      .reduce<UsageRow | undefined>((previous, row) => !previous || row.at >= previous.at ? row : previous, undefined);

    const config = deps.caps();
    const states = capStates(config, deps.dataDir, now, undefined, ctx.botId);
    const caps = states.map((cap) => visibleCap(cap, ledger, visible)).filter((cap) => cap !== null);
    return void ctx.json(ctx.res, 200, { text: JSON.stringify({
      period, thread: thread ?? "visible", timeZone: "UTC",
      totals: { turns, input, output, cachedInput, barTokens, costUsd, unpricedTurns: unpriced, notBilled: notBilledShare(rows, deps.onPlan) },
      context: latest ? { contextTokens: latest.contextTokens, contextWindow: latest.contextWindow } : null,
      caps, capsComplete: states.length === caps.length, stops: caps.length ? effectiveCaps(config).stops : null,
      note: "Usage covers settled turns visible to this conversation. Dollar amounts are estimates; unpriced turns have no cost estimate. An incomplete cap list means some cap totals are unavailable here.",
    }) });
  };
}
