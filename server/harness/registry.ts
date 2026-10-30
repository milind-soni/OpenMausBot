// Provider instance registry — port of upstream's ProviderInstanceRegistryLive behavior, minus Effect.
import { findCliCandidates } from "../env-path.ts";
import { installNpmEngine, npmAvailable, serverInstallFor, standaloneLookupPath } from "../engine-install.ts";
import { installStandaloneEngine, isAppStandaloneCopy, type StandaloneInstalled } from "../engine-standalone.ts";
import { withEngineMemory } from "../engine-memory.ts";
import { withEngineHomes } from "../engine-homes/engine-homes.ts";
import { engineStatusFile, snapshotFrom } from "./engine-status-file.ts";
import { withUnaskedStops } from "./unasked-stop.ts";
export { engineMemory } from "../engine-memory.ts";
import { clientInstall } from "../contracts.ts";
import type {
  AnyProviderDriver,
  EngineAccess,
  InstanceConfigMap,
  InstanceId,
  ProviderAuthenticationStart,
  ProviderAuthenticationStatus,
  ProviderInstance,
  ProviderSnapshot,
  StandaloneRelease,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

/** The pinned standalone release (URLs, hashes) stays on the server; the client sees only `server`. The app's own
 * standalone copy is not on the person's terminal PATH, so its terminal sign-in command is dropped and `appCopy` says so. */
function withServerInstall(install: AnyProviderDriver["install"], npmPresent: boolean, appCopy = false): AnyProviderDriver["install"] {
  if (!install) return undefined;
  const server = serverInstallFor(install, npmPresent);
  const platform = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : undefined;
  return { ...clientInstall(install), platform, ...(server ? { server } : {}), ...(appCopy ? { signInCommand: undefined, appCopy: true } : {}) };
}

type InstallStandalone = (release: StandaloneRelease, options: { baseDir?: string }) => Promise<StandaloneInstalled>;

/** Installed; `useCli` when the copy this engine's CLI finds does not start and it should run the app's own copy instead. */
export type InstallResult = true | { useCli: string };

function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

export const SNAPSHOT_DEADLINE_MS = 60_000;
/** How long a finished status read answers later reads, so a start-up's model lists and engine-list reads probe each CLI once. */
export const SNAPSHOT_REUSE_MS = 3_000;
const SNAPSHOT_DEADLINE_REASON = "This engine did not report its status within a minute. Check that its CLI starts in a terminal.";

function withinDeadline(read: () => Promise<ProviderSnapshot>): Promise<ProviderSnapshot> {
  let deadline: NodeJS.Timeout | undefined;
  return Promise.race([
    read(),
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(SNAPSHOT_DEADLINE_REASON)), SNAPSHOT_DEADLINE_MS);
      deadline.unref?.();
    }),
  ]).finally(() => clearTimeout(deadline));
}

/** How long the start-up read waits on one CLI before probing the next, so a stuck CLI holds back no other for long. */
export const START_READ_STEP_MS = 5_000;

function settledOrAfter(read: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([read, new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

/** The engines these selections name, the most named first, so the start-up read reaches the likeliest next turn's engine first. */
export function enginesByUse(selections: ReadonlyArray<{ instanceId: InstanceId } | undefined>): InstanceId[] {
  const uses = new Map<InstanceId, number>();
  for (const selection of selections) if (selection?.instanceId) uses.set(selection.instanceId, (uses.get(selection.instanceId) ?? 0) + 1);
  return [...uses].sort((a, b) => b[1] - a[1]).map(([instanceId]) => instanceId);
}

type SharedRead = { generation: number; settledAt?: number; read: Promise<ProviderSnapshot> };

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  private cliByInstance = new Map<InstanceId, string>();
  private lastSnapshots = new Map<InstanceId, ProviderSnapshot>();
  private seeds = new Map<InstanceId, ProviderSnapshot>();
  private seedObjects = new WeakSet<ProviderSnapshot>();
  /** Engines the start-up read has not probed yet; null outside that read. */
  private unread: Set<InstanceId> | null = null;
  private snapshotGeneration = 0;
  private driversByKind: Map<string, AnyProviderDriver>;
  private readonly enginesBaseDir: string | undefined;
  private readonly npmPresent: () => boolean;
  private readonly status: ReturnType<typeof engineStatusFile> | null;
  private readonly installStandalone: InstallStandalone;

  constructor(
    drivers: readonly AnyProviderDriver[],
    options: { enginesBaseDir?: string; npmAvailable?: () => boolean; statusFile?: string; installStandalone?: InstallStandalone } = {},
  ) {
    this.enginesBaseDir = options.enginesBaseDir;
    this.npmPresent = options.npmAvailable ?? npmAvailable;
    this.status = options.statusFile ? engineStatusFile(options.statusFile) : null;
    this.installStandalone = options.installStandalone ?? installStandaloneEngine;
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  async load(configs: InstanceConfigMap, decorate?: (instance: ProviderInstance) => ProviderInstance) {
    const slots = [...this.byId.keys()];
    const loaded = await Promise.all(
      Object.entries(configs).map(async ([instanceId, entry]) => {
        const ready = await this.createEntry(instanceId, entry, decorate);
        this.byId.set(instanceId, ready);
        return ready;
      }),
    );
    // Config order, not completion order; an entry a dispose replaced meanwhile is not this load's to place.
    const placed = new Set(loaded.filter((entry) => this.byId.get(entry.instanceId) === entry).map((entry) => entry.instanceId));
    const entries = new Map(this.byId);
    this.byId.clear();
    for (const id of [...slots, ...[...entries.keys()].filter((id) => !placed.has(id)), ...placed]) {
      const entry = entries.get(id);
      if (entry && !this.byId.has(id)) this.byId.set(id, entry);
    }
  }

  private async createEntry(
    instanceId: InstanceId,
    entry: InstanceConfigMap[string],
    decorate?: (instance: ProviderInstance) => ProviderInstance,
  ): Promise<RegistryEntry> {
    await this.dispose(instanceId);
    const driver = this.driversByKind.get(entry.driver);
    if (!driver) {
      return {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
        },
      };
    }
    try {
      const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
      // The RAW config: decodeConfig fills in the driver default, which would flag every instance as overridden.
      const rawCli = cliOfRaw(entry.config);
      if (rawCli) this.cliByInstance.set(instanceId, rawCli);
      const live = withUnaskedStops(withEngineHomes(withEngineMemory(await driver.create({
        instanceId,
        displayName: entry.displayName ?? driver.metadata.displayName,
        environment: entry.environment ?? {},
        enabled: entry.enabled ?? true,
        config,
      }))));
      this.shareSnapshot(live);
      return { instanceId, live: decorate ? decorate(live) : live };
    } catch (e) {
      return {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName ?? driver.metadata.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  /**
   * One engine's status read, bounded and shared: callers join the probe in flight, and one that finished within
   * SNAPSHOT_REUSE_MS answers again, so the CLI is not spawned twice for the same answer. A failed read is never reused.
   * Replaced on the driver's own instance, beneath a decorator's checks, which still run on every read; an object
   * spread would evaluate getters such as `models` once.
   */
  private shareSnapshot(instance: ProviderInstance): void {
    const read = instance.snapshot.bind(instance);
    let held: SharedRead | undefined;
    instance.snapshot = () => {
      if (held && held.generation === this.snapshotGeneration
        && (held.settledAt === undefined || Date.now() - held.settledAt < SNAPSHOT_REUSE_MS)) return held.read;
      const current: SharedRead = { generation: this.snapshotGeneration, read: withinDeadline(read) };
      held = current;
      current.read.then(() => { current.settledAt = Date.now(); }, () => { if (held === current) held = undefined; });
      return current.read;
    };
  }

  /** Every engine's next status read probes its CLI again: an install, update, sign-in or key change may alter what it reports. */
  forgetSnapshots(): void {
    this.snapshotGeneration += 1;
    this.seeds.clear();
  }

  /**
   * The start-up read on an existing store. Engines that run a CLI are probed one at a time, the most used first, so
   * each CLI is read from a cold disk with no other in the way; `afterFirst` runs once the first has answered; engines
   * without a CLI are read at once. An engine the last run saw available that a probe now finds unavailable is probed
   * once more, warm, before the read ends. Until the read reaches an engine, a turn on it probes that engine itself
   * (`engineRead`) and `describe({ known: true })` answers it from the last run's status.
   */
  async readAtStart(first: readonly InstanceId[] = [], afterFirst: () => void = () => {}) {
    const live = this.instances().map((instance) => instance.instanceId);
    for (const [instanceId, snapshot] of this.status?.read((id) => this.byId.get(id)?.live ? this.cliTarget(id) : null) ?? []) {
      this.seeds.set(instanceId, snapshot);
      this.seedObjects.add(snapshot);
    }
    const seeded = new Map(this.seeds);
    this.unread = new Set(live);
    try {
      const withCli = new Set(live.filter((id) => this.cliTarget(id)?.cli));
      const withoutCli = this.engineRead(...live.filter((id) => !withCli.has(id)));
      for (const instanceId of new Set([...first.filter((id) => withCli.has(id)), ...withCli])) {
        const read = this.engineRead(instanceId);
        if (read) await settledOrAfter(read, START_READ_STEP_MS);
        afterFirst();
      }
      afterFirst();
      await Promise.all([withoutCli, this.engineRead(...live)]);
      const gone = [...seeded].filter(([id, seed]) => seed.state === "available" && this.lastSnapshots.get(id)?.state === "unavailable");
      if (gone.length) {
        this.forgetSnapshots();
        for (const [id] of gone) this.unread?.add(id);
        await this.engineRead(...gone.map(([id]) => id));
      }
    } finally {
      afterFirst();
      this.unread = null;
      this.seeds.clear();
    }
    const changed = [...seeded].some(([id, seed]) => JSON.stringify(snapshotFrom(this.lastSnapshots.get(id))) !== JSON.stringify(seed));
    return { engines: await this.describeWith(async (instance) => this.lastSnapshots.get(instance.instanceId) ?? this.read(instance)), changed };
  }

  /** Null unless the start-up read has yet to probe one of these engines; otherwise those engines' probes, shared with other readers. */
  engineRead(...instanceIds: Array<InstanceId | undefined>): Promise<void> | null {
    const reads = [...new Set(instanceIds)].flatMap((instanceId) => {
      const instance = instanceId ? this.get(instanceId) : null;
      return instance && this.unread?.has(instance.instanceId) ? [this.read(instance)] : [];
    });
    return reads.length ? Promise.all(reads).then(() => undefined) : null;
  }

  /** While the start-up read runs, or for engines described from the last run's status, a choice made from them would rest on that older status. */
  provisional(described?: ReadonlyArray<{ snapshot: ProviderSnapshot }>): boolean {
    return this.unread !== null || Boolean(described?.some((instance) => this.seedObjects.has(instance.snapshot)));
  }

  /** The status probed here, else the one the last run recorded: for reports, never for choosing where a turn runs. */
  knownSnapshot(instanceId: InstanceId): ProviderSnapshot | undefined {
    return this.lastSnapshot(instanceId) ?? (this.byId.get(instanceId)?.live ? this.seeds.get(instanceId) : undefined);
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  lastSnapshot(instanceId: InstanceId): ProviderSnapshot | undefined {
    return this.byId.get(instanceId)?.live ? this.lastSnapshots.get(instanceId) : undefined;
  }

  access(instanceId: InstanceId): EngineAccess | undefined {
    const entry = this.byId.get(instanceId);
    return entry ? this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind)?.metadata.access ?? "subscription" : undefined;
  }

  /** From the registry's config, never an HTTP body. */
  cliTarget(instanceId: InstanceId): { driverKind: string; cli: string | null } | null {
    const entry = this.byId.get(instanceId);
    if (!entry) return null;
    const driverKind = entry.shadow?.driverKind ?? entry.live!.driverKind;
    const driver = this.driversByKind.get(driverKind);
    return {
      driverKind,
      cli: this.cliByInstance.get(instanceId) ?? entry.shadow?.cli ?? cliDefaultOf(driver) ?? null,
    };
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** Settings' Check and Refresh, and OpenCode's key policy changing: the engine's status is read again too. */
  async refreshModels(instanceId: InstanceId): Promise<boolean> {
    const instance = this.get(instanceId);
    if (!instance) return false;
    try {
      await instance.refreshModels?.();
    } finally {
      this.forgetSnapshots();
    }
    return true;
  }

  async installRuntime(instanceId: InstanceId): Promise<InstallResult | false> {
    const entry = this.byId.get(instanceId);
    if (!entry) return false;
    // A failed install changes the status too: Antigravity reports the failure as its reason.
    try {
      if (entry.live?.installRuntime) {
        await entry.live.installRuntime();
        return true;
      }
      // Then the vendor's own build for this platform, then npm.
      const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
      const server = serverInstallFor(driver?.install, this.npmPresent());
      if (server?.standalone && driver?.install?.standalone) {
        const installed = await this.installStandalone(driver.install.standalone, { baseDir: this.enginesBaseDir });
        return (await this.appCopyAdvice(instanceId, driver, installed)) ?? true;
      }
      if (!server?.package) return false;
      await installNpmEngine(server.package, { baseDir: this.enginesBaseDir, cli: cliDefaultOf(driver) });
      return true;
    } finally {
      this.forgetSnapshots();
    }
  }

  async startAuthentication(instanceId: InstanceId): Promise<ProviderAuthenticationStart | null> {
    const instance = this.get(instanceId);
    return instance?.startAuthentication ? instance.startAuthentication() : null;
  }

  async getAuthentication(instanceId: InstanceId, flowId: string): Promise<ProviderAuthenticationStatus | null> {
    const instance = this.get(instanceId);
    return instance?.getAuthentication ? instance.getAuthentication(flowId) : null;
  }

  async completeAuthentication(instanceId: InstanceId, flowId: string, callbackUrl: string): Promise<boolean> {
    const instance = this.get(instanceId);
    if (!instance?.completeAuthentication) return false;
    await instance.completeAuthentication(flowId, callbackUrl);
    return true;
  }

  async cancelAuthentication(instanceId: InstanceId): Promise<boolean> {
    const instance = this.get(instanceId);
    if (!instance?.cancelAuthentication) return false;
    await instance.cancelAuthentication();
    return true;
  }

  /** After the app's own copy installed: when this engine's CLI still finds another copy (a launcher stranded when Node.js
   * was removed, an old npm install) and that copy does not start, the engine should run the app's copy. Its own status
   * read is the check, so the copy is found and started exactly as the engine's processes do it. */
  private async appCopyAdvice(instanceId: InstanceId, driver: AnyProviderDriver, installed: StandaloneInstalled): Promise<{ useCli: string } | null> {
    const live = this.get(instanceId);
    const cli = cliDefaultOf(driver);
    // A CLI the person set with Set CLI is theirs to change; only the default name gets pointed elsewhere.
    const configured = this.cliByInstance.get(instanceId);
    if (configured !== undefined && configured !== cli) return null;
    if (!live || !cli || !installed.executablePath || this.appStandaloneCopy(driver, cli)) return null;
    this.forgetSnapshots();
    let state: ProviderSnapshot["state"];
    try {
      state = (await live.snapshot()).state;
    } catch {
      state = "unavailable";
    }
    return state === "available" ? null : { useCli: installed.executablePath };
  }

  /** Whether this engine's CLI runs the app's own standalone copy, looked up the way its spawns look it up. */
  private appStandaloneCopy(driver: AnyProviderDriver | undefined, cli: string | undefined): boolean {
    if (cli === undefined || !driver?.install?.standalone) return false;
    return isAppStandaloneCopy(cli, this.enginesBaseDir, standaloneLookupPath(this.enginesBaseDir));
  }

  describe(options: { known?: boolean } = {}) {
    return this.describeWith((instance) => {
      const seed = options.known && this.unread?.has(instance.instanceId) ? this.seeds.get(instance.instanceId) : undefined;
      return seed ? Promise.resolve(seed) : this.read(instance);
    });
  }

  private async read(instance: ProviderInstance): Promise<ProviderSnapshot> {
    let snapshot: ProviderSnapshot;
    try {
      snapshot = await instance.snapshot();
    } catch (e) {
      snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
    }
    // Only while this is still the live instance: a reload may have replaced it during the read.
    if (this.byId.get(instance.instanceId)?.live === instance) {
      this.lastSnapshots.set(instance.instanceId, snapshot);
      this.unread?.delete(instance.instanceId);
      this.saveStatus();
    }
    return snapshot;
  }

  private saveStatus(): void {
    this.status?.save(this.instances().flatMap(({ instanceId, driverKind }) => {
      const snapshot = this.lastSnapshots.get(instanceId) ?? this.seeds.get(instanceId);
      return snapshot ? [{ instanceId, driverKind, cli: this.cliTarget(instanceId)?.cli ?? null, snapshot }] : [];
    }));
  }

  private async describeWith(statusOf: (instance: ProviderInstance) => Promise<ProviderSnapshot>) {
    const candidatesByName = new Map<string, string[]>();
    const candidatesFor = (driver: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(driver);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
    const npmPresent = this.npmPresent();
    return Promise.all(
      this.entries().map(async (entry) => {
        const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
        if (entry.shadow) {
          return {
            instanceId: entry.instanceId,
            driverKind: entry.shadow.driverKind,
            displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
            snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
            models: { default: "", options: [] },
            capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
            access: driver?.metadata.access ?? "subscription",
            install: withServerInstall(driver?.install, npmPresent),
            cli: entry.shadow.cli,
            cliDefault: cliDefaultOf(driver),
            cliCandidates: candidatesFor(driver),
          };
        }
        const inst = entry.live;
        const snapshot = await statusOf(inst);
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          snapshot,
          models: inst.models,
          capabilities: {
            computerMcp: inst.adapter.capabilities.computerMcp === true,
            agentsMcp: inst.adapter.capabilities.agentsMcp === true,
            composioMcp: inst.adapter.capabilities.composioMcp === true,
            phoneMcp: inst.adapter.capabilities.phoneMcp === true,
            deviceMcp: inst.adapter.capabilities.deviceMcp === true,
            dataMcp: inst.adapter.capabilities.dataMcp === true,
            highlevelMcp: inst.adapter.capabilities.highlevelMcp === true,
            browserMcp: inst.adapter.capabilities.browserMcp === true,
            images: inst.adapter.capabilities.images === true,
            effortLevels: inst.adapter.capabilities.effortLevels,
            modelVariants: inst.adapter.capabilities.modelVariants === true,
            queueing: inst.adapter.capabilities.queueing === true,
            localComputerMcp: inst.adapter.capabilities.localComputerMcp === true,
            approvalReview: inst.reviewPermission !== undefined,
            backgroundText: inst.generateText !== undefined || inst.generateMemoryText !== undefined,
          },
          access: driver?.metadata.access ?? "subscription",
          install: withServerInstall(driver?.install, npmPresent, this.appStandaloneCopy(driver, this.cliByInstance.get(inst.instanceId) ?? cliDefaultOf(driver))),
          authentication: inst.startAuthentication
            ? {
                method: inst.authenticationMethod ?? (inst.getAuthentication && inst.completeAuthentication
                  ? "paste-code" as const // a link to open, then a code pasted back (Claude)
                  : inst.getAuthentication
                    ? "device-code" as const // a code to enter at the provider's page (Codex)
                    : "browser" as const), // a link and a callback URL (managed engines)
                signOut: inst.signOut !== undefined,
              }
            : undefined,
          cli: this.cliByInstance.get(inst.instanceId),
          cliDefault: cliDefaultOf(driver),
          cliCandidates: candidatesFor(driver),
        };
      }),
    );
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.lastSnapshots.clear();
    this.seeds.clear();
  }

  async dispose(instanceId: InstanceId) {
    const entry = this.byId.get(instanceId);
    this.byId.delete(instanceId);
    this.cliByInstance.delete(instanceId);
    this.lastSnapshots.delete(instanceId);
    this.seeds.delete(instanceId);
    await entry?.live?.dispose();
  }
}
