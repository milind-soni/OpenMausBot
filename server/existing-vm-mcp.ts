// Transparent stdio bridge to the official Cua MCP server in a user-managed
// Linux VM. The SSH command is fixed and the alias is the only user value.
import {
  runMcpBridge,
  type BridgeOptions,
} from "./mcp-bridge.ts";
import { existingVmLivenessArgs, existingVmMcpArgs } from "./existing-vm.ts";

const [alias] = process.argv.slice(2);
// The who-is-driving pair rides in env, not argv — argv is world-readable
// through `ps`, and the token guards a loopback endpoint.
const controlUrl = process.env.OMB_CONTROL_URL ?? "";
const controlToken = process.env.OMB_CONTROL_TOKEN ?? "";
try {
  const args = existingVmMcpArgs(alias ?? "");
  const liveness = existingVmLivenessArgs(alias ?? "");
  const options: BridgeOptions = {
    command: "ssh",
    args,
    label: "Existing VM Cua Driver",
    // Probe SSH itself, not the desktop. A slow or busy CUA call is traffic
    // on this bridge; only a dead SSH peer should terminate the transport.
    liveness: { command: "ssh", args: liveness },
    ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
  };

  runMcpBridge(options);
} catch {
  process.stderr.write("invalid Existing VM SSH connection\n");
  process.exit(2);
}
