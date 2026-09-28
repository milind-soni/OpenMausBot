// Transparent stdio bridge to the official Cua MCP server in a VPS
// container. Docker's SSH transport handles authentication through the
// user's normal SSH config and agent; this process stores no credentials.
// The piping, drain-safe exit, and dead-transport watchdog live in
// mcp-bridge.ts, shared with the Local VM entry point.
import { runMcpBridge } from "./mcp-bridge.ts";
import { vpsContainerMcpArgs, vpsDockerArgs } from "./vps-computer.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { prepareVpsSsh } from "./vps-ssh.ts";

const [alias, containerName] = process.argv.slice(2);
const sshAlias = alias ?? "";
let args: string[];
try {
  args = vpsContainerMcpArgs(sshAlias, containerName ?? "");
} catch {
  process.stderr.write("invalid VPS MCP connection\n");
  process.exit(2);
}

// The who-is-driving pair rides in env, not argv — argv is world-readable
// through `ps`, and the token guards a loopback endpoint.
const controlUrl = process.env.OMB_CONTROL_URL ?? "";
const controlToken = process.env.OMB_CONTROL_TOKEN ?? "";
const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());

runMcpBridge({
  command: "docker",
  args,
  // Keep tool calls and the watchdog on the same bounded, shared transport
  // as startup and previews; otherwise only the panel gets the SSH defaults.
  env: { ...process.env, PATH: ssh.path },
  label: "VPS Cua Driver",
  // The probe checks the TRANSPORT (SSH + daemon), deliberately not the
  // driver: a busy desktop mid-tool-call must never look dead, while an
  // unreachable VPS must, and `docker version` distinguishes exactly that.
  liveness: { command: "docker", args: vpsDockerArgs(sshAlias, ["version", "--format", "{{.Server.Version}}"]) },
  ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
});
