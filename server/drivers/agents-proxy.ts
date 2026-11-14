// The "agents" MCP server inside a bot's agent process: stdio JSON-RPC 2.0 (no MCP SDK), every tool
// routed through the harness. Env, set by the harness:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID  the calling bot's id
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH  this turn's comms depth (the harness refuses recursion)
//   OMB_EXTERNAL_RUNTIME  "1" for a standing process: oversized results are cut instead of cached
//   OMB_CHIEF_OF_STAFF  "1" for a Chief of Staff, the only bot shown the Chief-only tools
//   OMB_MAUSBOT  "1" for the person's MausBot, the only bot shown its notification tools
//   OMB_AGENTS_TOOL_BRIDGE  "1" lists a few tools and puts the rest behind find_tool and use_tool
// scripts/bundle-server.mjs inlines agents-mcp and agents-catalog/-call/-client/-bridge into this file, which the harness spawns.
import readline from "node:readline";

import { agentsMcp } from "./agents-mcp.ts";
import type { Json } from "./agents-client.ts";

const handle = agentsMcp(process.env);
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).then((reply) => { if (reply) send(reply); }, (e) => {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (e as Error).message } } as Json);
  });
});
rl.on("close", () => process.exit(0));
