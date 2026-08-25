// Transparent stdio bridge to the official Cua MCP server in a user-managed
// Linux VM. The SSH command is fixed and the alias is the only user value.
import {
  controlGateFromEnv,
  IncompleteControlConfigError,
  runMcpBridge,
  type BridgeOptions,
} from "./mcp-bridge.ts";
import { existingVmLivenessArgs, existingVmMcpArgs } from "./existing-vm.ts";

const [alias] = process.argv.slice(2);
try {
  const args = existingVmMcpArgs(alias ?? "");
  const liveness = existingVmLivenessArgs(alias ?? "");
  const gate = controlGateFromEnv("Existing VM");
  const options: BridgeOptions = {
    command: "ssh",
    args,
    label: "Existing VM Cua Driver",
    // Probe SSH itself, not the desktop. A slow or busy CUA call is traffic
    // on this bridge; only a dead SSH peer should terminate the transport.
    liveness: { command: "ssh", args: liveness },
    gate,
  };

  runMcpBridge(options);
} catch (error) {
  if (error instanceof IncompleteControlConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write("invalid Existing VM SSH connection\n");
  process.exit(2);
}
