// POST /api/bots/<bot>/sign-in-cards/<message>/(done|cancel|save-login) with {threadId}, and GET .../save-login?threadId=
// for where a login saved from the card would fill. GET .../saved-logins?threadId= names the saved logins for the card's
// site its bot may not use yet, and POST .../use-login with {threadId, loginId} lets it use one and answers the card.
// A saved password goes into the encrypted store and no route ever returns it.
import type { RequestAuth } from "../request-auth.ts";
import type { SignInVaultChoices } from "../vault/choices.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type SignInOutcome = "done" | "cancelled";

type Answer = { status: number; body: Record<string, unknown> };

export interface SignInCardRouteDeps {
  settle(botId: string, threadId: string, messageId: string, outcome: SignInOutcome): Answer;
  saveLogin(botId: string, threadId: string, messageId: string, body: Record<string, unknown>, auth: RequestAuth): Promise<Answer>;
  saveTarget(botId: string, threadId: string, messageId: string): Promise<Answer>;
  /** A member reaches a card only in a thread shown to them, which in a room can be narrower than the bot. */
  threadVisible(auth: RequestAuth, threadId: string): boolean;
  /** "Use a saved login". Its paths are an admin's (not in CLIENT_ALLOW), like the Vault itself. */
  vault?: SignInVaultChoices;
}

const HIDDEN: Answer = { status: 404, body: { error: "no such sign-in request" } };

const CARD = /^\/api\/bots\/([\w-]+)\/sign-in-cards\/([\w-]+)\/(done|cancel|save-login|saved-logins|use-login)$/u;

export function createSignInCardRoutes(deps: SignInCardRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const m = CARD.exec(path);
    if (!m) return PASS;
    if (m[3] === "save-login" && method === "GET") {
      const threadId = url.searchParams.get("threadId") ?? "";
      const result = deps.threadVisible(auth, threadId) ? await deps.saveTarget(m[1]!, threadId, m[2]!) : HIDDEN;
      return json(res, result.status, result.body);
    }
    if (m[3] === "saved-logins" && method === "GET") {
      const threadId = url.searchParams.get("threadId") ?? "";
      res.setHeader("cache-control", "no-store");
      const result = deps.vault && deps.threadVisible(auth, threadId) ? deps.vault.list(m[1]!, threadId, m[2]!) : { status: 200, body: { choices: [] } };
      return json(res, result.status, result.body);
    }
    if (method !== "POST" || m[3] === "saved-logins") return PASS;
    if (m[3] === "save-login" || m[3] === "use-login") {
      // JSON only, so a form posted from another local page cannot save one.
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
      const body = await readBody(req, 16_384);
      const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const threadId = String(fields.threadId ?? "");
      if (m[3] === "use-login") {
        const used = deps.vault && deps.threadVisible(auth, threadId) ? deps.vault.use(m[1]!, threadId, m[2]!, fields.loginId) : HIDDEN;
        return json(res, used.status, used.body);
      }
      const result = deps.threadVisible(auth, threadId) ? await deps.saveLogin(m[1]!, threadId, m[2]!, fields, auth) : HIDDEN;
      return json(res, result.status, result.body);
    }
    const body = await readBody(req);
    const threadId = String(body.threadId ?? "");
    const result = deps.threadVisible(auth, threadId) ? deps.settle(m[1]!, threadId, m[2]!, m[3] === "done" ? "done" : "cancelled") : HIDDEN;
    return json(res, result.status, result.body);
  };
}
