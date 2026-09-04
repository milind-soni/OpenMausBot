// The MCP servers a bot may use, mounted as tools the owned loop can call.
//
// One client per integration server, over the official stdio transport.
// Tools are namespaced by the server that owns them (`notes__read_notes`)
// so two servers exposing the same name cannot collide or shadow each
// other, and a reverse map routes each namespaced call back to exactly the
// server and tool it came from.
//
// What the MODEL sees from a call is bounded here; what the TRANSCRIPT
// keeps is the far smaller ToolContextSnapshot, sanitized once at the
// runtime seam. Those are deliberately different limits.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { OwnedTool, OwnedToolSchema } from "./contracts.ts";

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The model may read this much of a tool result. Larger than the durable
 * snapshot's cap on purpose: a file listing is useful to reason over in
 * full once, and useless to keep forever. */
export const MODEL_VISIBLE_RESULT_LIMIT = 24_000;
/** A server that has not finished its handshake in this long is treated as
 * broken, not slow: the turn must not hang on a child that never speaks. */
export const MCP_STARTUP_TIMEOUT_MS = 20_000;

export interface MountedMcp {
  tools: OwnedTool[];
  /** namespaced tool name → { server, tool }. */
  routes: ReadonlyMap<string, { server: string; tool: string }>;
  /** servers that failed to start, with why. Never a thrown error: one
   * broken server must not take the others — or the turn — down. */
  failures: ReadonlyMap<string, string>;
  /** stop every child. Idempotent; safe on turn settle, cancel, and dispose. */
  close(): Promise<void>;
}

const namespaced = (server: string, tool: string) => `${server}__${tool}`;

/** A JSON-Schema object the model can be constrained by. MCP servers may
 * omit properties or send something odd; an empty object schema is the
 * honest fallback rather than a guess. */
function toolSchema(raw: unknown): OwnedToolSchema {
  const schema = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const properties = schema.properties && typeof schema.properties === "object"
    ? (schema.properties as Record<string, Record<string, unknown>>)
    : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : undefined;
  return { type: "object", properties, ...(required?.length ? { required } : {}), additionalProperties: false };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** Start every server, discover its tools, and hand back one flat tool list.
 * Servers start concurrently; a failure in one is recorded and the rest
 * proceed. */
export async function mountMcpServers(
  servers: Record<string, McpServerSpec>,
  options: { toolTimeoutMs: number; startupTimeoutMs?: number } ,
): Promise<MountedMcp> {
  const clients = new Map<string, Client>();
  const transports = new Map<string, StdioClientTransport>();
  const routes = new Map<string, { server: string; tool: string }>();
  const failures = new Map<string, string>();
  const tools: OwnedTool[] = [];
  const startupTimeoutMs = options.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS;

  await Promise.all(
    Object.entries(servers).map(async ([name, spec]) => {
      const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, stderr: "ignore" });
      const client = new Client({ name: "openmausbot", version: "1" });
      try {
        await client.connect(transport, { timeout: startupTimeoutMs });
        const listed = await client.listTools(undefined, { timeout: startupTimeoutMs });
        clients.set(name, client);
        transports.set(name, transport);
        for (const tool of listed.tools) {
          const fullName = namespaced(name, tool.name);
          routes.set(fullName, { server: name, tool: tool.name });
          tools.push({
            name: fullName,
            description: tool.description ?? `${tool.name} from ${name}`,
            parameters: toolSchema(tool.inputSchema),
            async execute(_callId, args, signal) {
              const result = await client.callTool(
                { name: tool.name, arguments: args },
                undefined,
                { signal, timeout: options.toolTimeoutMs },
              );
              const text = textOf(result.content);
              const ok = result.isError !== true;
              const visible = text.length > MODEL_VISIBLE_RESULT_LIMIT
                ? `${text.slice(0, MODEL_VISIBLE_RESULT_LIMIT)}\n[truncated]`
                : text;
              // the runtime sanitizes and bounds the durable observation;
              // this only reports the raw facts of the call
              return {
                text: visible || (ok ? "(no output)" : "(tool reported an error with no message)"),
                ok,
                observation: { name: fullName, ok },
              };
            },
          });
        }
      } catch (error) {
        failures.set(name, error instanceof Error ? error.message : String(error));
        await transport.close().catch(() => {});
      }
    }),
  );

  let closed = false;
  return {
    tools,
    routes,
    failures,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...clients.values()].map((client) => client.close().catch(() => {})));
      await Promise.all([...transports.values()].map((transport) => transport.close().catch(() => {})));
    },
  };
}
