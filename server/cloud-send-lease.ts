// POST /api/cloud-send/lease, on the person's own Cloud over the owner's own session: one computer at a time runs the heavy
// part of its move here (a pass that copies, or the finish from its freeze to its switch), so two computers moving into one
// Cloud never load it together and never check while the other writes. A computer asks before each such part, again
// every few minutes while it runs, and lets go at its end; one that quits lets go by the lease running out. Kept in memory:
// a Cloud that starts again holds none, and the next to ask gets it.
import { z } from "zod";

import type { CloudOwner } from "./cloud-owner-lines.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";

export const LEASE_MS = 10 * 60_000;

export interface MoveLease { holder: string; label: string; until: number }

const askSchema = z.object({
  v: z.literal(1),
  holder: z.string().regex(/^[\w-]{8,128}$/u),
  label: z.string().max(120).optional(),
  release: z.literal(true).optional(),
});

/** One Cloud's lease. `ask`: held by `holder` from now on (null), or who holds it. */
export function createMoveLeases(now: () => number = Date.now) {
  let held: MoveLease | null = null;
  return {
    ask(holder: string, label: string): MoveLease | null {
      if (held && held.holder !== holder && held.until > now()) return held;
      held = { holder, label: label || (held?.holder === holder ? held.label : ""), until: now() + LEASE_MS };
      return null;
    },
    release(holder: string): void { if (held?.holder === holder) held = null; },
    held: (): MoveLease | null => (held && held.until > now() ? held : null),
  };
}

export type MoveLeases = ReturnType<typeof createMoveLeases>;

/** False when the path is not this route. */
export async function moveLeaseRoute(deps: { leases: MoveLeases; owner(auth: RequestAuth): CloudOwner | null }, { req, res, path, method, auth, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/lease") return false;
  res.setHeader("cache-control", "no-store");
  if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
  if (!deps.owner(auth)) { req.resume(); json(res, 403, { error: "Only My Cloud's owner can move into it." }); return true; }
  const asked = askSchema.safeParse(await readBody(req, 4096));
  if (!asked.success) { json(res, 400, { error: "send { v: 1, holder, label }" }); return true; }
  const { holder, label = "", release } = asked.data;
  if (release) { deps.leases.release(holder); json(res, 200, { v: 1, held: false }); return true; }
  const other = deps.leases.ask(holder, label.trim());
  if (other) { json(res, 409, { v: 1, held: false, label: other.label, until: other.until }); return true; }
  json(res, 200, { v: 1, held: true, until: deps.leases.held()?.until ?? null });
  return true;
}
