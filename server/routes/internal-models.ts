import { PASS, type RouteHandler } from "./table.ts";

export interface ModelCatalogInstance {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: string };
  models: unknown;
  capabilities?: { effortLevels?: readonly string[] };
}

/** The engines and models a thread can run on, as a bot copies them into a modelSelection. */
export const modelCatalog = (instances: readonly ModelCatalogInstance[]) => instances.map((instance) => ({
  instanceId: instance.instanceId, driverKind: instance.driverKind, displayName: instance.displayName,
  state: instance.snapshot.state, models: instance.models, effortLevels: instance.capabilities?.effortLevels ?? [],
}));

/** Only dispatch inside the internal capability gate. Any bot reads this before it opens a thread on another model. */
export function createInternalModelRoutes(deps: {
  requireActive(): void;
  instances(): Promise<readonly ModelCatalogInstance[]>;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "GET" || path !== "/api/internal/models") return PASS;
    const instances = await deps.instances();
    deps.requireActive();
    return json(res, 200, { instances: modelCatalog(instances) });
  };
}
