// The internal call behind the usage_limits tool. Runs inside index.ts's /api/internal/ block after the capability bearer
// is checked; the conversation is the capability's. It only reads.
import type { ServerResponse } from "node:http";

import type { Audience } from "../audience.ts";
import type { InstanceConfigMap, ProviderSnapshot } from "../contracts.ts";
import { engineLimitsFor, type EngineLimitInstance } from "../engine-limits.ts";
import type { json as sendJson } from "../harness/http.ts";
import type { PlanAccount, PlanUsageReport } from "../plan-usage.ts";
import { planAccountsFromInstances } from "../plan-usage.ts";
import { PASS } from "./table.ts";

const LIMITS = "/api/internal/engine-limits";

export const ENGINE_LIMITS_GUEST = "Usage limits belong to the owner of this computer's AI accounts, and this conversation was started by someone else.";

export interface EngineLimitsDeps {
  instances(): readonly EngineLimitInstance[];
  configs(): InstanceConfigMap;
  status(instanceId: string): ProviderSnapshot | undefined;
  /** Never a forced refresh: a bot calling in a loop is served the same read. */
  load(accounts: PlanAccount[]): Promise<PlanUsageReport>;
  audienceOf(threadId: string): Audience;
  guestDriven(threadId: string): boolean;
  dataDir: string;
}

export interface EngineLimitsContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  threadId: string;
}

export function createEngineLimitsRoutes(deps: EngineLimitsDeps) {
  return async (ctx: EngineLimitsContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "GET" || ctx.path !== LIMITS) return PASS;
    if (deps.guestDriven(ctx.threadId)) return void ctx.json(ctx.res, 403, { error: ENGINE_LIMITS_GUEST });
    const configs = deps.configs();
    const report = await deps.load(planAccountsFromInstances(configs)).catch(() => null);
    const accounts = engineLimitsFor({ instances: deps.instances(), configs, status: deps.status, report, turn: deps.audienceOf(ctx.threadId), dataDir: deps.dataDir });
    return void ctx.json(ctx.res, 200, { text: JSON.stringify({ accounts }) });
  };
}
