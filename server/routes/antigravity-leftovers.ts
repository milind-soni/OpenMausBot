// On Windows, Antigravity's runtime unpacks 0.34-1.26 GB at each start and leaves it behind when stopped by force.
// The system temp folder is searched only when the person asks (other apps start the same runtime). Answers carry sizes and counts, never paths.
import type { LeftoverRemoval, LeftoverScan } from "../drivers/antigravity-temp.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AntigravityLeftoverRouteDeps {
  hosted: boolean;
  isAntigravity(instanceId: string): boolean;
  find(): Promise<LeftoverScan>;
  remove(): Promise<LeftoverRemoval>;
}

const ROUTE = /^\/api\/instances\/([\w.-]+)\/leftover-files(\/remove)?$/u;
export const BUSY_LEFTOVER_ERROR = "Already looking for leftover files. Try again in a moment.";

export function createAntigravityLeftoverRoutes(deps: AntigravityLeftoverRouteDeps): RouteHandler {
  let busy = false;
  return async ({ req, res, path, method, json, readBody }) => {
    const match = ROUTE.exec(path);
    if (!match) return PASS;
    const removing = Boolean(match[2]);
    if (method !== (removing ? "POST" : "GET")) return PASS;
    if (deps.hosted) return json(res, 403, { error: HOSTED_PROVIDER_SETTINGS_ERROR });
    if (removing) {
      // JSON-only, so a hostile page cannot send it as a simple request.
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
