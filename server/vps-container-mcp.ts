// Stdio bridge to the Cua MCP server in a VPS container; auth is the user's SSH config and agent, and nothing is stored here.
import { runMcpBridge } from "./mcp-bridge.ts";
import { localDockerSocket, vpsContainerMcpArgs, vpsDockerArgs } from "./vps-computer.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { ensureVpsSshMaster, prepareVpsSsh } from "./vps-ssh.ts";

const [alias, containerName] = process.argv.slice(2);
const sshAlias = alias ?? "";
let args: string[];
try {
  args = vpsContainerMcpArgs(sshAlias, containerName ?? "");
} catch {
  process.stderr.write("invalid VPS MCP connection\n");
  process.exit(2);
}

// The driving pair rides in env, not argv: argv is world-readable through `ps`.
const controlUrl = process.env.OMB_CONTROL_URL ?? "";
const controlToken = process.env.OMB_CONTROL_TOKEN ?? "";
// A socket transport reaches the daemon directly; SSH would only add a way to fail
// before the computer tools start when the alias is unreachable from this machine.
const ssh = localDockerSocket() ? null : prepareVpsSsh(DATA_DIR, augmentedPath());

if (ssh) {
  try { await ensureVpsSshMaster(ssh, sshAlias); }
  catch (error) {
    process.stderr.write(`VPS SSH initialization failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

runMcpBridge({
  command: "docker",
  args,
  ...(ssh ? { env: { ...process.env, PATH: ssh.path } } : {}), // socket mode: the bridge default PATH already resolves docker
  label: "VPS Cua Driver",
  // Probe the transport, not the driver: a busy desktop mid-tool-call must never look dead.
  liveness: { command: "docker", args: vpsDockerArgs(sshAlias, ["version", "--format", "{{.Server.Version}}"]) },
  ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
});
