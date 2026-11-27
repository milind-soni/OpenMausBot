import * as boat from "../boat.ts";
import type { AppConfig } from "../config.ts";
import type { TeamComputers } from "../team-computers.ts";
import type { RemoteComputerProvider } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ComputerUsageRouteDeps {
  cfg: AppConfig;
  managedBoatOwners(): boat.ManagedBoatOwner[];
  teamComputers: Pick<TeamComputers, "list">;
  computerProviderConfigTransitions: Pick<Set<RemoteComputerProvider>, "has">;
}

/** GET /api/computers/usage → `{ cloudComputers: number | null, teamComputers: number }`: counts for the owner's daily
 * usage snapshot, never a name, an id or a state. `cloudComputers` is null while the Boat account changes or the
 * provider cannot be read. */
export function createComputerUsageRoutes(deps: ComputerUsageRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "GET" || path !== "/api/computers/usage") return PASS;
    res.setHeader("cache-control", "private, no-store");
    return json(res, 200, { cloudComputers: await cloudComputers(deps), teamComputers: deps.teamComputers.list().length });
  };
}

async function cloudComputers({ cfg, managedBoatOwners, computerProviderConfigTransitions }: ComputerUsageRouteDeps): Promise<number | null> {
  if (!boat.boatConfigured(cfg)) return 0;
  if (computerProviderConfigTransitions.has("box")) return null;
  // A count must never adopt a legacy computer or retire a recorded deletion.
  const inventory = await boat.listManagedBoats(cfg, managedBoatOwners(), { adoptLegacy: false });
  return inventory.available ? inventory.instances.length : null;
}
