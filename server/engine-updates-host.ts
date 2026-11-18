import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { AnyProviderDriver } from "./contracts.ts";
import { validateAntigravityRuntime } from "./drivers/antigravity-acp.ts";
import { antigravityManagedInstallAvailable, antigravityOlderRuntime, installAntigravityRuntime } from "./drivers/antigravity-runtime.ts";
import { antigravityRuntimesRoot } from "./engine-roots.ts";
import { createEngineUpdater, enginePlans, type EngineUpdater, type ManagedRuntime } from "./engine-updates.ts";

function managedRuntimes(): Record<string, ManagedRuntime> {
  if (!antigravityManagedInstallAvailable()) return {};
  return {
    antigravityAgent: {
      older: () => antigravityOlderRuntime(),
      install: () => installAntigravityRuntime({ validate: validateAntigravityRuntime }).then(() => {}),
      folder: antigravityRuntimesRoot(DATA_DIR),
    },
  };
}

/** The server's engine updater; `start()` it once the server is up. */
export function engineUpdatesFor(deps: {
  drivers: readonly AnyProviderDriver[];
  turnRunning(): boolean;
  configuredClis(): readonly string[];
  updated(): void;
}): EngineUpdater {
  return createEngineUpdater({
    plans: enginePlans(deps.drivers, managedRuntimes()),
    statePath: join(DATA_DIR, "providers", "engine-updates.json"),
    turnRunning: deps.turnRunning,
    configuredClis: deps.configuredClis,
    updated: deps.updated,
  });
}
