// Transparent stdio bridge into Cua Driver's official MCP server inside the
// Local VM. This process defines no tools and parses no MCP messages; the
// piping, drain-safe exit, and watchdog live in mcp-bridge.ts, shared with
// the VPS entry point.
import { cuaExecArgs } from "./container-computer.ts";
import { controlGateFromEnv, runMcpBridge } from "./mcp-bridge.ts";

const [runtime, container, socket] = process.argv.slice(2);
if (!runtime || !["docker", "podman", "container"].includes(runtime)) {
  process.stderr.write("invalid Local VM runtime\n");
  process.exit(2);
}
if (!container || !/^[a-zA-Z0-9_.-]+$/.test(container) || !socket?.startsWith("/run/user/1000/")) {
  process.stderr.write("invalid Local VM connection\n");
  process.exit(2);
}

let gate: ReturnType<typeof controlGateFromEnv>;
try {
  // The who-is-driving pair rides in env, not argv — argv is world-readable
  // through `ps`, and the token guards a loopback endpoint.
  gate = controlGateFromEnv("Local VM");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "incomplete Local VM control configuration"}\n`);
  process.exit(2);
}

runMcpBridge({
  command: runtime,
  args: cuaExecArgs(["mcp", "--socket", socket], { container, interactive: true }),
  label: "Cua Driver",
  // No liveness watchdog: the runtime CLI talks to a local daemon and fails
  // fast on its own — there is no silent WAN peer to wedge on.
  gate,
});
