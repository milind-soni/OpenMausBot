// The worker-only MCP surface. It deliberately does not share the transparent
// CUA bridge used by Local VM, VPS, Codex, Claude, OpenCode, or Hermes. A
// parked worker advertises no native CUA tools and CUA fixes its tool list for
// the daemon/proxy lifetime, so this stable six-tool surface performs approved
// one-shot calls through the control plane instead.
import { CONTROL_REFUSAL_PLAIN, type ControlClient } from "./control-client.ts";
import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";
import type { WorkerTaskClient, WorkerTaskOp } from "./worker-task-client.ts";

export const WORKER_MCP_TOOLS = [
  {
    name: "worker_task_propose",
    description:
      "Propose version-1 task intent and ask the person to approve the resulting exact manifest. The JSON object " +
      "must contain taskId, files, commands, origins and resultPaths; it may contain surface and lifetimeMs. " +
      "OpenMausBot binds the assigned worker, platform, conversation, SSH routing, application targets, policy, " +
      "timestamps and idle timeout inside the trusted control plane. Nothing is staged or activated before approval.",
    inputSchema: {
      type: "object",
      properties: {
        manifestJson: {
          type: "string",
          description: "Version-1 task-intent JSON; do not include worker identity, routing, policy, or timestamps.",
        },
      },
      required: ["manifestJson"],
    },
  },
  {
    name: "worker_task_status",
    description: "Report the task approved for this worker and conversation, including its remaining lifetime.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "worker_task_run",
    description:
      "Run one non-GUI command selected by id from the approved manifest. This call cannot supply an executable or argv.",
    inputSchema: {
      type: "object",
      properties: { commandId: { type: "string", description: "A command id from the approved manifest." } },
      required: ["commandId"],
    },
  },
  {
    name: "worker_task_results",
    description: "Read only result artefacts whose paths were declared in the approved manifest.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "worker_computer_describe",
    description:
      "Describe one CUA computer tool admitted by the approved task surface. Use this before calling an unfamiliar tool.",
    inputSchema: {
      type: "object",
      properties: { tool: { type: "string", description: "Exact CUA tool name." } },
      required: ["tool"],
    },
  },
  {
    name: "worker_computer_call",
    description:
      "Call one CUA tool admitted by the approved task. Arguments are JSON text and travel over stdin, never SSH argv. " +
      "The active native capability independently enforces tools, apps, origins, task root, expiry, and idle timeout.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Exact CUA tool name." },
        argumentsJson: { type: "string", description: "A JSON object matching worker_computer_describe." },
      },
      required: ["tool", "argumentsJson"],
    },
  },
] as const;

type McpFrame = Record<string, any>;

function errorResult(id: unknown, text: string): McpFrame {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: { content: [{ type: "text", text }], isError: true },
  };
}

function plainObject(value: JsonValue): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringArg(args: JsonObject, name: string, max: number): string | null {
  const value = args[name];
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function taskCall(name: string, args: JsonObject): { op: WorkerTaskOp; payload: JsonObject } | string {
  if (name === "worker_task_status") return { op: "status", payload: {} };
  if (name === "worker_task_results") return { op: "results", payload: {} };
  if (name === "worker_task_run") {
    const commandId = stringArg(args, "commandId", 128);
    return commandId ? { op: "run", payload: { commandId } } : "commandId must be a non-empty string";
  }
  if (name === "worker_task_propose") {
    const document = stringArg(args, "manifestJson", 1024 * 1024);
    if (!document) return "manifestJson must be a non-empty JSON string";
    try {
      const manifest = plainObject(parseJson(document));
      return manifest ? { op: "propose", payload: { manifest } } : "manifestJson must contain a JSON object";
    } catch {
      return "manifestJson is not valid JSON";
    }
  }
  if (name === "worker_computer_describe") {
    const tool = stringArg(args, "tool", 128);
    return tool ? { op: "describe", payload: { tool } } : "tool must be a non-empty string";
  }
  if (name === "worker_computer_call") {
    const tool = stringArg(args, "tool", 128);
    const document = stringArg(args, "argumentsJson", 1024 * 1024);
    if (!tool) return "tool must be a non-empty string";
    if (!document) return "argumentsJson must be a non-empty JSON string";
    try {
      const value = plainObject(parseJson(document));
      return value
        ? { op: "computer", payload: { tool, arguments: value } }
        : "argumentsJson must contain a JSON object";
    } catch {
      return "argumentsJson is not valid JSON";
    }
  }
  return "unknown worker tool";
}

/** One protocol frame, factored for deterministic tests. Calls are serialized
 * by the entry process, so an approval response cannot be overtaken by a later
 * computer action on the same MCP session. */
export async function handleWorkerMcpFrame(
  frame: McpFrame,
  client: WorkerTaskClient,
  control?: ControlClient,
): Promise<McpFrame | null> {
  if (frame.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: frame.id ?? null,
      result: {
        protocolVersion: frame.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-worker", version: "1" },
      },
    };
  }
  if (frame.method === "ping") return { jsonrpc: "2.0", id: frame.id ?? null, result: {} };
  if (frame.method === "tools/list") {
    return { jsonrpc: "2.0", id: frame.id ?? null, result: { tools: WORKER_MCP_TOOLS } };
  }
  if (String(frame.method ?? "").startsWith("notifications/")) return null;
  if (frame.method !== "tools/call") {
    return frame.id == null
      ? null
      : { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `method not found: ${frame.method}` } };
  }
  if (control && (await control.state(true)).held) return errorResult(frame.id, CONTROL_REFUSAL_PLAIN);
  const rawArgs = frame.params?.arguments;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as JsonObject
    : {};
  const call = taskCall(String(frame.params?.name ?? ""), args);
  if (typeof call === "string") return errorResult(frame.id, call);
  const reply = await client.call(call.op, call.payload);
  return {
    jsonrpc: "2.0",
    id: frame.id ?? null,
    result: {
      content: reply.content ?? [{ type: "text", text: reply.text }],
      isError: reply.isError,
    },
  };
}
