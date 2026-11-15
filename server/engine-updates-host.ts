import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { AnyProviderDriver } from "./contracts.ts";
import { validateAntigravityRuntime } from "./drivers/antigravity-acp.ts";
import { antigravityCliUpdate, antigravityManagedInstallAvailable, antigravityOlderRuntime, installAntigravityRuntime } from "./drivers/antigravity-runtime.ts";
import { antigravityRuntimesRoot } from "./engine-roots.ts";
import { createEngineUpdater, enginePlans, type EngineUpdater, type ManagedRuntime } from "./engine-updates.ts";

function managedRuntimes(configuredClis: () => readonly string[]): Record<string, ManagedRuntime> {
  if (!antigravityManagedInstallAvailable()) return {};
  return {
    antigravityAgent: {
      older: async () => (await antigravityCliUpdate({ configuredClis: configuredClis() })) ?? antigravityOlderRuntime(),
      install: async () => (await installAntigravityRuntime({ validate: validateAntigravityRuntime })).version ?? undefined,
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
    plans: enginePlans(deps.drivers, managedRuntimes(deps.configuredClis)),
    statePath: join(DATA_DIR, "providers", "engine-updates.json"),
    turnRunning: deps.turnRunning,
    configuredClis: deps.configuredClis,
    updated: deps.updated,
  });
}
