// The Local VM turn-prep helpers — extracted verbatim from index.ts: the
// payload view a settings or turn caller polls, readyLocalVmForTurn's
// recreate-if-the-idle-timer-removed-it readiness walk, and the per-bot
// instance counts the lifecycle routes and mode changes read. index.ts
// wires createLocalVmTurnPrep just before createGroupTurn, the earliest
// module-level by-value consumer of readyLocalVmForTurn; broadcast and
// the mutable localVmProvisionBusy flag arrive as thunks over consts
// index.ts declares after that site, and the lifecycle values come from
// the createComputerLifecycle destructure above it.
import { existsSync } from "node:fs";
import {
  containerComputerAction,
  containerComputerStatus,
  containerRuntimeStatus,
  localVmRecreatableOnDemand,
  perBotLocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
  setupCommands,
  type ContainerComputerStatus,
  type LocalVmTarget,
  type Runtime,
} from "./container-computer.ts";
import { localVmMaxInstances, localVmMode } from "./config.ts";
import type { LocalVmIdleTimer } from "./local-vm-idle.ts";
import { discoverExistingPerBotLocalVms } from "./local-vm-inventory.ts";
import { cfg, store } from "./runtime.ts";

/** Everything the Local VM turn-prep helpers read from their host. The
 * lateBound family holds thunks for the consts index.ts binds after the
 * wiring site (broadcast comes from the events routes below it;
 * localVmProvisionBusy is a let the routes and the maintenance idle gate
 * also read and write); the lifecycle family is values from the
 * createComputerLifecycle destructure above the wiring site. */
export interface LocalVmTurnPrepDeps {
  lateBound: {
    broadcast(payload: Record<string, unknown>): void;
    localVmProvisionBusy(): boolean;
    setLocalVmProvisionBusy(value: boolean): void;
  };
  lifecycle: {
    localVmLifecycleBusy: Set<string>;
    LOCAL_VM_IDLE_MS: number;
    LOCAL_VM_DESKTOP_WAIT_MS: number;
    localVmIdleFor(target: LocalVmTarget): LocalVmIdleTimer;
    noteLocalVmSeen(target: LocalVmTarget, status: ContainerComputerStatus | null | undefined): void;
  };
}

export function createLocalVmTurnPrep(deps: LocalVmTurnPrepDeps) {
  const { broadcast, localVmProvisionBusy, setLocalVmProvisionBusy } = deps.lateBound;
  const {
    localVmLifecycleBusy, LOCAL_VM_IDLE_MS, LOCAL_VM_DESKTOP_WAIT_MS, localVmIdleFor, noteLocalVmSeen,
  } = deps.lifecycle;

  async function localVmPayload(target: LocalVmTarget) {
    const status = await containerComputerStatus(undefined, undefined, target);
    return {
      ...status,
      commands: setupCommands(status.runtime, process.platform, target),
      idle_timeout_ms: LOCAL_VM_IDLE_MS,
      mode: localVmMode(cfg),
      max_instances: localVmMaxInstances(cfg),
    };
  }

  /** The Local VM a turn is about to use, recreated if the idle timer took it.
   *
   * `LocalVmIdleTimer` REMOVES an unused Local VM rather than pausing it. The
   * turn then failed with "Create the Local VM (App Settings → Local VM)" —
   * which reads like a fault the person must repair by hand, for a container the
   * app itself deleted eight hours earlier. Someone who steps away overnight
   * comes back to an error on their first message.
   *
   * The cloud branch below already does the opposite: an absent box is
   * provisioned on first use behind a `provisioning` broadcast. This gives the
   * Local VM the same lifecycle for the same reason.
   *
   * Only `missing` is recovered, and only when a fresh `run` is all it takes.
   * Every other problem still surfaces: no runtime installed, no image pulled,
   * `create_supported` false, or an existing container that is stale, unmanaged
   * or unsafe. Those need a decision — install podman, download 1.4 GB, replace
   * a container someone else made — and a stopped container is deliberately not
   * resumed here, because `localVmProblem` says this desktop image cannot safely
   * resume and asks for a recreate rather than a start. Per-bot mode keeps its
   * instance cap; creating past it would quietly do what the lifecycle route
   * refuses.
   */
  async function readyLocalVmForTurn(botId: string, target: LocalVmTarget, isCurrent = () => true) {
    localVmLifecycleBusy.add(target.key);
    // Fence this target, and the cross-target capacity decision for creates,
    // before the first await — the same synchronous-fence-then-count shape
    // the panel route uses — so two concurrent turns cannot both pass the
    // per-bot limit between count and create.
    const ownsProvision = localVmProvisionBusy();
    if (ownsProvision) setLocalVmProvisionBusy(true);
    let status: ContainerComputerStatus;
    try {
      status = await containerComputerStatus(undefined, undefined, target);
      noteLocalVmSeen(target, status);
      if (!isCurrent()) return status;
      if (status.ready || !localVmRecreatableOnDemand(status)) return status;
      // Another creation is already mid-flight and its container is not yet
      // visible to a count, so the safe answer is the inspected status —
      // exactly what the over-cap path below returns.
      if (!ownsProvision) return status;

      if (target.key !== SHARED_LOCAL_VM_TARGET.key) {
        const count = await existingPerBotLocalVmCount(status.runtime);
        if (!isCurrent() || count >= localVmMaxInstances(cfg)) return status;
      }

      broadcast({ kind: "computer", botId, state: "provisioning" });
      try {
        status = await containerComputerAction("run", undefined, undefined, target);
      } catch {
        // Keep the inspected status: its `problem` names the real obstacle,
        // which is more use to the person than "podman run exited non-zero".
        // `run` can throw after the container exists, so arm the idle
        // backstop anyway — expiry defers while the target is busy and its
        // remove step no-ops unless a fresh probe sees a running container.
        // The problem text stays as inspected: cheaply telling a half-created
        // container from none here would need another container probe.
        localVmIdleFor(target).touch();
        return status;
      }
    } finally {
      if (ownsProvision) setLocalVmProvisionBusy(false);
      localVmLifecycleBusy.delete(target.key);
    }
    localVmIdleFor(target).touch();

    // The container is up before Cua Driver is. Waiting here rather than failing
    // the turn is the whole point: a person who has been away eight hours should
    // not have to send their message twice.
    const deadline = Date.now() + LOCAL_VM_DESKTOP_WAIT_MS;
    while (isCurrent() && !status.ready && status.container === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (!isCurrent()) break;
      status = await containerComputerStatus(undefined, undefined, target);
    }
    return status;
  }

  async function existingPerBotLocalVmCount(runtime: Runtime) {
    return (await discoverExistingPerBotLocalVms(store.bots, runtime)).length;
  }

  async function perBotLocalVmCountForModeChange(): Promise<number | null> {
    const targets = [...new Map(store.bots.map((bot) => {
      const target = perBotLocalVmTarget(bot.id);
      return [target.key, target] as const;
    })).values()];
    if (targets.length === 0) return 0;
    const runtime = await containerRuntimeStatus();
    if (!runtime.runtime || !runtime.daemonUp) {
      return targets.some((target) => existsSync(target.workspaceDir)) ? null : 0;
    }
    return existingPerBotLocalVmCount(runtime.runtime);
  }

  return { localVmPayload, readyLocalVmForTurn, existingPerBotLocalVmCount, perBotLocalVmCountForModeChange };
}
