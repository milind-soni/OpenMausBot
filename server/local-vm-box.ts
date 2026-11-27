// Local VM computer MCP needs the host Docker socket. The bot box does not expose it
// (mounting docker.sock would be root-equivalent), so refuse the mount early with a clear
// message instead of letting the MCP exit as "MCP server exited".
import { botBox } from "./bot-box/box.ts";
import {
  containerComputerMcp as mountContainerComputerMcp,
  type LocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
} from "./container-computer.ts";

export const LOCAL_VM_IN_BOX_MESSAGE =
  "The Local VM needs the Docker socket, which the bot box does not expose";

export function localVmInBoxMessage(boxEnabled: boolean): string | undefined {
  return boxEnabled ? LOCAL_VM_IN_BOX_MESSAGE : undefined;
}

type Runtime = Parameters<typeof mountContainerComputerMcp>[0];

/** Drop-in for containerComputerMcp that refuses when the bot box is on. */
export function containerComputerMcp(
  runtime: Runtime,
  control?: { url: string; token: string },
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): ReturnType<typeof mountContainerComputerMcp> {
  const boxed = localVmInBoxMessage(botBox.enabled());
  if (boxed) throw Object.assign(new Error(boxed), { status: 409, code: "bot_box" });
  return mountContainerComputerMcp(runtime, control, target);
}
