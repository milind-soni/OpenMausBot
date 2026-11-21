// A move of some of this computer's bots: main names them once (POST /api/cloud-send/scope) and every read the move makes
// of this computer's server carries the answer (`scope=`), so a list of any length never goes in a URL. Kept in memory: main
// names them again each time a move runs.
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { RouteContext } from "./routes/table.ts";

const KEPT = 8;
const askSchema = z.object({ v: z.literal(1), bots: z.array(z.string().regex(/^[\w-]{1,128}$/u)).min(1).max(100_000) });

export function createMoveScopes() {
  const scopes = new Map<string, ReadonlySet<string>>();
  return {
    add(bots: readonly string[]): string {
      const token = randomUUID();
      scopes.set(token, new Set(bots));
      for (const old of scopes.keys()) { if (scopes.size <= KEPT) break; scopes.delete(old); }
      return token;
    },
    get: (token: string): ReadonlySet<string> | null => scopes.get(token) ?? null,
  };
}

export type MoveScopes = ReturnType<typeof createMoveScopes>;

/** A room goes only with every bot in it (My Cloud has a default bot of its own): one that would leave a bot behind stays
 * here, where that bot goes on working in it. */
export function roomGoes(room: { memberIds: readonly string[] }, bots: ReadonlySet<string>, bot: (id: string) => { defaultBot?: unknown } | null | undefined): boolean {
  return room.memberIds.some((id) => bots.has(id)) && room.memberIds.every((id) => bots.has(id) || Boolean(bot(id)?.defaultBot));
}

/** False when the path is not this route. */
export async function moveScopeRoute(scopes: MoveScopes, { req, res, path, method, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/scope") return false;
  res.setHeader("cache-control", "no-store");
  if (method !== "POST") { req.resume(); json(res, 405, { error: "method not allowed" }); return true; }
  const asked = askSchema.safeParse(await readBody(req, 8 * 1024 * 1024));
  if (!asked.success) { json(res, 400, { error: "send { v: 1, bots }" }); return true; }
  json(res, 200, { v: 1, scope: scopes.add(asked.data.bots) });
  return true;
}
