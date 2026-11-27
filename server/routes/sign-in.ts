import type { SignInAsk, SignInAsked } from "../host/handoff-requests.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

/** Only dispatch inside the internal capability gate, with its guarded body
 * reader. The global route table must never register this endpoint. */
export function createInternalSignInRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  request(ask: SignInAsk): SignInAsked | Promise<SignInAsked>;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/request-sign-in") return PASS;
    const body = await deps.readBody();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(res, 400, { error: "request body must be a JSON object" });
    }
    const { site, reason, instruction, kind, target } = body as Record<string, unknown>;
    const result = await deps.request({ site, reason, instruction, kind, target });
    return "error" in result ? json(res, result.status, { error: result.error }) : json(res, 201, result);
  };
}
