import type { createMcpDoor } from "./device-mcp.mjs";
import type { createComputerSharing } from "./computer-sharing.mjs";

type DoorOptions = Omit<Parameters<typeof createMcpDoor>[0], "approvals" | "ownPorts" | "definition">;
export declare function lentMcpOptions(options: DoorOptions & {
  sharing: () => Pick<ReturnType<typeof createComputerSharing>, "mcpApprovals">;
  serverPorts: () => number[];
}): Pick<Parameters<typeof createComputerSharing>[0], "mcp">;
