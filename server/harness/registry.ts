// Provider instance registry — port of upstream's ProviderInstanceRegistryLive behavior, minus Effect.
import { findCliCandidates } from "../env-path.ts";
import { installNpmEngine, npmAvailable, serverInstallFor, standaloneLookupPath } from "../engine-install.ts";
import { installStandaloneEngine, isAppStandaloneCopy, type StandaloneInstalled } from "../engine-standalone.ts";
import { pinnedNpmVersion } from "../engine-versions.ts";
import { withBotMemoryCap } from "../bot-memory-cap.ts";
import { engineMemory as memoryGate, withEngineMemory } from "../engine-memory.ts";
import { withEngineHomes } from "../engine-homes/engine-homes.ts";
import { withLocalContext } from "../drivers/local-inject.ts";
import { engineStatusFile, snapshotFrom } from "./engine-status-file.ts";
import {
  CALM_FAILURES_BELIEVED, cliPresent, heldSnapshot, inconclusiveFailure, PERSON_CHECK_MS, PROBE_QUEUE_WAIT_MS, PROBE_RETRY_MS, PROMPT_RETRIES, PROMPT_RETRY_MS,
  STATUS_STALE_MS, turnActivity,
} from "./probe-hold.ts";
import { noteProbeUnsettled } from "../cli-program.ts";
import { withUnaskedStops } from "./unasked-stop.ts";
import { withTurnScope } from "../crash-guard.ts";
import { withWslNotice } from "./wsl-launch.ts";
import { modelManifest, startModelManifestRefresh } from "../model-manifest/manifest.ts";
import { machinePressure } from "../machine-pressure.ts";
import { signInMethodOf } from "../sign-in-trace.ts";
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

/** The server's own registry, where turns wait for room (a Cloud home, a self-hosted Linux server): checks that can wait
 * wait for a calmer machine and for the engine's turns, and run one at a time on a small one. Off on the desktop app. */
export const probeGate = () => ({ pressed: machinePressure.pressed, small: machinePressure.small, turnsProve: memoryGate.enabled,
  log: (line: string) => console.warn(line) });

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

/** How Settings signs this engine in, when the app can: what its provider card shows, and what list_models tells a bot. */
export function signInOf(inst: ProviderInstance) {
  return inst.startAuthentication
    ? {
        // Named, else a link then a code pasted back (Claude), a code to enter at the provider's page (Codex), or a link
        // and a callback URL (managed engines).
        method: signInMethodOf(inst),
        signOut: inst.signOut !== undefined,
      }
    : undefined;
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
/** How long the engine list people see answers from earlier reads before one is read again in the background. */
export const ENGINE_LIST_REUSE_MS = 60_000;
const SNAPSHOT_DEADLINE_REASON = "This engine did not report its status within a minute. Check that its CLI starts in a terminal.";
/** A status read cut off by SNAPSHOT_DEADLINE_MS: it could not finish, which says nothing about the engine. */
class SnapshotDeadlineError extends Error {}

function withinDeadline(read: () => Promise<ProviderSnapshot>): Promise<ProviderSnapshot> {
  let deadline: NodeJS.Timeout | undefined;
  return Promise.race([
    read(),
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new SnapshotDeadlineError(SNAPSHOT_DEADLINE_REASON)), SNAPSHOT_DEADLINE_MS);
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

/** Engines that rebuild their model list from the manifest without starting a CLI, so a downloaded change applies at once. */
const MANIFEST_REBUILT_DRIVERS = new Set(["claudeAgent", "grokAgent", "kimiAgent"]);

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  private cliByInstance = new Map<InstanceId, string>();
  private lastSnapshots = new Map<InstanceId, ProviderSnapshot>();
  private seeds = new Map<InstanceId, ProviderSnapshot>();
  private seedObjects = new WeakSet<ProviderSnapshot>();
  /** Engines the start-up read has not probed yet; null outside that read. */
  private unread: Set<InstanceId> | null = null;
  private snapshotGeneration = 0;
  private manifestWatched = false;
  private readonly signedInListeners = new Set<(instanceId: InstanceId) => void>();
  /** The newest read that said plainly whether each engine is signed in, by the order reads began: a read that does not
   * say, or began before the one kept, keeps it. */
  private readonly lastAuth = new Map<InstanceId, { authenticated: boolean; read: number }>();
  private readsBegun = 0;
  /** Per instance object: settings that reload an engine make a new one, so its status is read afresh. */
  private readsOf = new WeakMap<ProviderInstance, { snapshot: ProviderSnapshot; at: number; generation: number }>();
  private driversByKind: Map<string, AnyProviderDriver>;
  private readonly enginesBaseDir: string | undefined;
  private readonly npmPresent: () => boolean;
  private readonly status: ReturnType<typeof engineStatusFile> | null;
  private readonly installStandalone: InstallStandalone;
  /** Whether the machine is too busy now for a check that can wait (machine-pressure.ts); never, unless given. */
  private readonly pressed: () => boolean;
  /** A machine where status checks that start a CLI run one at a time; none is, unless given. */
  private readonly small: () => boolean;
  private readonly cliPresent: (cli: string) => boolean;
  /** Engines whose last check could not finish: how many times in a row, and the check again that is due. */
  /** `calm`: checks in a row that could not finish while the machine was not pressed; `since`: the first of them; `prompt`:
   * prompt checks again spent after the person's own change. */
  private readonly retries = new Map<InstanceId, { attempt: number; timer?: NodeJS.Timeout; signOut?: true; calm: number; since: number; prompt: number }>();
  /** When the last change that may alter an engine's status was made (forgetSnapshots: an install, a sign-in, a key). */
  private changedAt = -Infinity;
  /** Engines whose checks failed to finish CALM_FAILURES_BELIEVED times on a calm machine: one more such check is believed
   * at once, until a check answers. */
  private readonly calmBroken = new Set<InstanceId>();
  private readonly turns = new Map<InstanceId, { activity: ReturnType<typeof turnActivity>; off: () => void }>();
  private probeQueue: Promise<void> = Promise.resolve();
  /** Whether a turn under way puts off its engine's checks that can wait (where turns wait for room); off unless given. */
  private readonly turnsProve: boolean;
  private readonly log: (line: string) => void;

  constructor(
    drivers: readonly AnyProviderDriver[],
    options: { enginesBaseDir?: string; npmAvailable?: () => boolean; statusFile?: string; installStandalone?: InstallStandalone;
      pressed?: () => boolean; small?: () => boolean; cliPresent?: (cli: string) => boolean; turnsProve?: boolean; log?: (line: string) => void } = {},
  ) {
    this.pressed = options.pressed ?? (() => false);
    this.small = options.small ?? (() => false);
    this.turnsProve = options.turnsProve === true;
    this.log = options.log ?? (() => {});
    this.cliPresent = options.cliPresent ?? ((cli) => cliPresent(cli));
    this.enginesBaseDir = options.enginesBaseDir;
    this.npmPresent = options.npmAvailable ?? npmAvailable;
    this.status = options.statusFile ? engineStatusFile(options.statusFile) : null;
    this.installStandalone = options.installStandalone ?? installStandaloneEngine;
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  private watchModelManifest(): void {
    if (this.manifestWatched) return;
    this.manifestWatched = true;
    modelManifest().onChange(() => {
      for (const instance of this.instances()) {
        if (MANIFEST_REBUILT_DRIVERS.has(instance.driverKind)) void this.refreshModels(instance.instanceId).catch(() => {});
      }
    });
    startModelManifestRefresh();
  }

  async load(configs: InstanceConfigMap, decorate?: (instance: ProviderInstance) => ProviderInstance) {
    this.watchModelManifest();
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
      const live = withLocalContext(withUnaskedStops(withEngineHomes(withBotMemoryCap(withEngineMemory(withTurnScope(await driver.create({
        instanceId,
        displayName: entry.displayName ?? driver.metadata.displayName,
        environment: entry.environment ?? {},
        enabled: entry.enabled ?? true,
        config,
      })))))));
      this.shareSnapshot(live);
      this.watchTurns(instanceId, live);
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
      const current: SharedRead = { generation: this.snapshotGeneration, read: this.probeSlot(instance.instanceId, () => withinDeadline(read)) };
      held = current;
      current.read.then(() => { current.settledAt = Date.now(); }, () => { if (held === current) held = undefined; });
      return current.read;
    };
  }

  /** On a small machine, a status read that starts a CLI waits for the one before it (at most PROBE_QUEUE_WAIT_MS), so a
   * starved Cloud never runs several engines' checks at once; elsewhere, and for engines without a CLI, it starts now. */
  private probeSlot(instanceId: InstanceId, run: () => Promise<ProviderSnapshot>): Promise<ProviderSnapshot> {
    if (!this.cliTarget(instanceId)?.cli || !this.small()) return run();
    const read = settledOrAfter(this.probeQueue, PROBE_QUEUE_WAIT_MS).then(run);
    this.probeQueue = read.then(() => undefined, () => undefined);
    return read;
  }

  /** A turn of this engine that is under way proves it runs: its own events say which. */
  private watchTurns(instanceId: InstanceId, live: ProviderInstance): void {
    this.turns.get(instanceId)?.off();
    this.turns.delete(instanceId);
    if (!this.turnsProve) return;
    const activity = turnActivity();
    let off: unknown;
    try { off = live.adapter.onEvent((event) => activity.note(event)); } catch {}
    this.turns.set(instanceId, { activity, off: typeof off === "function" ? off as () => void : () => {} });
  }

  /** A check that can wait does, while the machine is pressed or the engine has a turn under way. */
  probeDeferred(instanceId: InstanceId): boolean {
    return this.turns.get(instanceId)?.activity.running() === true || this.pressed();
  }

  /** After a check that could not finish: one more, later, backing off; a turn or a pressed machine puts it off again. */
  private retryEntry(instanceId: InstanceId) {
    const entry = this.retries.get(instanceId) ?? { attempt: 0, calm: 0, since: Date.now(), prompt: 0 };
    this.retries.set(instanceId, entry);
    return entry;
  }

  /** Put off by a pressed machine or a turn only up to a point: never past the back-off's last step, nor once the status is
   * STATUS_STALE_MS old. After the person's own change the check is tried again promptly, pressed or not, a few times. */
  private retryLater(instance: ProviderInstance, signOut = false): void {
    const entry = this.retryEntry(instance.instanceId);
    if (signOut) entry.signOut = true;
    if (entry.timer) return;
    const prompt = Date.now() - this.changedAt < PERSON_CHECK_MS && entry.prompt < PROMPT_RETRIES;
    if (prompt) entry.prompt += 1;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.retries.get(instance.instanceId) !== entry || this.byId.get(instance.instanceId)?.live !== instance) return;
      entry.attempt += 1;
      const due = prompt || entry.signOut === true || entry.attempt >= PROBE_RETRY_MS.length - 1 || Date.now() - entry.since >= STATUS_STALE_MS;
      if (!due && this.probeDeferred(instance.instanceId)) this.retryLater(instance);
      else void this.read(instance);
    }, prompt ? PROMPT_RETRY_MS : PROBE_RETRY_MS[Math.min(entry.attempt, PROBE_RETRY_MS.length - 1)]);
    entry.timer.unref?.();
  }

  private stopRetry(instanceId: InstanceId): void {
    const entry = this.retries.get(instanceId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.retries.delete(instanceId);
  }

  /** Every engine's next status read probes its CLI again: an install, update, sign-in or key change may alter what it reports. */
  forgetSnapshots(): void {
    this.snapshotGeneration += 1;
    this.changedAt = Date.now();
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
      // Also one whose check could not finish and kept the last status (probe-hold.ts), unless the machine is pressed now.
      const gone = [...seeded].filter(([id, seed]) => seed.state === "available"
        && (this.lastSnapshots.get(id)?.state === "unavailable" || (this.retries.has(id) && !this.probeDeferred(id))));
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

  /** How this engine is installed and signed in, from what its provider card is built from; no status read. */
  connection(instanceId: InstanceId) {
    const entry = this.byId.get(instanceId);
    const driver = entry && this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
    return { install: clientInstall(driver?.install), signIn: entry?.live && signInOf(entry.live), account: driver?.metadata.signInAccount };
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
      await installNpmEngine(server.package, { baseDir: this.enginesBaseDir, cli: cliDefaultOf(driver), version: driver ? pinnedNpmVersion(driver.driverKind) : undefined });
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
    // A CLI the person set with Set CLI is theirs to change, unless it runs another program altogether (an install
    // command pasted as the path); otherwise only the default name gets pointed elsewhere.
    const configured = this.cliByInstance.get(instanceId);
    const theirs = configured !== undefined && configured !== cli;
    if (!live || !cli || !installed.executablePath || (!theirs && this.appStandaloneCopy(driver, cli))) return null;
    this.forgetSnapshots();
    let snapshot: ProviderSnapshot;
    try {
      snapshot = await live.snapshot();
    } catch {
      snapshot = { state: "unavailable" };
    }
    if (snapshot.state === "available" || (theirs && snapshot.notEngineCli !== true)) return null;
    return { useCli: installed.executablePath };
  }

  /** Set by the instance routes: points an engine whose saved CLI path runs another program at its own installed CLI, as
   * Set CLI would, and reloads it. */
  private cliHealer: ((instanceId: InstanceId, cli: string) => Promise<unknown>) | null = null;
  private healing = new Set<InstanceId>();
  onWrongCli(heal: (instanceId: InstanceId, cli: string) => Promise<unknown>): void {
    this.cliHealer = heal;
  }

  /** A saved CLI path that answered as another program, while the engine's own CLI is installed (the app's copy, or one
   * on PATH): the engine runs its own instead, with nobody having to Reset the path. */
  private healWrongCli(instanceId: InstanceId, snapshot: ProviderSnapshot): void {
    const driver = this.driversByKind.get(this.byId.get(instanceId)?.live?.driverKind ?? "");
    const cli = cliDefaultOf(driver);
    const saved = this.cliByInstance.get(instanceId);
    if (snapshot.notEngineCli !== true || !this.cliHealer || !cli || saved === undefined || saved === cli || this.healing.has(instanceId)) return;
    const own = findCliCandidates(cli, driver?.install?.standalone ? standaloneLookupPath(this.enginesBaseDir) : undefined)[0];
    // The path found is the one already saved: it is that one that answers as another program.
    if (!own || own === saved) return;
    this.healing.add(instanceId);
    void this.cliHealer(instanceId, own).catch(() => {}).finally(() => this.healing.delete(instanceId));
  }

  /** Whether this engine's CLI runs the app's own standalone copy, looked up the way its spawns look it up. */
  private appStandaloneCopy(driver: AnyProviderDriver | undefined, cli: string | undefined): boolean {
    if (cli === undefined || !driver?.install?.standalone) return false;
    return isAppStandaloneCopy(cli, this.enginesBaseDir, standaloneLookupPath(this.enginesBaseDir));
  }

  /** `reuse`: answer from a status read since the last forgetSnapshots(); one older than `ms` is read again in the background
   * and `changed` runs when that read differs. One older than `maxAgeMs` is not reused: its engine is read first. */
  describe(options: { known?: boolean; reuse?: { ms: number; maxAgeMs?: number; changed(): void } } = {}) {
    return this.describeWith((instance) => {
      const seed = options.known && this.unread?.has(instance.instanceId) ? this.seeds.get(instance.instanceId) : undefined;
      if (seed) return Promise.resolve(seed);
      const last = options.reuse && this.readsOf.get(instance);
      if (!options.reuse || !last || last.generation !== this.snapshotGeneration) return this.read(instance);
      // A check that can wait does not run during a turn of this engine or while the machine is pressed: the last answer
      // stands, until it is STATUS_STALE_MS old.
      const waits = Date.now() - last.at < STATUS_STALE_MS && this.probeDeferred(instance.instanceId);
      if (options.reuse.maxAgeMs !== undefined && Date.now() - last.at >= options.reuse.maxAgeMs && !waits) return this.read(instance);
      if (waits) return Promise.resolve(last.snapshot);
      if (Date.now() - last.at >= options.reuse.ms) {
        const { changed } = options.reuse;
        void this.read(instance).then((snapshot) => { if (JSON.stringify(snapshot) !== JSON.stringify(last.snapshot)) changed(); });
      }
      return Promise.resolve(last.snapshot);
    });
  }

  private async read(instance: ProviderInstance): Promise<ProviderSnapshot> {
    let snapshot: ProviderSnapshot;
    let answered = true, inconclusive = false;
    const generation = this.snapshotGeneration, begun = ++this.readsBegun;
    try {
      snapshot = await instance.snapshot();
      inconclusive = snapshot.state === "unavailable" && snapshot.busy === true;
    } catch (e) {
      answered = false;
      inconclusive = e instanceof SnapshotDeadlineError || inconclusiveFailure(e);
      snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e), ...(inconclusive ? { busy: true as const } : {}) };
    }
    const before = this.lastSnapshots.get(instance.instanceId) ?? this.seeds.get(instance.instanceId);
    // Signed out, read on a pressed machine just after being signed in: checked once more (pressed or not) before it is
    // believed. Believed at once after a sign-in change (forgetSnapshots since this engine's last read), and the second time.
    const lastRead = this.readsOf.get(instance), signOutHeld = this.retries.get(instance.instanceId)?.signOut === true;
    const holdSignOut = !inconclusive && !signOutHeld && before?.authenticated === true && snapshot.state === "available" && snapshot.authenticated === false
      && (lastRead === undefined || lastRead.generation === generation) && this.pressed();
    if (holdSignOut) inconclusive = true;
    // A check that keeps failing to finish on a calm machine is an answer: the engine hangs or is killed, it is not starved.
    const calm = (this.retries.get(instance.instanceId)?.calm ?? 0) + (inconclusive && !holdSignOut && !this.pressed() ? 1 : 0);
    const believed = inconclusive && !holdSignOut && (calm >= CALM_FAILURES_BELIEVED || (calm > 0 && this.calmBroken.has(instance.instanceId)));
    if (!inconclusive) this.calmBroken.delete(instance.instanceId);
    if (believed) {
      inconclusive = false;
      this.calmBroken.add(instance.instanceId);
      const { busy: _busy, ...failed } = snapshot;
      snapshot = { ...failed, state: "unavailable" };
      this.log(`engines: ${instance.instanceId}'s status check failed to finish ${calm} times in a row on a calm machine; taken as its answer`);
    } else if (inconclusive) {
      const cli = this.cliTarget(instance.instanceId)?.cli;
      snapshot = heldSnapshot(before, snapshot, () => (cli ? this.cliPresent(cli) : null));
      this.log(`engines: ${instance.instanceId}'s status check gave no clear answer; ${snapshot === before ? "keeping its last status"
        : snapshot.unverified ? "its program is there, taken as installed until a check answers" : snapshot.busy ? "status unknown" : "its program is not there"}`);
    }
    if (answered || inconclusive) this.readsOf.set(instance, { snapshot, at: Date.now(), generation });
    // Only while this is still the live instance: a reload may have replaced it during the read.
    if (this.byId.get(instance.instanceId)?.live === instance) {
      if (inconclusive) {
        this.retryEntry(instance.instanceId).calm = calm;
        this.retryLater(instance, holdSignOut);
      } else this.stopRetry(instance.instanceId);
      const cli = this.cliTarget(instance.instanceId)?.cli;
      if (cli) noteProbeUnsettled(cli, inconclusive && !holdSignOut);
      this.lastSnapshots.set(instance.instanceId, snapshot);
      this.unread?.delete(instance.instanceId);
      this.saveStatus();
      if (!inconclusive) this.healWrongCli(instance.instanceId, snapshot);
      const kept = this.lastAuth.get(instance.instanceId), knew = kept ? kept.authenticated : before?.authenticated;
      const newest = !kept || kept.read < begun;
      if (newest && !inconclusive && snapshot.state === "available" && typeof snapshot.authenticated === "boolean") this.lastAuth.set(instance.instanceId, { authenticated: snapshot.authenticated, read: begun });
      if (newest && !inconclusive && knew === false && snapshot.state === "available" && snapshot.authenticated === true) {
        for (const listener of this.signedInListeners) listener(instance.instanceId);
      }
    }
    return snapshot;
  }

  /** `listener` hears of each engine whose status read turns from signed out to signed in, however the sign-in happened:
   * in the app, in the engine's own browser callback, or in a terminal. */
  onSignedIn(listener: (instanceId: InstanceId) => void): void {
    this.signedInListeners.add(listener);
  }

  /** A sign-in the app made and tells itself: the next read that finds it signed in tells nothing new. */
  sawSignedIn(instanceId: InstanceId): void {
    this.lastAuth.set(instanceId, { authenticated: true, read: ++this.readsBegun });
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
        const cli = this.cliByInstance.get(inst.instanceId);
        const snapshot = withWslNotice(await statusOf(inst), cli);
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          snapshot,
          models: inst.models,
          ...(inst.modelsUnconfirmed ? { modelsUnconfirmed: true, ...(inst.modelsUnreadable ? { modelsUnreadable: inst.modelsUnreadable } : {}) } : {}),
          capabilities: {
            computerMcp: inst.adapter.capabilities.computerMcp === true,
            agentsMcp: inst.adapter.capabilities.agentsMcp === true,
            composioMcp: inst.adapter.capabilities.composioMcp === true,
            phoneMcp: inst.adapter.capabilities.phoneMcp === true,
            deviceMcp: inst.adapter.capabilities.deviceMcp === true,
            dataMcp: inst.adapter.capabilities.dataMcp === true,
            emailMcp: inst.adapter.capabilities.emailMcp === true,
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
          install: withServerInstall(driver?.install, npmPresent, this.appStandaloneCopy(driver, cli ?? cliDefaultOf(driver))),
          authentication: signInOf(inst),
          cli,
          cliDefault: cliDefaultOf(driver),
          cliCandidates: candidatesFor(driver),
        };
      }),
    );
  }

  async disposeAll() {
    for (const instanceId of this.retries.keys()) this.stopRetry(instanceId);
    for (const { off } of this.turns.values()) off();
    this.turns.clear();
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.lastSnapshots.clear();
    this.lastAuth.clear();
    this.seeds.clear();
  }

  async dispose(instanceId: InstanceId) {
    const entry = this.byId.get(instanceId);
    this.stopRetry(instanceId);
    this.turns.get(instanceId)?.off();
    this.turns.delete(instanceId);
    this.byId.delete(instanceId);
    this.cliByInstance.delete(instanceId);
    this.lastSnapshots.delete(instanceId);
    this.lastAuth.delete(instanceId);
    this.seeds.delete(instanceId);
    await entry?.live?.dispose();
  }
}
