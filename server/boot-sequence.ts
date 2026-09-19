// The local-VM boot arming, extracted from index.ts with the body
// unchanged: a running VM may have survived an app/server restart, so its
// idle backstop starts even if nobody opens Settings or begins a turn this
// session. index.ts wires armExistingLocalVms at the backstop's original
// site; the inventory and lease helpers it shares with the Settings
// inventory cross as deps.
import {
  containerComputerStatus,
  containerRuntimeStatus,
  SHARED_LOCAL_VM_TARGET,
  type ContainerComputerStatus,
  type LocalVmTarget,
} from "./container-computer.ts";
import { loadConfig, localVmMode } from "./config.ts";
import { discoverExistingPerBotLocalVms, shouldArmLocalVmIdle } from "./local-vm-inventory.ts";
import type { LocalVmIdleTimer } from "./local-vm-idle.ts";
import type { Store } from "./store.ts";

/** Everything the backstop reads from its host. cfg and store are the
 * index.ts consts; noteLocalVmSeen and localVmIdleFor are the inventory
 * and lease helpers index.ts binds above the wiring site. */
export interface ArmExistingLocalVmsDeps {
  cfg: ReturnType<typeof loadConfig>;
  store: Store;
  noteLocalVmSeen(target: LocalVmTarget, status: ContainerComputerStatus | null | undefined): void;
  localVmIdleFor(target: LocalVmTarget): LocalVmIdleTimer;
}

export function armExistingLocalVms(deps: ArmExistingLocalVmsDeps): void {
  const { cfg, store, noteLocalVmSeen, localVmIdleFor } = deps;
  // A running VM may have survived an app/server restart. Start its idle
  // backstop even if nobody opens Settings or begins a turn this session. The
  // bot's current destination is intentionally ignored: moving a bot to Cloud,
  // Browser, This computer, Auto, or Off does not delete its old Local VM.
  void (async () => {
    if (localVmMode(cfg) !== "per-bot") {
      const status = await containerComputerStatus(undefined, undefined, SHARED_LOCAL_VM_TARGET).catch(() => null);
      noteLocalVmSeen(SHARED_LOCAL_VM_TARGET, status);
      if (shouldArmLocalVmIdle(status)) localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
      return;
    }
    const runtime = await containerRuntimeStatus().catch(() => null);
    if (!runtime?.runtime || !runtime.daemonUp) return;
    const existing = await discoverExistingPerBotLocalVms(store.bots, runtime.runtime).catch(() => []);
    const statuses = await Promise.all(existing.map(({ target }) =>
      containerComputerStatus(undefined, undefined, target).catch(() => null),
    ));
    existing.forEach(({ target }, index) => {
      noteLocalVmSeen(target, statuses[index]);
      if (shouldArmLocalVmIdle(statuses[index])) localVmIdleFor(target).touch();
    });
  })().catch(() => {
    // Startup inspection is a backstop, not a reason to keep the app offline.
    // The Settings inventory remains available for a later explicit retry.
  });
}
