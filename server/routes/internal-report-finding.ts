import { parseFindingInput, type FindingInput } from "../../shared/found-update.ts";
import type { FindingOutcome } from "../host/found-updates.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

/** Only dispatch inside the internal capability gate, with its guarded body reader. */
export function createInternalFindingRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  requireActive(): void;
  report(input: FindingInput): FindingOutcome;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/report-finding") return PASS;
    const parsed = parseFindingInput(await deps.readBody());
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    deps.requireActive();
    const outcome = deps.report(parsed.value);
    return outcome.ok ? json(res, 200, { messageId: outcome.messageId }) : json(res, outcome.status, { error: outcome.error });
  };
}
