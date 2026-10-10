// Settings → Engines → Antigravity → "Free up space".
//
//   GET  /api/instances/:id/leftover-files         what would be deleted
//   POST /api/instances/:id/leftover-files/remove  delete it
//
// On Windows, Google's Antigravity runtime unpacks 0.34-1.26 GB every time it
// starts and leaves it behind whenever it is stopped by force. Folders in
// OMB's own temp folder are also swept automatically; the system temp folder
// is searched only here, when the person asks, because other apps start the
// same runtime (server/drivers/antigravity-temp.ts).
//
// Admin-scoped by default (server/request-auth.ts lists no client rule for
// these paths): it deletes files on the machine running OpenMausBot. Hidden
// on a hosted team workspace, like every other engine setting there. The
// answers carry sizes and counts, never paths.
import type { LeftoverRemoval, LeftoverScan } from "../drivers/antigravity-temp.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AntigravityLeftoverRouteDeps {
  /** A hosted team workspace: engine settings are not the member's. */
  hosted: boolean;
  /** Only an Antigravity instance offers this. */
  isAntigravity(instanceId: string): boolean;
  find(): Promise<LeftoverScan>;
  remove(): Promise<LeftoverRemoval>;
}

const ROUTE = /^\/api\/instances\/([\w.-]+)\/leftover-files(\/remove)?$/u;
export const BUSY_LEFTOVER_ERROR = "Already looking for leftover files. Try again in a moment.";

export function createAntigravityLeftoverRoutes(deps: AntigravityLeftoverRouteDeps): RouteHandler {
  // One scan or delete at a time: both walk thousands of files.
  let busy = false;
  return async ({ req, res, path, method, json, readBody }) => {
    const match = ROUTE.exec(path);
    if (!match) return PASS;
    const removing = Boolean(match[2]);
    if (method !== (removing ? "POST" : "GET")) return PASS;
    if (deps.hosted) return json(res, 403, { error: HOSTED_PROVIDER_SETTINGS_ERROR });
    if (removing) {
      // Same non-simple-request gate as the other instance actions.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req, 4096);
    }
    if (!deps.isAntigravity(match[1]!)) return json(res, 404, { error: "Only Antigravity has leftover files to clear." });
    if (busy) return json(res, 409, { error: BUSY_LEFTOVER_ERROR });
    busy = true;
    res.setHeader("cache-control", "no-store");
    try {
      if (!removing) {
        const scan = await deps.find();
        return json(res, 200, { bytes: scan.bytes, folders: scan.folders.length, complete: scan.complete });
      }
      const removed = await deps.remove();
      return json(res, 200, { freedBytes: removed.freedBytes, removed: removed.removed, remaining: removed.remaining });
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      busy = false;
    }
  };
}
