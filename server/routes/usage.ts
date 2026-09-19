// The usage-report HTTP routes — the usage ledger summary (JSON and CSV),
// the provider-key probe, and the authorization decision log — extracted
// verbatim from index.ts's dispatch chain. Path matching, methods, and
// status codes are unchanged; the handler returns false for anything it
// does not own so the chain falls through in the same order. Everything
// the family reads is a module export (the ledger readers, the spend
// state, the key checker, the decision log, the entitlement gate), so the
// factory takes no deps.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { cfg } from "../runtime.ts";
import { DATA_DIR } from "../config.ts";
import { readDecisions } from "../decision-log.ts";
import { entitled } from "../enterprise.ts";
import { checkProviderKey, PROVIDER_KEY_KINDS, type ProviderKeyKind } from "../provider-key-check.ts";
import { spendState } from "../spend.ts";
import {
  parseUsageRange,
  readUsage,
  summarizeUsage,
  usageCsv,
  USAGE_GROUPINGS,
  type UsageGroupBy,
} from "../usage-ledger.ts";

export function createUsageRoutes() {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url } = rctx;
    // ── the fleet-wide authorization decision log ──
    // Read-only like the inspector above: the rows were written at the
    // request.opened fold and in answerRequest; this only reads them back,
    // newest last, same order as thread events.
    // ── the usage ledger: what this workspace spent over a period ──
    // Read-only over the month files usage-ledger.ts appends at turn.completed.
    // Admin scope by default, like every route not opened to clients.
    if (method === "GET" && (path === "/api/usage" || path === "/api/usage.csv")) {
      const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
      if (!range) {
        json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
        return true;
      }
      const rows = readUsage(DATA_DIR, range);
      // The operator's price list is applied only with the billing entitlement.
      const prices = entitled("billing") && cfg.billing?.prices && Object.keys(cfg.billing.prices).length ? cfg.billing.prices : null;
      if (path === "/api/usage.csv") {
        const stamp = (date: Date) => date.toISOString().slice(0, 10);
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="usage-${stamp(range.from)}-${stamp(range.to)}.csv"`,
          "cache-control": "no-store",
        });
        res.end(usageCsv(rows, prices));
        return true;
      }
      const requested = url.searchParams.get("groupBy") ?? "bot";
      if (!USAGE_GROUPINGS.includes(requested as UsageGroupBy)) {
        json(res, 400, { error: `groupBy must be one of ${USAGE_GROUPINGS.join(", ")}` });
        return true;
      }
      const groupBy = requested as UsageGroupBy;
      res.setHeader("cache-control", "no-store");
      json(res, 200, {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        groupBy,
        ...summarizeUsage(rows, groupBy, prices),
        budget: spendState(cfg, DATA_DIR),
        billing: prices ? { currency: cfg.billing?.currency ?? "USD" } : null,
      });
      return true;
    }

    // ── provider key check: does a pasted or saved key open the provider's door ──
    // One read-only request from this server; the verdict never carries the
    // key. Admin scope by default, like every route not opened to clients.
    if (method === "POST" && path === "/api/keys/test") {
      const body = await readBody(req, 8192);
      const provider = body?.provider;
      if (!PROVIDER_KEY_KINDS.includes(provider as ProviderKeyKind)) {
        json(res, 400, { error: `provider must be one of ${PROVIDER_KEY_KINDS.join(", ")}` });
        return true;
      }
      const kind = provider as ProviderKeyKind;
      const saved = kind === "anthropic" ? cfg.anthropic : kind === "openaiCompat" ? cfg.openaiCompat : cfg.xai;
      if (body?.key !== undefined && typeof body.key !== "string") {
        json(res, 400, { error: "key must be a string" });
        return true;
      }
      const key = typeof body?.key === "string" ? body.key.trim() : saved?.key?.trim() || "";
      if (!key) {
        json(res, 400, { error: "No key to test. Paste one or save one first." });
        return true;
      }
      if (key.length > 512) {
        json(res, 400, { error: "That does not look like an API key." });
        return true;
      }
      const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : saved?.url;
      res.setHeader("cache-control", "no-store");
      json(res, 200, await checkProviderKey({ provider: kind, key, url }));
      return true;
    }

    if (method === "GET" && path === "/api/decisions") {
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        json(res, 400, { error: "limit must be a positive whole number" });
        return true;
      }
      json(res, 200, { decisions: readDecisions(DATA_DIR, parsedLimit ?? 200) });
      return true;
    }
    return false;
  };
}
