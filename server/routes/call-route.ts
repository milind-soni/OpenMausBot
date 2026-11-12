import type { IncomingMessage, ServerResponse } from "node:http";

import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface RouteCall {
  method: string;
  path: string;
  body?: unknown;
  auth: RequestAuth;
}

export interface RouteReply {
  status: number;
  body: Record<string, unknown>;
}

/** Runs a route handler as the app's own window would call it, so a change made from a chat gets the same checks, side
 * effects and broadcasts as Settings, and the caller reads the reply the route wrote. */
export async function callRoute(route: RouteHandler, call: RouteCall): Promise<RouteReply> {
  let reply: RouteReply | null = null;
  const url = new URL(call.path, "http://127.0.0.1");
  const res = { headersSent: false, writableEnded: false } as ServerResponse;
  const out = await route({
    req: { headers: { "content-type": "application/json" } } as unknown as IncomingMessage, res, url, path: url.pathname, method: call.method, auth: call.auth,
    json: (_res, status, body) => { reply = { status, body: (body ?? {}) as Record<string, unknown> }; },
    readBody: async () => call.body,
  });
  if (reply) return reply;
  return out === PASS ? { status: 404, body: { error: `no route for ${call.method} ${call.path}` } } : { status: 500, body: { error: "the route sent no reply" } };
}
