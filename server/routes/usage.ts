import { redactSecretsInText } from "../../shared/redact.ts";
import type { PriceList } from "../prices.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SpendState } from "../spend.ts";
import {
  parseUsageRange,
  readUsage,
  summarizeUsage,
  usageCsv,
  USAGE_GROUPINGS,
  type UsageGroupBy,
} from "../usage-ledger.ts";
import { DETAIL_MAX, ERROR_MAX } from "../usage-trace/detail.ts";
import type { ToolReceipt, TraceRecorder } from "../usage-trace/recorder.ts";
import { createTraceService, PAGE_MAX, type TraceServiceDeps } from "../usage-trace/service.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UsageRouteDeps {
  dataDir: string;
  prices(): PriceList | null;
  budget(): SpendState | null;
  currency(): string;
  recorder: TraceServiceDeps["recorder"];
  messages: TraceServiceDeps["messages"];
  liveBot: TraceServiceDeps["liveBot"];
  /** Which threads this viewer may read today; a trace shows only those. */
  canSee(auth: RequestAuth): (threadId: string) => boolean;
}

const TRACE = /^\/api\/usage\/traces\/([^/]{1,600})$/;

const whole = (raw: string | null, fallback: number, max: number): number | null => {
  if (raw === null) return fallback;
  return /^\d{1,7}$/.test(raw) && Number(raw) <= max ? Number(raw) : null;
};

export function createUsageRoutes(deps: UsageRouteDeps): RouteHandler {
  const traces = createTraceService({ dataDir: deps.dataDir, recorder: deps.recorder, messages: deps.messages, liveBot: deps.liveBot });
  return async ({ res, url, path, method, auth, json }) => {
    if (method === "GET" && path === "/api/usage/traces") {
      const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
      if (!range) return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
      const offset = whole(url.searchParams.get("offset"), 0, 10_000_000);
      const limit = whole(url.searchParams.get("limit"), 50, PAGE_MAX);
      if (offset === null || !limit) return json(res, 400, { error: `offset must be a whole number and limit 1 to ${PAGE_MAX}` });
      res.setHeader("cache-control", "no-store");
      return json(res, 200, await traces.list(range, { offset, limit }, deps.canSee(auth)));
    }
    const trace = method === "GET" ? TRACE.exec(path) : null;
    if (trace) {
      let id: string;
      try { id = decodeURIComponent(trace[1]!); } catch { return json(res, 400, { error: "not a trace id" }); }
      const around = url.searchParams.get("at");
      if (around !== null && !/^\d{10,14}$/.test(around)) return json(res, 400, { error: "at must be a time in milliseconds" });
      const found = await traces.detail(id, around === null ? null : Number(around), deps.canSee(auth));
      res.setHeader("cache-control", "no-store");
      return found ? json(res, 200, found) : json(res, 404, { error: "no such trace" });
    }
    if (!(method === "GET" && (path === "/api/usage" || path === "/api/usage.csv"))) return PASS;
    const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
    if (!range) return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
    const rows = readUsage(deps.dataDir, range);
    const prices = deps.prices();
    if (path === "/api/usage.csv") {
      const stamp = (date: Date) => date.toISOString().slice(0, 10);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="usage-${stamp(range.from)}-${stamp(range.to)}.csv"`,
        "cache-control": "no-store",
      });
      res.end(usageCsv(rows, prices));
      return;
    }
    const requested = url.searchParams.get("groupBy") ?? "bot";
    if (!USAGE_GROUPINGS.includes(requested as UsageGroupBy)) {
      return json(res, 400, { error: `groupBy must be one of ${USAGE_GROUPINGS.join(", ")}` });
    }
    const groupBy = requested as UsageGroupBy;
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      groupBy,
      ...summarizeUsage(rows, groupBy, prices),
      budget: deps.budget(),
      billing: prices ? { currency: deps.currency() } : null,
    });
  };
}

const MAX_TOOL_NAME = 128;
const MAX_TOOL_MS = 24 * 60 * 60_000;
const MAX_SKEW_MS = 24 * 60 * 60_000;

/** A receipt from the agents tools for one call this turn's capability made: OMB's own timing of the tools it serves. */
export function createToolTimingRoute(recorder: Pick<TraceRecorder, "receipt">, threadId: string): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!(method === "POST" && path === "/api/internal/tool-timing")) return PASS;
    let body: unknown;
    try { body = await readBody(req, 8_192); } catch { return json(res, 400, { error: "expected a small JSON body" }); }
    const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const { name, startedAt, endedAt, ok } = value;
    const near = (time: unknown): time is number => typeof time === "number" && Number.isFinite(time) && Math.abs(time - Date.now()) <= MAX_SKEW_MS;
    if (typeof name !== "string" || !name || name.length > MAX_TOOL_NAME || typeof ok !== "boolean" ||
        !near(startedAt) || !near(endedAt) || !(endedAt >= startedAt) || endedAt - startedAt > MAX_TOOL_MS) {
      return json(res, 400, { error: "name, startedAt, endedAt and ok are required" });
    }
    const text = (field: unknown, max: number) => typeof field === "string" && field.trim() ? redactSecretsInText(field.slice(0, max)) : undefined;
    const receipt: ToolReceipt = { name, startedAt, endedAt, ok };
    const detail = text(value.detail, DETAIL_MAX);
    const error = text(value.error, ERROR_MAX);
    if (detail) receipt.detail = detail;
    if (error) receipt.error = error;
    recorder.receipt(threadId, receipt);
    return json(res, 200, { ok: true });
  };
}
