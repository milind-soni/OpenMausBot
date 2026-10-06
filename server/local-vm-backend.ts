// One Local VM surface over both backends. A target carries its backend:
// `target.space` means a Cua Space (cua-spaces-computer.ts), otherwise the
// managed container (container-computer.ts). The harness's leases, idle
// timers, wake rules and routes call these and never branch on the backend
// themselves, except where a backend genuinely has no equivalent.
import {
  autoLocalVmAttachable,
  containerComputerAction,
  containerComputerFrame,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  containerExec,
  localVmWakeAction,
  setupCommands,
  type ContainerComputerStatus,
  type ContainerExecResult,
  type LifecycleAction,
  type LocalVmMcpLaunch,
  type LocalVmTarget,
} from "./container-computer.ts";
import {
  cuaSpaceAction,
  cuaSpaceExec,
  cuaSpaceFrame,
  cuaSpaceMcp,
  cuaSpaceScreenshot,
  cuaSpaceStatus,
  cuaSpaceWakeAction,
  type CuaSpaceStatus,
} from "./cua-spaces-computer.ts";

export type LocalVmStatus = ContainerComputerStatus | CuaSpaceStatus;

export function localVmStatus(target: LocalVmTarget, options: { probeDesktop?: boolean } = {}): Promise<LocalVmStatus> {
  return target.space ? cuaSpaceStatus(target) : containerComputerStatus(undefined, undefined, target, options);
}

export function localVmAction(action: LifecycleAction, target: LocalVmTarget): Promise<LocalVmStatus> {
  return target.space ? cuaSpaceAction(action, target) : containerComputerAction(action, undefined, undefined, target);
}

export function localVmFrame(target: LocalVmTarget): Promise<{ png: string; format: "png" | "jpeg" }> {
  return target.space ? cuaSpaceFrame(target) : containerComputerFrame(undefined, undefined, target);
}

export function localVmScreenshot(target: LocalVmTarget): Promise<string> {
  return target.space ? cuaSpaceScreenshot(target) : containerComputerScreenshot(undefined, undefined, target);
}

/** What a turn may do on its own to bring this Local VM up, if anything. */
export function localVmWake(status: LocalVmStatus): "run" | "start" | null {
  return status.backend === "cua-spaces" ? cuaSpaceWakeAction(status) : localVmWakeAction(status);
}

/** Whether Auto may attach this Local VM without a person choosing it. */
export function localVmAutoAttachable(status: LocalVmStatus): boolean {
  return status.backend === "cua-spaces" ? status.ready || cuaSpaceWakeAction(status) !== null : autoLocalVmAttachable(status);
}

/** The computer MCP for a ready Local VM. */
export function localVmMcp(
  status: LocalVmStatus,
  control: { url: string; token: string },
  target: LocalVmTarget,
): LocalVmMcpLaunch {
  if (status.backend === "cua-spaces") return cuaSpaceMcp(target, control);
  if (!status.runtime) throw new Error(status.problem ?? "the Local VM is not ready");
  return containerComputerMcp(status.runtime, control, target);
}

export function localVmExec(
  target: LocalVmTarget,
  command: string,
  options: { timeoutSeconds?: number } = {},
): Promise<ContainerExecResult> {
  return target.space ? cuaSpaceExec(target, command, options) : containerExec(target, command, options);
}

/** Copy-paste setup for a container runtime; a Space has none to show. */
export function localVmSetupCommands(status: LocalVmStatus, target: LocalVmTarget) {
  return status.backend === "container" ? setupCommands(status.runtime, process.platform, target) : [];
}
