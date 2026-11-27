import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { AnyProviderDriver } from "./contracts.ts";
import { validateAntigravityRuntime } from "./drivers/antigravity-acp.ts";
import { ANTIGRAVITY_CLI_FIRST } from "./drivers/antigravity-cli-install.ts";
import { antigravityCliTarget } from "./drivers/antigravity-cli-release.ts";
import {
  antigravityCliUpdate, antigravityManagedInstallAvailable, antigravityNothingInstalled, antigravityOlderRuntime, installAntigravityRuntime,
  isAntigravityNativeAlias, type AntigravityInstallOptions,
} from "./drivers/antigravity-runtime.ts";
import { resolveAntigravityReleaseAsset } from "./drivers/antigravity-release.ts";
import { antigravityRuntimesRoot } from "./engine-roots.ts";
import { createEngineUpdater, enginePlans, type EngineUpdater, type ManagedRuntime } from "./engine-updates.ts";

type Selection = { instanceId?: string } | undefined;

/** Someone on this server uses Antigravity: an added Google account, the account's path set to the CLI, or a bot (or one
 * of its tasks) or the default model on an Antigravity account. The built-in account every home lists does not count. */
export function antigravityInUse(
  instances: Readonly<Record<string, { driver: string; config?: unknown }>>,
  selections: Iterable<Selection>,
): boolean {
  const ids = new Set(Object.entries(instances).filter(([, entry]) => entry.driver === "antigravityAgent").map(([id]) => id));
  for (const id of ids) {
    const cli = (instances[id]!.config as { cli?: unknown } | undefined)?.cli;
    if (id !== "antigravity" || (typeof cli === "string" && isAntigravityNativeAlias(cli))) return true;
  }
  for (const selection of selections) if (selection?.instanceId && ids.has(selection.instanceId)) return true;
  return false;
}

/** The channel whose copy is older is the one installed, and what it installed is reported by that copy's own version.
 * On a computer with no Antigravity runtime at all, the CLI is installed from its channel when the server is opted in
 * (OMB_ANTIGRAVITY_NATIVE_CLI=1) or Antigravity is in use here; otherwise nothing is downloaded until the card's install. */
export function antigravityManagedRuntime(
  configuredClis: () => readonly string[],
  options: Pick<AntigravityInstallOptions, "baseDir" | "fetchImpl" | "cliRelease" | "validate"> & {
    latest?: NonNullable<Parameters<typeof antigravityCliUpdate>[0]>["latest"];
    /** Antigravity is in use on this server. */
    wanted?: () => boolean;
    /** The opt-in, read at start; given in tests. */
    cliFirst?: boolean;
    /** An install starts or ends: the cards read the engine again. */
    changed?: () => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): ManagedRuntime {
  const firstInstall = async (): Promise<boolean> =>
    antigravityCliTarget(process.platform, process.arch) !== null
    && ((options.cliFirst ?? ANTIGRAVITY_CLI_FIRST) || options.wanted?.() === true)
    && await antigravityNothingInstalled(options.baseDir, options.env);
  return {
    older: async (skip = []) => {
      if (!skip.includes("native") && await firstInstall()) return { version: "none", channel: "native", first: true };
      const cli = skip.includes("native") ? null : await antigravityCliUpdate({ configuredClis: configuredClis(), baseDir: options.baseDir, latest: options.latest });
      if (cli) return { version: cli, channel: "native" };
      const pinned = skip.includes("pinned") ? null : await antigravityOlderRuntime(options.baseDir);
      return pinned ? { version: pinned, channel: "pinned" } : null;
    },
    install: async (channel) => {
      options.changed?.();
      try {
        return (await installAntigravityRuntime({
          validate: options.validate ?? validateAntigravityRuntime,
          baseDir: options.baseDir,
          fetchImpl: options.fetchImpl,
          ...(channel === "native" ? { native: true, cliRelease: options.cliRelease } : channel === "pinned" ? { asset: resolveAntigravityReleaseAsset() } : {}),
        })).version ?? undefined;
      } finally {
        options.changed?.();
      }
    },
    folder: antigravityRuntimesRoot(options.baseDir ?? DATA_DIR),
  };
}

function managedRuntimes(configuredClis: () => readonly string[], wanted: () => boolean, changed: () => void): Record<string, ManagedRuntime> {
  if (!antigravityManagedInstallAvailable()) return {};
  return { antigravityAgent: antigravityManagedRuntime(configuredClis, { wanted, changed }) };
}

/** The server's engine updater; `start()` it once the server is up. */
export function engineUpdatesFor(deps: {
  drivers: readonly AnyProviderDriver[];
  turnRunning(): boolean;
  configuredClis(): readonly string[];
  /** Antigravity is in use on this server (antigravityInUse). */
  antigravityWanted?(): boolean;
  updated(): void;
}): EngineUpdater {
  return createEngineUpdater({
    plans: enginePlans(deps.drivers, managedRuntimes(deps.configuredClis, () => deps.antigravityWanted?.() === true, deps.updated)),
    statePath: join(DATA_DIR, "providers", "engine-updates.json"),
    turnRunning: deps.turnRunning,
    configuredClis: deps.configuredClis,
    updated: deps.updated,
  });
}
