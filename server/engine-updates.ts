// Keeps the engine copies the app installed itself at the versions this release was tested with (engine-versions.ts),
// with no button and no setting. An engine the app did not install is never touched, nor is a copy newer than its
// target. Updates wait until no turn runs and no process runs the engine, then install beside the old copy and switch
// only once the new one has started; a failure keeps the old copy and is tried again later.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { cliProbeEnvironment } from "./cli-probe.ts";
import { DATA_DIR, stripControlPlaneEnv } from "./config.ts";
import type { AnyProviderDriver, StandaloneRelease } from "./contracts.ts";
import { startDueTimer, type DueTimer } from "./due-timer.ts";
import { acpHandshake } from "./engine-handshake.ts";
import { enginesBinDir, enginesPrefix, npmCopyVersion, npmLatestVersion, npmModulesIn, npmPackageOf, npmRunning } from "./engine-install.ts";
import { EngineInUse, npmCommandNames, removeNpmCopy, sweepNpmLeftovers, updateNpmEngineStaged, type StagedNpmUpdate } from "./engine-npm-update.ts";
import { installStandaloneEngine, standaloneAssetFor, standaloneCurrentVersion, standaloneEngineDir, type StandaloneInstallOptions } from "./engine-standalone.ts";
import { ENGINE_VERSIONS, LATEST, type EngineVersionPin } from "./engine-versions.ts";
import { liveCliCommands } from "./procs.ts";
import { isNewerVersion } from "./update-check.ts";

export const ENGINE_UPDATE_START_DELAY_MS = 2 * 60_000;
export const ENGINE_UPDATE_EVERY_MS = 24 * 60 * 60_000;
export const ENGINE_UPDATE_BUSY_RETRY_MS = 5 * 60_000;
const FIRST_RETRY_MS = 60 * 60_000;
const BELOW_MINIMUM_RETRY_CAP_MS = 6 * 60 * 60_000;
/** How long "Updated to" stays on the engine's row. */
const SHOW_UPDATED_MS = 7 * 24 * 60 * 60_000;
/** Once a new copy is ready, how long the switch waits for the engine to be free before trying another day. */
const SWITCH_WAIT_MS = 10 * 60_000;
const SWITCH_POLL_MS = 15_000;

/** A runtime the app manages itself (Antigravity): it installs each version beside the others and checks it. */
export interface ManagedRuntime {
  /** The older version installed when the pinned one is not, else null. */
  older(): Promise<string | null>;
  install(): Promise<void>;
  folder: string;
}

export interface EnginePlan {
  driverKind: string;
  name: string;
  pin: EngineVersionPin;
  cli?: string;
  npm?: string;
  /** Only when it has a build for this computer. */
  standalone?: StandaloneRelease;
  managed?: ManagedRuntime;
}

export function enginePlans(drivers: readonly AnyProviderDriver[], managed: Readonly<Record<string, ManagedRuntime>> = {}): EnginePlan[] {
  return drivers.flatMap((driver) => {
    const pin = ENGINE_VERSIONS[driver.driverKind];
    if (!pin || !driver.install) return [];
    let cli: string | undefined;
    try {
      const value = (driver.defaultConfig() as { cli?: unknown })?.cli;
      cli = typeof value === "string" && value ? value : undefined;
    } catch {}
    const standalone = driver.install.standalone && standaloneAssetFor(driver.install.standalone) ? driver.install.standalone : undefined;
    return [{
      driverKind: driver.driverKind, name: driver.metadata.displayName, pin, cli,
      npm: npmPackageOf(driver.install) ?? undefined, standalone, managed: managed[driver.driverKind],
    }];
  });
}

export interface UpdateSteps {
  npmVersion(pkg: string, baseDir: string): string | null;
  npmLatest(pkg: string, baseDir: string): Promise<string>;
  updateNpm(options: StagedNpmUpdate): Promise<void>;
  removeNpm(pkg: string, baseDir: string): Promise<void>;
  sweep(baseDir: string): Promise<void>;
  standaloneVersion(release: StandaloneRelease, baseDir: string): string | null;
  installStandalone(release: StandaloneRelease, options: StandaloneInstallOptions): Promise<unknown>;
  handshake(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | null>;
}

const STEPS: UpdateSteps = {
  npmVersion: npmCopyVersion,
  npmLatest: npmLatestVersion,
  updateNpm: updateNpmEngineStaged,
  removeNpm: removeNpmCopy,
  sweep: sweepNpmLeftovers,
  standaloneVersion: standaloneCurrentVersion,
  installStandalone: installStandaloneEngine,
  handshake: acpHandshake,
};

export interface EngineUpdaterOptions {
  plans: readonly EnginePlan[];
  baseDir?: string;
  statePath: string;
  /** A turn is running somewhere on this server. */
  turnRunning(): boolean;
  /** The command lines of processes still running, to find one that runs an engine's copy. */
  liveCommands?(): Iterable<readonly string[]>;
  /** CLI paths set on engines: an npm copy one of them runs is kept. */
  configuredClis?(): readonly string[];
  /** After an update: engine statuses are read again. */
  updated?(): void;
  log?(line: string): void;
  now?(): number;
  steps?: Partial<UpdateSteps>;
  switchWait?: { forMs: number; everyMs: number };
}

interface EngineState {
  failures?: number;
  retryAt?: number;
  updatedTo?: string;
  updatedAt?: number;
}

interface UpdaterState {
  checkedAt: number | null;
  engines: Record<string, EngineState>;
}

type Outcome =
  | { kind: "absent" | "current" | "busy" | "waiting" }
  | { kind: "updated"; from: string; to: string }
  | { kind: "failed"; from: string; to: string; reason: string };

export interface EngineUpdater {
  /** One pass over every engine now; resolves when it has finished. */
  check(): Promise<void>;
  /** `autoUpdated` for an engine updated in the last week, for its row in Settings. */
  shown(driverKind: string): { autoUpdated?: { version: string; at: number } };
  /** The earliest time a pass is due. */
  dueAt(): number;
  start(): DueTimer;
}

function inside(path: string, root: string): boolean {
  const full = resolve(path);
  return full === root || full.startsWith(`${root}${sep}`);
}

function readState(path: string): UpdaterState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdaterState>;
    return {
      checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : null,
      engines: raw.engines && typeof raw.engines === "object" ? raw.engines : {},
    };
  } catch {
    return { checkedAt: null, engines: {} };
  }
}

export function createEngineUpdater(options: EngineUpdaterOptions): EngineUpdater {
  const baseDir = options.baseDir ?? DATA_DIR;
  const steps: UpdateSteps = { ...STEPS, ...options.steps };
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const switchWait = options.switchWait ?? { forMs: SWITCH_WAIT_MS, everyMs: SWITCH_POLL_MS };
  const state = readState(options.statePath);
  const startedAt = now();
  let passed = false;
  let busyRetryAt: number | null = null;
  let running: Promise<void> | null = null;

  const save = () => {
    try {
      mkdirSync(dirname(options.statePath), { recursive: true });
      writeFileAtomic(options.statePath, `${JSON.stringify(state)}\n`, { durable: false });
    } catch {}
  };

  /** The folders a copy of this engine lives in: a process whose command line reaches into one runs it. */
  const enginePaths = (plan: EnginePlan): string[] => {
    const npmPackages = [plan.npm, ...(plan.pin.formerNpm ?? [])].filter((pkg): pkg is string => Boolean(pkg));
    const modules = npmModulesIn(enginesPrefix(baseDir));
    return [
      ...npmPackages.map((pkg) => join(modules, ...pkg.split("/"))),
      ...(plan.cli ? [join(enginesBinDir(baseDir), plan.cli)] : []),
      ...(plan.standalone ? [standaloneEngineDir(plan.standalone.engine, baseDir)] : []),
      ...(plan.managed ? [plan.managed.folder] : []),
    ].map((path) => resolve(path));
  };

  /** A turn runs, or a process runs one of this engine's copies. */
  const engineInUse = (plan: EnginePlan): boolean => {
    if (options.turnRunning()) return true;
    const roots = enginePaths(plan);
    for (const line of options.liveCommands?.() ?? liveCliCommands()) {
      // A prefix match: Windows runs an npm command through `<name>.cmd` beside the path named here.
      if (line.some((part) => roots.some((root) => resolve(part).startsWith(root)))) return true;
    }
    return false;
  };

  /** In use, or an install from Settings is running npm for it. */
  const engineBusy = (plan: EnginePlan): boolean =>
    engineInUse(plan) || [plan.npm, ...(plan.pin.formerNpm ?? [])].some((pkg) => pkg && npmRunning(pkg, baseDir));

  /** Run just before a new copy takes over: it must answer the engine's handshake, and the engine must be free. */
  const beforeSwitch = (plan: EnginePlan, aborted: { busy: boolean }) => async (command: string): Promise<string | null> => {
    if (plan.pin.acp) {
      const env = { ...cliProbeEnvironment(), ...plan.standalone?.runEnv };
      stripControlPlaneEnv(env as Record<string, string | undefined>);
      const refused = await steps.handshake(command, plan.pin.acp, env);
      if (refused) return refused;
    }
    for (const until = now() + switchWait.forMs; engineInUse(plan);) {
      if (now() >= until) {
        aborted.busy = true;
        return "it is still in use";
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, switchWait.everyMs).unref?.());
    }
    return null;
  };

  const configuredInto = (pkg: string): boolean => {
    const folder = resolve(join(npmModulesIn(enginesPrefix(baseDir)), ...pkg.split("/")));
    const commands = npmCommandNames(folder, pkg)
      .flatMap((name) => [name, `${name}.cmd`, `${name}.ps1`])
      .map((entry) => resolve(join(enginesBinDir(baseDir), entry)));
    return (options.configuredClis?.() ?? []).some((cli) => inside(cli, folder) || commands.includes(resolve(cli)));
  };

  async function updateStandalone(plan: EnginePlan, release: StandaloneRelease): Promise<Outcome> {
    const current = steps.standaloneVersion(release, baseDir);
    const npmCopies = [plan.npm, ...(plan.pin.formerNpm ?? [])]
      .filter((pkg): pkg is string => Boolean(pkg))
      .map((pkg) => ({ pkg, version: steps.npmVersion(pkg, baseDir) }))
      .filter((copy): copy is { pkg: string; version: string } => copy.version !== null);
    if (current === null && npmCopies.length === 0) return { kind: "absent" };
    const from = current ?? npmCopies[0]!.version;
    let outcome: Outcome = { kind: "current" };
    if (current === null || isNewerVersion(release.version, current)) {
      if (engineBusy(plan)) return { kind: "busy" };
      const aborted = { busy: false };
      try {
        await steps.installStandalone(release, { baseDir, beforeSwitch: beforeSwitch(plan, aborted) });
      } catch (error) {
        if (aborted.busy) return { kind: "waiting" };
        return { kind: "failed", from, to: release.version, reason: error instanceof Error ? error.message : String(error) };
      }
      outcome = { kind: "updated", from, to: release.version };
    }
    // The npm copies an earlier install left go only once the app's own build is in place, and never one a setting runs.
    for (const { pkg } of npmCopies) {
      if (engineBusy(plan) || configuredInto(pkg)) continue;
      await steps.removeNpm(pkg, baseDir).catch((error: unknown) => {
        if (!(error instanceof EngineInUse)) log(`Engine update: ${plan.name}'s old copy (${pkg}) could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return outcome;
  }

  async function updateNpm(plan: EnginePlan, pkg: string): Promise<Outcome> {
    const current = steps.npmVersion(pkg, baseDir);
    if (current === null) return { kind: "absent" };
    if (engineBusy(plan)) return { kind: "busy" };
    let target = plan.pin.target;
    if (target === LATEST) {
      try {
        target = await steps.npmLatest(pkg, baseDir);
      } catch (error) {
        return { kind: "failed", from: current, to: LATEST, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!isNewerVersion(target, current)) return { kind: "current" };
    const aborted = { busy: false };
    try {
      await steps.updateNpm({ pkg, version: target, baseDir, cli: plan.cli, beforeSwitch: beforeSwitch(plan, aborted) });
    } catch (error) {
      if (aborted.busy || error instanceof EngineInUse) return { kind: "waiting" };
      return { kind: "failed", from: current, to: target, reason: error instanceof Error ? error.message : String(error) };
    }
    return { kind: "updated", from: current, to: target };
  }

  async function updateManaged(plan: EnginePlan, managed: ManagedRuntime): Promise<Outcome> {
    const older = await managed.older();
    if (older === null) return { kind: "absent" };
    if (engineBusy(plan)) return { kind: "busy" };
    try {
      await managed.install();
    } catch (error) {
      return { kind: "failed", from: older, to: plan.pin.target, reason: error instanceof Error ? error.message : String(error) };
    }
    return { kind: "updated", from: older, to: plan.pin.target };
  }

  const updateOne = (plan: EnginePlan): Promise<Outcome> => {
    if (plan.standalone) return updateStandalone(plan, plan.standalone);
    if (plan.npm) return updateNpm(plan, plan.npm);
    if (plan.managed) return updateManaged(plan, plan.managed);
    return Promise.resolve({ kind: "absent" });
  };

  const retryDelay = (plan: EnginePlan, from: string, failures: number): number => {
    const cap = isNewerVersion(plan.pin.minimum, from) ? BELOW_MINIMUM_RETRY_CAP_MS : ENGINE_UPDATE_EVERY_MS;
    return Math.min(cap, FIRST_RETRY_MS * 2 ** Math.min(failures - 1, 10));
  };

  async function pass(): Promise<void> {
    await steps.sweep(baseDir).catch(() => {});
    let waiting = false;
    let changed = false;
    for (const plan of options.plans) {
      const engine = state.engines[plan.driverKind] ?? {};
      if (engine.retryAt !== undefined && engine.retryAt > now()) continue;
      let outcome: Outcome;
      try {
        outcome = await updateOne(plan);
      } catch (error) {
        outcome = { kind: "failed", from: "?", to: plan.pin.target, reason: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.kind === "busy" || outcome.kind === "waiting") waiting = true;
      if (outcome.kind === "updated") {
        state.engines[plan.driverKind] = { updatedTo: outcome.to, updatedAt: now() };
        log(`Engine update: ${plan.name} ${outcome.from} → ${outcome.to}`);
        changed = true;
      } else if (outcome.kind === "failed") {
        const failures = (engine.failures ?? 0) + 1;
        state.engines[plan.driverKind] = { ...engine, failures, retryAt: now() + retryDelay(plan, outcome.from, failures) };
        log(`Engine update: ${plan.name} stays on ${outcome.from}; ${outcome.to} could not be installed (${outcome.reason.split("\n")[0]}). Trying again later.`);
      } else if (engine.failures) {
        state.engines[plan.driverKind] = { updatedTo: engine.updatedTo, updatedAt: engine.updatedAt };
      }
    }
    passed = true;
    busyRetryAt = waiting ? now() + ENGINE_UPDATE_BUSY_RETRY_MS : null;
    if (!waiting) state.checkedAt = now();
    save();
    if (changed) options.updated?.();
  }

  const dueAt = (): number => {
    if (!passed) return startedAt + ENGINE_UPDATE_START_DELAY_MS;
    const times = [(state.checkedAt ?? startedAt) + ENGINE_UPDATE_EVERY_MS];
    if (busyRetryAt !== null) times.push(busyRetryAt);
    for (const engine of Object.values(state.engines)) if (engine.failures && engine.retryAt !== undefined) times.push(engine.retryAt);
    return Math.min(...times);
  };

  const check = (): Promise<void> => {
    running ??= pass().finally(() => { running = null; });
    return running;
  };

  return {
    check,
    dueAt,
    shown(driverKind) {
      const engine = state.engines[driverKind];
      return engine?.updatedTo && engine.updatedAt !== undefined && now() - engine.updatedAt < SHOW_UPDATED_MS
        ? { autoUpdated: { version: engine.updatedTo, at: engine.updatedAt } }
        : {};
    },
    start() {
      return startDueTimer({
        now,
        next: dueAt,
        retryMs: ENGINE_UPDATE_BUSY_RETRY_MS,
        run: () => (now() >= dueAt() ? check() : undefined),
        onError: (error) => log(`Engine update: ${error instanceof Error ? error.message : String(error)}`),
      });
    },
  };
}
