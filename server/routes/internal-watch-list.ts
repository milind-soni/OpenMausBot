import { parseWatchInput, type WatchInput } from "../../shared/watch-list.ts";
import type { WatchOutcome } from "../host/watch-list.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

/** Only dispatch inside the internal capability gate, with its guarded body reader. */
export function createInternalWatchRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  requireActive(): void;
  apply(input: WatchInput): WatchOutcome;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/watch-list") return PASS;
    const parsed = parseWatchInput(await deps.readBody());
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    deps.requireActive();
    const outcome = deps.apply(parsed.value);
    return outcome.ok ? json(res, 200, { message: outcome.text }) : json(res, outcome.status, { error: outcome.error });
  };
}
