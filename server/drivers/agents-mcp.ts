// The "agents" MCP server's answers (JSON-RPC 2.0, no MCP SDK), every tool routed through the harness. `env` is what the
// harness sets for it (see agents-proxy.ts): the stdio proxy an engine starts and the HTTP endpoint an engine reaches
// both answer through it.
import { TOOL_BRIDGE_ENV, createToolBridge } from "./agents-bridge.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { callTool, capResult, toolCallContextFromEnv } from "./agents-call.ts";
import { sendToolReceipt } from "./agents-timing.ts";
import type { Json } from "./agents-client.ts";

export function agentsMcp(env: NodeJS.ProcessEnv): (msg: Json) => Promise<Json | undefined> {
  const available = availableTools(catalogProfileFromEnv(env));
  const bridge = env[TOOL_BRIDGE_ENV] === "1" ? createToolBridge(available) : undefined;
  const context = toolCallContextFromEnv(env);
  const ok = (id: unknown, result: unknown): Json => ({ jsonrpc: "2.0", id, result } as Json);
  const rpcErr = (id: unknown, code: number, message: string): Json => ({ jsonrpc: "2.0", id, error: { code, message } } as Json);
  const textResult = (id: unknown, text: string, isError = false) => ok(id, { content: [{ type: "text", text }], isError });
  return async (msg) => {
    const id = msg.id;
    const method = msg.method as string | undefined;
    if (!method) return undefined;
    const params = (msg.params ?? {}) as Json;
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "openmausbot-agents", version: "0.1.0" },
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: bridge ? bridge.listed : available });
      case "tools/call": {
        const called = { name: params.name as string, arguments: (params.arguments ?? {}) as Json };
        // Security: past the bridge a use_tool call is a direct call: same unknown-tool check, callTool and result bounds.
        const bridged = bridge ? await bridge.route(called.name, called.arguments) : undefined;
        if (bridged && "answer" in bridged) return textResult(id, bridged.answer.text, bridged.answer.isError);
        const { name, arguments: args } = bridged ?? called;
        if (!available.some((t) => t.name === name)) {
          // A name written into use_tool fails the call, not the protocol: the chat runtime ends a turn on a protocol error.
          const unknown = `Unknown tool: ${name}`;
          return bridged ? textResult(id, unknown, true) : rpcErr(id, -32602, unknown);
        }
        const startedAt = Date.now();
        try {
          const { text, isError, passthrough } = await callTool(name, args, context);
          sendToolReceipt(context, name, args, startedAt, { ok: !isError, error: text });
          if (passthrough) return ok(id, passthrough);
          return textResult(id, name === "tool_result_read" ? text : await capResult(text, context), isError);
        } catch (e) {
          sendToolReceipt(context, name, args, startedAt, { ok: false, error: (e as Error).message });
          return textResult(id, await capResult((e as Error).message, context), true);
        }
      }
      default:
        return id !== undefined ? rpcErr(id, -32601, `Method not found: ${method}`) : undefined;
    }
  };
}
