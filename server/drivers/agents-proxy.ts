// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes peer, routine, and
// skill tools routed back through the harness so the harness stays the
// single owner of turns, permissions, and recursion limits. The coordination
// tools are:
//
//   list_bots()                          → the other bots in this section + their status
//   list_rooms()                         → the shared rooms this bot may post into
//   post_to_room(group_id, message)      → put ONE message in a room; nobody's
//                                          turn starts, so nobody replies
//   ask_bot(bot_id, msg)                 → send msg to that bot, wait, return its reply
//   delegate_bot(bot_id, msg, reason?)   → hand the task to a peer ASYNC: returns
//                                          immediately, the peer runs after your
//                                          current turn finishes, the result is
//                                          delivered to the source conversation
//   start_thread(title, msg, bot_id?)    → open a real thread — on yourself for
//                                          separate work, or on a teammate as a
//                                          handoff that runs on its own
//   create_bot(name, role, instructions) → Chiefs can add a specialist to
//                                          their own section
//   create_room / manage_room            → Chiefs manage own-section rooms,
//                                          never move bots or sections
//   request_credential(id, reason?)       → show a secure, allowlisted key card
//   list_routines()                       → inspect this bot's scheduled work
//   propose_routine(...)                  → apply or request confirmation for a new routine
//   propose_routine_action(...)           → apply or request confirmation for a routine change
//   propose_profile(...)                  → apply or request confirmation for a profile change
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
//   OMB_EXTERNAL_RUNTIME  "1" for a standing process: peer tools and polling only
//
// This file is the stdio front end only. What the tools are and which a turn
// sees: agents-catalog.ts. What a call does: agents-call.ts. How the harness
// is reached: agents-client.ts. The harness spawns THIS file as its own
// process (server/proxy-paths.ts), and scripts/bundle-server.mjs inlines the
// other three into it, so a packaged build still ships one agents-proxy.js.
import readline from "node:readline";

import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { callTool, capResult, toolCallContextFromEnv } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const AVAILABLE_TOOLS = availableTools(catalogProfileFromEnv(process.env));
// One proxy process serves one turn, so its per-turn guards start here.
const CONTEXT = toolCallContextFromEnv(process.env);

const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opengrokbot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: AVAILABLE_TOOLS });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!AVAILABLE_TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError, passthrough } = await callTool(name, (params.arguments ?? {}) as Json, CONTEXT);
        if (passthrough) ok(id, passthrough);
        else textResult(id, name === "tool_result_read" ? text : await capResult(text, CONTEXT), isError);
      } catch (e) {
        textResult(id, await capResult((e as Error).message, CONTEXT), true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

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
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
