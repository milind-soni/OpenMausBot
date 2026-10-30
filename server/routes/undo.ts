// POST /api/threads/:id/undo, body { requestId }: authorized exactly like answering that card in that thread.
import type { ServerResponse } from "node:http";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UndoRouteDeps {
  refusal(auth: RequestAuth, threadId: string, requestId: string): string | null;
  undo(auth: RequestAuth, res: ServerResponse, threadId: string, requestId: string): void | Promise<void>;
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
    await deps.undo(auth, res, threadId, requestId);
  };
}
