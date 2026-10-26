// "Not now" on the add-a-key suggestion (server/host/helper-suggestion.ts). Add key opens Settings on the device and
// never comes here. Only the owner or an admin answers, and only a card the suggestion posted.
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface HelperSuggestionRouteDeps {
  notNow(threadId: string, messageId: string, auth: RequestAuth): "kept" | "refused" | "unknown";
}

const ID = /^[\w-]{1,128}$/;

export function createHelperSuggestionRoutes(deps: HelperSuggestionRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/helpers/suggestion/not-now" || method !== "POST") return PASS;
    const body = await readBody(req, 2048);
    const threadId = typeof body?.threadId === "string" ? body.threadId : "";
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    if (!ID.test(threadId) || !ID.test(messageId)) return json(res, 400, { error: "threadId and messageId are required" });
    const outcome = deps.notNow(threadId, messageId, auth);
    if (outcome === "refused") return json(res, 403, { error: "Only the owner can answer this." });
    if (outcome === "unknown") return json(res, 404, { error: "There is no such suggestion." });
    return json(res, 200, { ok: true });
  };
}
