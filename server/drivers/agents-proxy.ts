// The "agents" MCP server inside a bot's agent process: stdio JSON-RPC 2.0 (no MCP SDK), every tool
// routed through the harness. Env, set by the harness:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID  the calling bot's id
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH  this turn's comms depth (the harness refuses recursion)
//   OMB_EXTERNAL_RUNTIME  "1" for a standing process: oversized results are cut instead of cached
//   OMB_CHIEF_OF_STAFF  "1" for a Chief of Staff, the only bot shown the Chief-only tools
// scripts/bundle-server.mjs inlines agents-catalog/-call/-client into this file, which the harness spawns.
import readline from "node:readline";

import { withFixHint } from "../tool-hints.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { callTool, capResult, toolCallContextFromEnv } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const AVAILABLE_TOOLS = availableTools(catalogProfileFromEnv(process.env));
const CONTEXT = toolCallContextFromEnv(process.env);

const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
// The fix hint goes on after capping, so the cut never drops it.
const textResult = (id: unknown, name: string, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text: isError ? withFixHint({ tool: name, text, origin: "harness" }) : text }], isError });

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
        serverInfo: { name: "openmausbot-agents", version: "0.1.0" },
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
        else textResult(id, name, name === "tool_result_read" ? text : await capResult(text, CONTEXT), isError);
      } catch (e) {
        textResult(id, name, await capResult((e as Error).message, CONTEXT), true);
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
