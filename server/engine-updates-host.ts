import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { AnyProviderDriver } from "./contracts.ts";
import { validateAntigravityRuntime } from "./drivers/antigravity-acp.ts";
import { antigravityCliUpdate, antigravityManagedInstallAvailable, antigravityOlderRuntime, installAntigravityRuntime, type AntigravityInstallOptions } from "./drivers/antigravity-runtime.ts";
import { resolveAntigravityReleaseAsset } from "./drivers/antigravity-release.ts";
import { antigravityRuntimesRoot } from "./engine-roots.ts";
import { createEngineUpdater, enginePlans, type EngineUpdater, type ManagedRuntime } from "./engine-updates.ts";

/** The channel whose copy is older is the one installed, and what it installed is reported by that copy's own version. */
export function antigravityManagedRuntime(
  configuredClis: () => readonly string[],
  options: Pick<AntigravityInstallOptions, "baseDir" | "fetchImpl" | "cliRelease" | "validate"> & { latest?: NonNullable<Parameters<typeof antigravityCliUpdate>[0]>["latest"] } = {},
): ManagedRuntime {
  return {
    older: async (skip = []) => {
      const cli = skip.includes("native") ? null : await antigravityCliUpdate({ configuredClis: configuredClis(), baseDir: options.baseDir, latest: options.latest });
      if (cli) return { version: cli, channel: "native" };
      const pinned = skip.includes("pinned") ? null : await antigravityOlderRuntime(options.baseDir);
      return pinned ? { version: pinned, channel: "pinned" } : null;
    },
    install: async (channel) => (await installAntigravityRuntime({
      validate: options.validate ?? validateAntigravityRuntime,
      baseDir: options.baseDir,
      fetchImpl: options.fetchImpl,
      ...(channel === "native" ? { native: true, cliRelease: options.cliRelease } : channel === "pinned" ? { asset: resolveAntigravityReleaseAsset() } : {}),
    })).version ?? undefined,
    folder: antigravityRuntimesRoot(options.baseDir ?? DATA_DIR),
  };
}

function managedRuntimes(configuredClis: () => readonly string[]): Record<string, ManagedRuntime> {
  if (!antigravityManagedInstallAvailable()) return {};
  return { antigravityAgent: antigravityManagedRuntime(configuredClis) };
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
