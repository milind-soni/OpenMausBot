// Cua-backed Local VM lifecycle and health checks.
//
// OpenMausBot owns only the sandbox boundary: image preparation, container
// lifecycle, resource limits, loopback viewer, and target-scoped lease in the
// harness. Desktop automation itself is Cua Driver. Agents connect directly to
// `cua-driver mcp` inside the container; this module never reimplements clicks,
// typing, screenshots, accessibility, or window discovery.

// Public import surface. The implementation lives in focused modules under
// ./container/; every name the original single file exported is re-exported
// below, so existing "./container-computer.ts" imports keep working
// unchanged.
export {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  BASE_IMAGE_REPOSITORY,
  CONTAINER,
  CUA_DRIVER_VERSION,
  CUA_EXECUTABLE,
  CUA_SOCKET,
  DISPLAY,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  IMAGE_REPOSITORY,
  MANAGED_LABEL,
  SHARED_LOCAL_VM_TARGET,
  TARGET_LABEL,
  VM_WORKSPACE_DIR,
  VM_WORKSPACE_GUEST,
  WORKSPACE_LABEL,
  managedImageDockerfile,
  perBotLocalVmTarget,
} from "./container/image.ts";
export type { LocalVmTarget } from "./container/image.ts";
export { containerRuntimeStatus } from "./container/runtime.ts";
export type {
  CommandRunner,
  ContainerRuntimeStatus,
  LifecycleAction,
  Runtime,
} from "./container/runtime.ts";
export {
  autoLocalVmAttachable,
  cuaExecArgs,
  containerComputerStatus,
  imageLabelsMatch,
  localVmRecreatableOnDemand,
  wholeScreenshot,
} from "./container/status.ts";
export type { ContainerComputerStatus, ScreenshotCheck } from "./container/status.ts";
export {
  containerRunArgs,
  dockerSecurityIsHardened,
  podmanSecurityIsHardened,
} from "./container/hardening.ts";
export type { DockerHardeningConfig } from "./container/hardening.ts";
export {
  containerComputerAction,
  containerComputerExists,
} from "./container/lifecycle.ts";
export {
  containerComputerBackend,
  containerComputerFrame,
  containerComputerMcp,
  containerComputerScreenshot,
  setupCommands,
} from "./container/frame.ts";
