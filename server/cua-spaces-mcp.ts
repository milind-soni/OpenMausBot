// Transparent stdio bridge into `cua mcp` for one Cua Space. Cua defines the
// computer tools and reaches the Space's cua-spacesd; this process parses no
// MCP messages. Piping, ping, schema normalization and the take-control gate
// live in mcp-bridge.ts, shared with the container and VPS entry points.
import { isAbsolute } from "node:path";

import { runMcpBridge } from "./mcp-bridge.ts";

const [cli, space] = process.argv.slice(2);
if (!cli || !isAbsolute(cli)) {
  process.stderr.write("invalid cua command\n");
  process.exit(2);
}
if (!space || !/^local:[a-zA-Z0-9_.-]+$/.test(space)) {
  process.stderr.write("invalid Cua Space\n");
  process.exit(2);
}

// The who-is-driving pair rides in env, not argv — argv is world-readable
// through `ps`, and the token guards a loopback endpoint.
const controlUrl = process.env.OMB_CONTROL_URL ?? "";
const controlToken = process.env.OMB_CONTROL_TOKEN ?? "";

runMcpBridge({
  command: cli,
  // computer:all is the computer and file tools only; Space lifecycle,
  // other Spaces and skills stay out of reach. Unknown permissions fail closed.
  args: ["mcp", "--sandbox", space, "--permissions", "computer:all"],
  label: "Cua Spaces",
  // No liveness watchdog: `cua mcp` talks to a local daemon over a socket and
  // fails fast on its own — there is no silent WAN peer to wedge on.
  ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
});
