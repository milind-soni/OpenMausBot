// BYO Linux VPS computer. The agent process stays local; Docker's own SSH
// transport reaches the user's daemon and the official Cua MCP server stays
// inside one managed container per bot.
//
// Public import surface. The implementation lives in focused modules under
// ./vps/; every name the original single file exported is re-exported below,
// so existing "../vps-computer.ts" / "./vps-computer.ts" imports keep working
// unchanged.

// A re-export, not a copy: this file is loaded from the shared
// computer-backend cycle, and reading a container-computer binding during
// module init would deadlock on evaluation order. Bindings forward lazily.
export { IMAGE as VPS_IMAGE } from "./container-computer.ts";
export {
  VPS_CONTAINER_LABEL,
  VPS_CONTAINER_PREFIX,
  VPS_ENVIRONMENT_LABEL,
  VPS_MANAGED_LABEL,
  VPS_VIEWER_LABEL,
  defaultRunner,
  vpsComputerMcp,
  vpsContainerMcpArgs,
  vpsContainerName,
  vpsDockerArgs,
} from "./vps/cli.ts";
export type { VpsCommandOptions, VpsCommandRunner, VpsLifecycleAction } from "./vps/cli.ts";
export { vpsComputerStatus } from "./vps/status.ts";
export type { VpsComputerStatus } from "./vps/status.ts";
export { listManagedVpsComputers } from "./vps/inventory.ts";
export type { ManagedVpsInventory, ManagedVpsInventoryInstance, ManagedVpsOwner } from "./vps/inventory.ts";
export { closeAllVpsDesktopTunnels, closeVpsDesktopTunnel, vpsComputerJoin, vpsSshTunnelArgs } from "./vps/tunnels.ts";
export {
  inspectVpsForAuto,
  removeManagedVpsComputer,
  reuseVps,
  vpsComputerAction,
  vpsComputerBackend,
  vpsComputerScreenshot,
  vpsContainerRunArgs,
  vpsDriverError,
  vpsLifecycleBusy,
  vpsStartsForTurn,
} from "./vps/lifecycle.ts";
