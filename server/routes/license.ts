// GET /api/license: the licence state for the owner's own Settings (plan, seats, expiry, grace left, where it was read
// from, whether it is valid). Never the key: it is a credential, and bot shells never reach this route.
import { licenseState } from "../enterprise.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteContext } from "./table.ts";

export const LICENSE_PATH = "/api/license";

// A function declaration, not a const: table.ts lists it, and a declaration is ready even when this module is the one
// imported first.
export async function licenseRoutes({ res, path, method, auth, json }: RouteContext): Promise<typeof PASS | void> {
  if (path !== LICENSE_PATH) return PASS;
  if (method !== "GET") return json(res, 405, { error: "GET only" });
  if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin sees this server's licence." });
  res.setHeader("cache-control", "no-store");
  return json(res, 200, licenseState());
}
