import { existsSync, readdirSync } from "node:fs";
import {
  autoLocalVmAttachable,
  containerRuntimeStatus,
  localVmWakeAction,
  perBotLocalVmTarget,
  poolLocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
  setupCommands,
  PER_BOT_VM_HOMES_DIR,
  type ContainerComputerStatus,
  type LocalVmTarget,
  type Runtime,
} from "../container-computer.ts";
import { containerComputerManagedPerBotNames as listManagedPerBotNames } from "../container-computer-inventory.ts";
import { ComputerIdleTimer } from "../computer-idle.ts";
import { createLocalVmUpdater, type LocalVmUpdater } from "../desktop-updates.ts";
import { localVmInventoryEntry, discoverExistingPerBotLocalVms, type LocalVmInventoryBot } from "../local-vm-inventory.ts";
import { LocalVmLeasePool } from "../local-vm-lease.ts";
import { LocalVmSeatPool, type LocalVmSeatHolder } from "../local-vm-seat-pool.ts";
import { localVmStopReason, recordLocalVmIdleStop } from "../local-vm-stop-reason.ts";
import { keepInstalledAppsBeforeRemove } from "../local-vm-profiles.ts";
import { startStoppedPodmanMachine } from "../podman-machine.ts";
import { localVmViewerStatus } from "../desktop-viewer-targets.ts";
import { EXISTING_VM_LEASE_KEY } from "../existing-vm.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Message } from "../store.ts";

type LocalVmMode = "shared" | "per-bot" | "pool";
type LocalVmAction = "pull" | "stop" | "remove" | "start" | "run";

interface MapAccess<Value> {
  get(key: string): Value | undefined;
  set(key: string, value: Value): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  entries(): IterableIterator<[string, Value]>;
  values(): IterableIterator<Value>;
  readonly size: number;
}

interface SetAccess {
  add(value: string): void;
  delete(value: string): boolean;
  has(value: string): boolean;
  readonly size: number;
}

export interface LocalVmTurnsDeps {
  mode(): LocalVmMode;
  maxInstances(): number;
  idleTimeoutMs(): number;
  preserveInstalledApps(): boolean;
  ownerBusy(botId: string): boolean;
  bots(): LocalVmInventoryBot[];
  runtimeStatus(): ReturnType<typeof containerRuntimeStatus>;
  status(target: LocalVmTarget): Promise<ContainerComputerStatus>;
  act(action: LocalVmAction, target: LocalVmTarget): Promise<ContainerComputerStatus>;
  broadcastProvisioning(botId: string): void;
  source(): "managed" | "existing";
  existingStatus(): Promise<unknown>;
  releaseAutoVmClaim(threadId: string): void;
  closeExistingVmScreenshotSessions(): void;
  announceUpdate(threadId: string, text: string, from?: Message["from"]): void;
  cancelledUpdate(): Error;
  platform: NodeJS.Platform;
}

function mapAccess<Value>(map: Map<string, Value>): MapAccess<Value> {
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
    delete: (key) => map.delete(key),
    has: (key) => map.has(key),
    entries: () => map.entries(),
    values: () => map.values(),
    get size() { return map.size; },
  };
}

function setAccess(set: Set<string>): SetAccess {
  return {
    add: (value) => { set.add(value); },
    delete: (value) => set.delete(value),
    has: (value) => set.has(value),
    get size() { return set.size; },
  };
}

/** Local VM turn admission, leases, idle cleanup and readiness. Shared maps stay private behind narrow accessors. */
export function createLocalVmTurns(deps: LocalVmTurnsDeps) {
  const ownerBusy = deps.ownerBusy;
  const leases = new LocalVmLeasePool(30 * 60_000);
  const seats = new LocalVmSeatPool(deps.maxInstances);
  const lifecycleBusy = new Set<string>();
  const threadTargets = new Map<string, LocalVmTarget>();
  const activeThreads = new Map<string, string>();
  const seen = new Set<string>();
  const idles = new Map<string, ComputerIdleTimer>();
  const existingVmThreadIds = new Map<string, string>();
  const existingVmActiveThreads = new Map<string, string>();
  const humanWaitLeaseRenewals = new Map<string, ReturnType<typeof setInterval>>();
  const existingVmLease = leases.forTarget(EXISTING_VM_LEASE_KEY);
  let imageBusy = false;
  let provisionBusy = false;
  let modeChangeBusy = false;

  const localVmIdleMs = () => deps.idleTimeoutMs();

  function targetForBot(botId: string): LocalVmTarget {
    return deps.mode() === "per-bot" ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;
  }

  function poolSeatHolder(seat: number): LocalVmSeatHolder | null {
    return leases.forTarget(poolLocalVmTarget(seat).key).current(ownerBusy);
  }

  function targetForThread(botId: string, threadId: string): LocalVmTarget {
    if (deps.mode() !== "pool") return targetForBot(botId);
    return poolLocalVmTarget(seats.assign(threadId, poolSeatHolder));
  }

  /** Records no affinity: a status probe must not steer a later turn's seat. */
  function targetForStatus(botId: string, threadId?: string): LocalVmTarget {
    if (deps.mode() !== "pool") return targetForBot(botId);
    // Prefer the live target: an in-flight turn keeps its seat after its affinity TTL decays.
    const activeTarget = threadId ? threadTargets.get(threadId) : undefined;
    if (activeTarget) return activeTarget;
    return poolLocalVmTarget((threadId ? seats.affinitySeat(threadId) : null) ?? 0);
  }

  function leaseFor(target: LocalVmTarget) {
    return leases.forTarget(target.key);
  }

  function idleFor(target: LocalVmTarget): ComputerIdleTimer {
    let idle = idles.get(target.key);
    if (idle) return idle;
    idle = new ComputerIdleTimer(
      localVmIdleMs(),
      () => imageBusy || lifecycleBusy.has(target.key) || activeThreads.has(target.key),
      async () => {
        lifecycleBusy.add(target.key);
        try {
          const status = await deps.status(target);
          if (status.container === "running" && status.managed) {
            const stopped = await deps.act("stop", target);
            recordLocalVmIdleStop(target.key, stopped.stopped_at);
          }
        } finally {
          lifecycleBusy.delete(target.key);
        }
      },
    );
    idles.set(target.key, idle);
    return idle;
  }

  function noteSeen(target: LocalVmTarget, status: ContainerComputerStatus | null | undefined): void {
    if (status && (updates.observe(target, status) || autoLocalVmAttachable(status))) seen.add(target.key);
  }

  function stopHumanWaitLeaseRenewal(threadId: string): void {
    const timer = humanWaitLeaseRenewals.get(threadId);
    if (!timer) return;
    clearInterval(timer);
    humanWaitLeaseRenewals.delete(threadId);
  }

  function renewHumanWaitLease(threadId: string): void {
    const touch = () => {
      const target = threadTargets.get(threadId);
      if (target) {
        leaseFor(target).touch(threadId);
        return;
      }
      if (existingVmThreadIds.has(threadId)) {
        existingVmLease.touch(threadId);
        return;
      }
      stopHumanWaitLeaseRenewal(threadId);
    };
    touch();
    if (humanWaitLeaseRenewals.has(threadId)) return;
    const timer = setInterval(touch, 5 * 60_000);
    timer.unref?.();
    humanWaitLeaseRenewals.set(threadId, timer);
  }

  const updates: LocalVmUpdater = createLocalVmUpdater({
    status: deps.status,
    act: deps.act,
    imageBusy: { get: () => imageBusy, set: (busy) => { imageBusy = busy; } },
    provisionBusy: { get: () => provisionBusy, set: (busy) => { provisionBusy = busy; } },
    lifecycleBusy,
    inUse: (target) => modeChangeBusy || activeThreads.has(target.key) || Boolean(leaseFor(target).current(ownerBusy)),
    updated: (target, status) => { noteSeen(target, status); idleFor(target).touch(); },
    keepApps: async (target, status, stop) => deps.preserveInstalledApps()
      ? keepInstalledAppsBeforeRemove(target, status, stop)
      : "none",
    log: (message) => console.warn(message),
  });

  function waitForUpdate(target: LocalVmTarget, threadId: string, isCurrent: () => boolean, from?: Message["from"]): Promise<void> {
    return updates.waitFor(target, {
      isCurrent,
      cancelled: deps.cancelledUpdate,
      announce: (text) => deps.announceUpdate(threadId, text, from),
    });
  }

  function releaseThread(threadId: string): void {
    stopHumanWaitLeaseRenewal(threadId);
    deps.releaseAutoVmClaim(threadId);
    const target = threadTargets.get(threadId);
    if (!target) return;
    // Renew affinity at settlement, with the seat the turn ran on, so it leaves the full TTL after it ends.
    if (deps.mode() === "pool") {
      const pooled = /^pool:(\d+)$/.exec(target.key);
      if (pooled) seats.renew(threadId, Number(pooled[1]));
      else seats.touch(threadId);
    }
    leaseFor(target).release(threadId);
    if (activeThreads.get(target.key) === threadId) activeThreads.delete(target.key);
    threadTargets.delete(threadId);
  }

  function releaseExistingVmThread(threadId: string, closeSessions = true): void {
    stopHumanWaitLeaseRenewal(threadId);
    const botId = existingVmThreadIds.get(threadId);
    if (!botId) return;
    existingVmLease.release(threadId);
    if (existingVmActiveThreads.get(botId) === threadId) existingVmActiveThreads.delete(botId);
    existingVmThreadIds.delete(threadId);
    if (closeSessions) deps.closeExistingVmScreenshotSessions();
  }

  async function inventoryPayload() {
    const runtime = await deps.runtimeStatus();
    if (!runtime.runtime || !runtime.daemonUp) {
      return {
        instances: [],
        maxInstances: deps.maxInstances(),
        available: false,
        problem: runtime.runtime ? `Start ${runtime.runtime} first` : "Install a supported container runtime first",
      };
    }
    const existing = await discoverExistingPerBotLocalVms(deps.bots(), runtime.runtime);
    const statuses = await Promise.all(existing.map(({ target }) => deps.status(target)));
    const instances = existing.flatMap(({ bot, target }, index) => {
      const status = statuses[index];
      if (!status) return [];
      noteSeen(target, status);
      const inUse = activeThreads.has(target.key) || leaseFor(target).current(ownerBusy) !== null;
      const entry = localVmInventoryEntry(bot, updates.describe(target, status), inUse);
      return entry ? [entry] : [];
    });
    return { instances, maxInstances: deps.maxInstances(), available: true, problem: null };
  }

  async function payload(target: LocalVmTarget, auth: RequestAuth) {
    if (deps.source() === "existing") return deps.existingStatus();
    const status = updates.describe(target, await deps.status(target));
    return {
      ...localVmViewerStatus(status, auth),
      stop_reason: localVmStopReason(target.key, status),
      commands: setupCommands(status.runtime, deps.platform, target),
      idle_timeout_ms: localVmIdleMs(),
      mode: deps.mode(),
      max_instances: deps.maxInstances(),
    };
  }

  async function readyForTurn(botId: string, target: LocalVmTarget, isCurrent = () => true): Promise<ContainerComputerStatus> {
    lifecycleBusy.add(target.key);
    // Fence before the first await, so two concurrent turns cannot both pass the per-bot limit between count and create.
    const pooled = target.key.startsWith("pool:");
    const ownsProvision = !pooled && !provisionBusy;
    if (ownsProvision) provisionBusy = true;
    let status: ContainerComputerStatus;
    try {
      status = await deps.status(target);
      status = await startStoppedPodmanMachine(status, () => deps.status(target), () => deps.broadcastProvisioning(botId), { platform: deps.platform });
      noteSeen(target, status);
      if (!isCurrent()) return status;
      const action = localVmWakeAction(status);
      if (status.ready || !action || !status.runtime) return status;
      if (action === "run" && !pooled && !ownsProvision) return status;

      if (action === "run" && target.key.startsWith("bot:")) {
        const count = await existingPerBotCount(status.runtime);
        if (!isCurrent() || count >= deps.maxInstances()) return status;
      }

      deps.broadcastProvisioning(botId);
      try {
        status = await deps.act(action, target);
      } catch {
        // `run` can throw after the container exists, so arm the idle backstop anyway.
        idleFor(target).touch();
        return status;
      }
    } finally {
      if (ownsProvision) provisionBusy = false;
      lifecycleBusy.delete(target.key);
    }
    idleFor(target).touch();

    // The container is up before Cua Driver is: wait rather than fail the turn.
    const deadline = Date.now() + 90_000;
    while (isCurrent() && !status.ready && status.container === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (!isCurrent()) break;
      status = await deps.status(target);
    }
    return status;
  }

  async function existingPerBotCount(runtime: Runtime): Promise<number> {
    return (await discoverExistingPerBotLocalVms(deps.bots(), runtime)).length;
  }

  function perBotWorkspaceNames(): string[] | null {
    if (!existsSync(PER_BOT_VM_HOMES_DIR)) return [];
    try {
      const entries = readdirSync(PER_BOT_VM_HOMES_DIR, { withFileTypes: true });
      if (entries.some((entry) => !entry.isDirectory() || (!/^[0-9a-f]{16}$/.test(entry.name) && !/^pool-\d+$/.test(entry.name)))) return null;
      return entries.filter((entry) => /^[0-9a-f]{16}$/.test(entry.name)).map((entry) => entry.name);
    } catch {
      return null;
    }
  }

  async function perBotCountForModeChange(): Promise<number | null> {
    const bots = deps.bots();
    const targets = [...new Map(bots.map((bot) => {
      const target = perBotLocalVmTarget(bot.id);
      return [target.key, target] as const;
    })).values()];
    if (targets.length === 0) return 0;
    const runtime = await deps.runtimeStatus();
    if (!runtime.runtime || !runtime.daemonUp) {
      return targets.some((target) => existsSync(target.workspaceDir)) ? null : 0;
    }
    return (await discoverExistingPerBotLocalVms(bots, runtime.runtime)).length;
  }

  async function perBotCountForSourceChange(): Promise<number | null> {
    const workspaceNames = perBotWorkspaceNames();
    if (workspaceNames === null) return null;
    const runtime = await deps.runtimeStatus();
    if (!runtime.runtime || !runtime.daemonUp) return workspaceNames.length > 0 ? null : 0;
    const containerNames = await listManagedPerBotNames(runtime.runtime);
    if (containerNames === null) return null;
    const occupied = new Set(workspaceNames);
    for (const name of containerNames) occupied.add(name.slice(-16));
    return occupied.size;
  }

  return {
    localVmLeases: leases,
    localVmSeatPool: seats,
    existingVmLease,
    localVmUpdates: updates,
    localVmLifecycleBusy: setAccess(lifecycleBusy),
    localVmThreadTargets: mapAccess(threadTargets),
    localVmActiveThreads: mapAccess(activeThreads),
    localVmSeen: setAccess(seen),
    localVmIdles: mapAccess(idles),
    existingVmThreadIds: mapAccess(existingVmThreadIds),
    existingVmActiveThreads: mapAccess(existingVmActiveThreads),
    get imageBusy() { return imageBusy; },
    set imageBusy(value: boolean) { imageBusy = value; },
    get provisionBusy() { return provisionBusy; },
    set provisionBusy(value: boolean) { provisionBusy = value; },
    get modeChangeBusy() { return modeChangeBusy; },
    set modeChangeBusy(value: boolean) { modeChangeBusy = value; },
    localVmIdleMs,
    localVmTargetForBot: targetForBot,
    localVmPoolSeatHolder: poolSeatHolder,
    localVmTargetForThread: targetForThread,
    localVmTargetForStatus: targetForStatus,
    localVmLeaseFor: leaseFor,
    localVmIdleFor: idleFor,
    noteLocalVmSeen: noteSeen,
    waitForLocalVmUpdate: waitForUpdate,
    stopHumanWaitLeaseRenewal,
    renewHumanWaitLease,
    releaseLocalVmThread: releaseThread,
    releaseExistingVmThread,
    localVmInventoryPayload: inventoryPayload,
    localVmPayload: payload,
    readyLocalVmForTurn: readyForTurn,
    existingPerBotLocalVmCount: existingPerBotCount,
    perBotLocalVmWorkspaceNames: perBotWorkspaceNames,
    perBotLocalVmCountForModeChange: perBotCountForModeChange,
    perBotLocalVmCountForSourceChange: perBotCountForSourceChange,
    cancelIdle(targetKey: string): void {
      idles.get(targetKey)?.cancel();
      idles.delete(targetKey);
    },
    cancelAllIdles(): void {
      for (const idle of idles.values()) idle.cancel();
    },
  };
}
