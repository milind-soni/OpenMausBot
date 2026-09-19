// The routine calendar HTTP routes, extracted from index.ts's dispatch
// chain (see ../workspace-backup-http.ts for the pattern). Path matching,
// methods, and status codes are unchanged; the handler returns false for
// anything it does not own so the chain falls through in the same order.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody } from "../http.ts";
import type { RoutineManager } from "../routines.ts";

export function createRoutinesRoutes(options: { routines: () => RoutineManager }) {
  return async (req: IncomingMessage, res: ServerResponse, path: string, method: string, url: URL): Promise<boolean> => {
    const routines = options.routines;
    // ── routines calendar ────────────────────────────────────────────────
    if (path === "/api/routines" && method === "GET") {
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      const from = fromParam == null ? undefined : Number(fromParam);
      const to = toParam == null ? undefined : Number(toParam);
      json(res, 200, {
        routines: routines().listRoutines(),
        runs: routines().listRuns(from != null && Number.isFinite(from) ? from : undefined, to != null && Number.isFinite(to) ? to : undefined),
      });
      return true;
    }
    if (path === "/api/routines" && method === "POST") {
      json(res, 201, { routine: routines().create(await readBody(req)) });
      return true;
    }
    // The desktop shell polls this to decide whether to hold the computer
    // awake: a run in flight, or a routine due within the hour.
    if (path === "/api/routines/wake" && method === "GET") {
      json(res, 200, routines().wakeHold());
      return true;
    }
    let routineMatch = path.match(/^\/api\/routines\/([\w-]+)\/run$/);
    if (routineMatch && method === "POST") {
      const run = routines().runNow(routineMatch[1]);
      if (run) json(res, 201, { run });
      else json(res, 404, { error: "no such routine" });
      return true;
    }
    routineMatch = path.match(/^\/api\/routines\/([\w-]+)$/);
    if (routineMatch && method === "PATCH") {
      const routine = routines().update(routineMatch[1], await readBody(req));
      if (routine) json(res, 200, { routine });
      else json(res, 404, { error: "no such routine" });
      return true;
    }
    if (routineMatch && method === "DELETE") {
      if (routines().remove(routineMatch[1])) {
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: "no such routine" });
      }
      return true;
    }
    const runMatch = path.match(/^\/api\/routine-runs\/([\w-]+)\/(cancel|seen)$/);
    if (runMatch && method === "POST") {
      const run = runMatch[2] === "cancel"
        ? await routines().cancelRun(runMatch[1])
        : routines().markSeen(runMatch[1]);
      if (run) json(res, 200, { run });
      else json(res, 404, { error: "no such active run" });
      return true;
    }
    return false;
  };
}
