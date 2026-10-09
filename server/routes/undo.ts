// Undo a change that applied without a person, from its one-line receipt.
// Authorized exactly like answering that card in that thread; scope is
// keyed by path in server/request-auth.ts.
//
// POST /api/threads/:id/undo, body { requestId }.
import type { ServerResponse } from "node:http";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UndoRouteDeps {
  /** Why this caller may not answer that card in that thread, or null. */
  refusal(auth: RequestAuth, threadId: string, requestId: string): string | null;
  /** Undoes the change and writes the reply, as this caller. */
  undo(auth: RequestAuth, res: ServerResponse, threadId: string, requestId: string): void;
}

export function createUndoRoutes(deps: UndoRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = path.match(/^\/api\/threads\/([\w-]+)\/undo$/);
    if (!m || method !== "POST") return PASS;
    const threadId = m[1]!;
    const body = await readBody(req);
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";
    if (!requestId) return json(res, 400, { error: "requestId is required" });
    const refusal = deps.refusal(auth, threadId, requestId);
    if (refusal) return json(res, 403, { error: refusal });
    deps.undo(auth, res, threadId, requestId);
  };
}
