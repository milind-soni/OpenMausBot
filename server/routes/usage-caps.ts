// The usage caps as the owner sets them: GET /api/usage/caps answers with the saved caps, what the environment sets
// and each cap's use now; PUT replaces the saved caps. Admin scope only: on a self-hosted server that is its owner.
import { CAP_FIELDS, usageCapsSchema, type CapLimits, type UsageCapsConfig } from "../usage-caps.ts";
import type { UsageCapView } from "../host/usage-cap-gate.ts";
import { schemaIssue } from "../schema.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UsageCapRouteDeps {
  view(): UsageCapView;
  botExists(botId: string): boolean;
  save(caps: UsageCapsConfig): void;
}

const OWNER_ONLY = "Only the owner of this server can see or change its usage caps.";

/** Zero and empty mean no cap, so neither is kept. */
function setLimits(limits: CapLimits | undefined): CapLimits {
  const kept: CapLimits = {};
  for (const { field } of CAP_FIELDS) {
    const value = limits?.[field];
    if (typeof value === "number" && value > 0) kept[field] = value;
  }
  return kept;
}

export function createUsageCapRoutes(deps: UsageCapRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/usage/caps" || (method !== "GET" && method !== "PUT")) return PASS;
    if (!auth.scopes.includes("admin")) return void json(res, 403, { error: OWNER_ONLY });
    res.setHeader("cache-control", "no-store");
    if (method === "GET") return void json(res, 200, deps.view());
    const parsed = usageCapsSchema.safeParse(await readBody(req, 65_536).catch(() => null));
    if (!parsed.success) return void json(res, 400, { error: schemaIssue(parsed.error, "Send stops (unattended or everything), server and bots, each cap a number of dollars or tokens.") });
    const unknown = Object.keys(parsed.data.bots ?? {}).find((botId) => !deps.botExists(botId));
    if (unknown) return void json(res, 404, { error: `No such bot: ${unknown}` });
    const bots = Object.fromEntries(Object.entries(parsed.data.bots ?? {}).map(([botId, limits]) => [botId, setLimits(limits)] as const).filter(([, limits]) => Object.keys(limits).length));
    deps.save({ stops: parsed.data.stops ?? "unattended", server: setLimits(parsed.data.server), bots });
    json(res, 200, deps.view());
  };
}
