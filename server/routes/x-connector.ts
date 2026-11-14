// GET /api/x/status: what the Apps page's X card shows. It names the credential the X tools use now, from the same
// resolver as the tools' own routes, and asks the plan's relay for this month's included calls, cached briefly so
// opening Apps again does not ask every time.
import type { XConnectorStatus, XIncludedUsage } from "../../shared/x-connector.ts";
import type { ServiceCredential } from "../included-services.ts";
import { readIncludedXUsage } from "../x-research.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const X_STATUS_PATH = "/api/x/status";
const USAGE_FRESH_MS = 30_000;

export interface XConnectorDeps {
  /** The X tools' credential: the person's own treg key, else the plan's relay (researchCredential). */
  credential: () => ServiceCredential | null;
  /** The plan's relay credential alone (xCredential), held or not whatever the own key. */
  included: () => ServiceCredential | null;
  /** The Admin said no to this desktop's paid sign-in (xResearchStatus). */
  unavailable: () => boolean;
  usage?: (credential: ServiceCredential) => Promise<XIncludedUsage | null>;
  now?: () => number;
}

export function createXConnectorRoutes(deps: XConnectorDeps): RouteHandler {
  const readUsage = deps.usage ?? ((credential: ServiceCredential) => readIncludedXUsage(credential));
  const now = deps.now ?? Date.now;
  let cached: { token: string; at: number; usage: XIncludedUsage | null } | null = null;

  const usageFor = async (credential: ServiceCredential, refresh: boolean): Promise<XIncludedUsage | null> => {
    if (!refresh && cached?.token === credential.token && now() - cached.at < USAGE_FRESH_MS) return cached.usage;
    const usage = await readUsage(credential);
    cached = { token: credential.token, at: now(), usage };
    return usage;
  };

  return async (ctx) => {
    if (ctx.path !== X_STATUS_PATH) return PASS;
    if (ctx.method !== "GET") return void ctx.json(ctx.res, 405, { error: "Use GET." });
    const using = deps.credential(), included = deps.included();
    const usage = included ? await usageFor(included, ctx.url.searchParams.get("refresh") === "1") : null;
    const status: XConnectorStatus = {
      using: using ? (using.included ? "included" : "own") : null,
      ownKey: using?.included === false,
      included: included !== null,
      ...(!included && deps.unavailable() ? { unavailable: true as const } : {}),
      ...(usage ? { usage } : {}),
    };
    ctx.res.setHeader("cache-control", "no-store");
    ctx.json(ctx.res, 200, status);
  };
}
