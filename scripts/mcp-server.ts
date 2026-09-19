#!/usr/bin/env node
// Model Context Protocol (MCP) Server for OpenMausBot
// Standard JSON-RPC 2.0 stdio transport for external agent orchestration (Hermes, Claude Desktop, Cursor, etc.).
import readline from "node:readline";

import { configuredServerUrl, validateBaseUrl } from "../shared/server-endpoint.ts";

import { isRecord, ToolInputError, type ToolHandler } from "./mcp-server/context.ts";
import { TOOL_HANDLERS, type ToolName } from "./mcp-server/registry.ts";

export { ToolInputError };

const configuredUrl = configuredServerUrl(process.env);

export const OMB_BASE_URL = validateBaseUrl(configuredUrl || "http://127.0.0.1:8799");
const DISCOVERY_URLS = configuredUrl
  ? [OMB_BASE_URL]
  : [8799, 18799, 28799].map((port) => `http://127.0.0.1:${port}`);
let discoveredBaseUrl: string | undefined;

export function log(msg: string) {
  process.stderr.write(`[openmausbot-mcp] ${msg}\n`);
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function requestTimeoutMs(): number {
  const raw = Number(process.env.OPENMAUSBOT_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 120_000 ? Math.floor(raw) : DEFAULT_REQUEST_TIMEOUT_MS;
}

function requestHeaders(options: RequestInit): NonNullable<RequestInit["headers"]> {
  const token = process.env.OPENMAUSBOT_TOKEN?.trim();
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<any> {
  const timeout = AbortSignal.timeout(requestTimeoutMs());
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, {
    ...options,
    signal,
    headers: requestHeaders(options),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 403 && !process.env.OPENMAUSBOT_TOKEN?.trim()) {
      throw new Error(
        "OpenMausBot refused this write because the installed desktop app requires a paired session token. " +
        "Set OPENMAUSBOT_TOKEN as described in docs/mcp-server.md.",
      );
    }
    throw new Error(`OpenMausBot API error (${response.status}): ${text || response.statusText}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`OpenMausBot API returned a non-JSON response from ${url}`);
  }
}

export async function probeBaseUrls(candidates: string[]): Promise<string> {
  const failures: string[] = [];
  for (const unvalidated of candidates) {
    const candidate = validateBaseUrl(unvalidated);
    try {
      const health = await fetchJson(`${candidate}/api/health`, {
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs(), 2_000)),
      });
      if (health?.app !== "openmausbot") {
        failures.push(`${candidate} answered, but it was not OpenMausBot`);
        continue;
      }
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not find a running OpenMausBot server. ${failures.join("; ")}`);
}

export async function resolveBaseUrl(): Promise<string> {
  if (discoveredBaseUrl) return discoveredBaseUrl;
  if (process.env.OPENMAUSBOT_TOKEN?.trim() && !configuredUrl) {
    throw new Error("Set OPENMAUSBOT_URL or OMB_PORT when using OPENMAUSBOT_TOKEN so credentials are never sent during port discovery");
  }
  discoveredBaseUrl = await probeBaseUrls(DISCOVERY_URLS);
  return discoveredBaseUrl;
}

export async function request(path: string, options: RequestInit = {}, baseUrl?: string) {
  const target = baseUrl ? validateBaseUrl(baseUrl) : await resolveBaseUrl();
  return fetchJson(`${target}${path}`, options);
}

export interface McpToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const AGENT_ACTION = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export const TOOLS = [
  {
    name: "get_system_health",
    description: "Check whether the OpenMausBot server is reachable.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_bots",
    description: "List bots, their current status, active task, and available tasks without loading transcripts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_bot_messages",
    description: "Retrieve a bounded page of recent messages from one bot task. Images are never returned inline.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        task_id: { type: "string", description: "Optional task/thread ID. Defaults to the bot's active task." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages to retrieve (default: 30, max: 200)." },
      },
      required: ["bot_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "send_bot_message",
    description: "Send an instruction to one bot task without changing the selected task. This may cause the bot to use external tools.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot to message." },
        task_id: { type: "string", description: "Optional owned task/thread ID. Defaults to the bot's selected task." },
        text: { type: "string", description: "The message content/instruction to send." },
      },
      required: ["bot_id", "text"],
      additionalProperties: false,
    },
    annotations: AGENT_ACTION,
  },
  {
    name: "create_bot",
    description: "Create a new bot and optionally configure its profile, section, and exact model selection.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bot display name." },
        title: { type: "string", description: "Optional short role title." },
        description: { type: "string", description: "Optional persona or responsibility description." },
        section: { type: "string", description: "Optional sidebar section." },
        instance_id: { type: "string", description: "Optional provider instance ID; model is required with it." },
        model: { type: "string", description: "Optional exact model ID; instance_id is required with it." },
        effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "update_bot_profile",
    description: "Update safe bot profile fields. This cannot alter permissions, computer access, or approval settings.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        name: { type: "string", description: "Optional bot display name." },
        title: { type: "string", description: "Optional short role title." },
        description: { type: "string", description: "Optional persona or responsibility description." },
        section: { type: ["string", "null"], description: "Optional sidebar section. Null clears it." },
      },
      required: ["bot_id"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "list_channels",
    description: "List multi-agent channels, their members, active task, and available tasks without loading transcripts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_channel_messages",
    description: "Retrieve a bounded page of recent messages from one channel task. Images are never returned inline.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel." },
        task_id: { type: "string", description: "Optional task/thread ID. Defaults to the channel's active task." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages to retrieve (default: 30, max: 200)." },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "send_channel_message",
    description: "Send an instruction to a channel's active task. Optionally name the expected task to prevent cross-task races. This may cause one or more bots to use external tools.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel." },
        task_id: { type: "string", description: "Optional expected active task/thread ID." },
        text: { type: "string", description: "The message content to post." },
      },
      required: ["channel_id", "text"],
      additionalProperties: false,
    },
    annotations: AGENT_ACTION,
  },
  {
    name: "create_channel",
    description: "Create a multi-agent channel from existing bots.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Channel name." },
        member_ids: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        section: { type: "string", description: "Optional sidebar section." },
        bulletin: { type: "string", description: "Optional shared instructions for channel members." },
        default_responder: {
          oneOf: [
            { type: "object", properties: { kind: { const: "everyone" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "mentions" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "member" }, bot_id: { type: "string" } }, required: ["kind", "bot_id"], additionalProperties: false },
          ],
        },
      },
      required: ["name", "member_ids"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "update_channel",
    description: "Update a channel's name, members, section, bulletin, or default responder.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel." },
        name: { type: "string" },
        member_ids: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        section: { type: ["string", "null"], description: "Null clears the section." },
        bulletin: { type: "string" },
        default_responder: {
          oneOf: [
            { type: "object", properties: { kind: { const: "everyone" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "mentions" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "member" }, bot_id: { type: "string" } }, required: ["kind", "bot_id"], additionalProperties: false },
          ],
        },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "create_task",
    description: "Create and activate a fresh conversation task for a bot or user-created channel.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        title: { type: "string", description: "Optional task title." },
      },
      required: ["target_type", "target_id"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "switch_task",
    description: "Select an existing bot or channel task. Bot tasks keep running independently; busy channels cannot switch.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["target_type", "target_id", "task_id"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "rename_task",
    description: "Rename an existing bot or channel task.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        task_id: { type: "string" },
        title: { type: "string" },
      },
      required: ["target_type", "target_id", "task_id", "title"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "search_messages",
    description: "Search local transcripts, optionally within one task/thread. Returns at most 100 compact hits.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        task_id: { type: "string", description: "Optional task/thread ID." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum hits (default: 40)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "wait_for_conversation",
    description: "Wait for a bot or channel task to finish, stall, fail, or require user input.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        task_id: { type: "string", description: "Optional task/thread ID. Defaults to the active task." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 120, description: "Maximum wait (default: 30 seconds)." },
      },
      required: ["target_type", "target_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "set_bot_model",
    description: "Change an idle bot's default and selected task model, or only one idle task's model when task_id is provided. Other tasks are unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        task_id: { type: "string", description: "Optional owned task/thread ID. Omit to change the bot's default and selected task model." },
        instance_id: { type: "string", description: "The configured provider instance ID." },
        model: { type: "string", description: "The exact model ID exposed by that instance." },
        effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] },
      },
      required: ["bot_id", "instance_id", "model"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "edit_bot_message",
    description:
      "Edit an earlier user message, which forks the conversation from that point and answers again. "
      + "This is the rewind a person performs in the composer, and the only mapped way to make the "
      + "harness rebuild a thread's context instead of resuming the provider's own session. "
      + "Refused while the thread is working.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        message_id: { type: "string", description: "The user message to replace." },
        text: { type: "string", description: "What that message should say instead." },
        task_id: { type: "string", description: "Optional owned task/thread ID. Defaults to the bot's selected task." },
      },
      required: ["bot_id", "message_id", "text"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "list_available_models",
    description: "List configured model instances and capabilities without exposing local executable paths.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "interrupt_conversation",
    description: "Interrupt one bot or channel task's turn without stopping other bot tasks.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        task_id: { type: "string", description: "Optional task/thread ID. Defaults to the selected task." },
      },
      required: ["target_type", "target_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
  },
] as const satisfies readonly McpToolDefinition[];

// McpToolDefinition keys the list above by the registry's ToolName, so an
// entry without a handler fails to typecheck; this constant fails the build
// the other way round — the two records cannot drift apart.
export const toolsCoverHandlers: Exclude<ToolName, (typeof TOOLS)[number]["name"]> extends never
  ? true
  : "every tool handler needs an entry in the tool list"
  = true;


function valueHasType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function schemaError(schema: Record<string, any>, value: unknown, path: string): string | null {
  if (schema.const !== undefined && value !== schema.const) return `${path} must equal ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate: Record<string, any>) => !schemaError(candidate, value, path));
    return matches.length === 1 ? null : `${path} does not match exactly one supported shape`;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type: string) => valueHasType(value, type))) return `${path} must be ${types.join(" or ")}`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      return `${path} must not contain duplicates`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = schemaError(schema.items, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) return `${path}.${key} is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !(key in properties));
      if (extra) return `${path}.${extra} is not supported`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const error = schemaError(child as Record<string, any>, value[key], `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

export function validateToolArguments(name: unknown, args: unknown): asserts args is Record<string, unknown> {
  if (typeof name !== "string" || !name) throw new ToolInputError("tool name must be a non-empty string");
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolInputError(`Unknown tool: ${name}`);
  if (!isRecord(args)) throw new ToolInputError("tool arguments must be an object");
  const error = schemaError(tool.inputSchema as Record<string, any>, args, "arguments");
  if (error) throw new ToolInputError(error);
}


export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  baseFetcher: (path: string, options?: RequestInit) => Promise<any> = request,
  signal?: AbortSignal,
): Promise<unknown> {
  const fetcher = signal
    ? (path: string, options: RequestInit = {}) => baseFetcher(path, { ...options, signal: options.signal ?? signal })
    : baseFetcher;
  validateToolArguments(name, args);
  const handler = (TOOL_HANDLERS as Record<string, ToolHandler>)[name];
  if (!handler) throw new ToolInputError(`Unknown tool: ${name}`);
  return handler(args, {
    fetch: fetcher,
    signal,
    endpoint: () => discoveredBaseUrl ?? OMB_BASE_URL,
  });
}

export function formatResponse(id: string | number | null, result?: unknown, error?: { code?: number; message?: string }) {
  const payload: Record<string, unknown> = { jsonrpc: "2.0", id: id ?? null };
  if (error) {
    payload.error = {
      code: error.code ?? -32603,
      message: error.message ?? "Internal error",
    };
  } else {
    payload.result = result;
  }
  return JSON.stringify(payload);
}

const activeMcpRequests = new Map<string | number, AbortController>();
const activeMcpControllers = new Set<AbortController>();

export async function processMcpMessage(
  raw: string,
  toolHandler: typeof handleToolCall = handleToolCall,
): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let message: any;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return formatResponse(null, undefined, { code: -32700, message: "Parse error" });
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return formatResponse(null, undefined, { code: -32600, message: "Invalid Request" });
  }

  if (message.jsonrpc !== "2.0") {
    return formatResponse(null, undefined, { code: -32600, message: "Invalid Request: missing or invalid jsonrpc version" });
  }

  const hasId = "id" in message && message.id !== undefined;
  if (hasId && (typeof message.id !== "string" && typeof message.id !== "number" || (typeof message.id === "number" && !Number.isFinite(message.id)))) {
    return formatResponse(null, undefined, { code: -32600, message: "Invalid Request: id must be a string or number" });
  }

  const isNotification = !hasId;
  const id = isNotification ? null : message.id;
  const { method, params } = message;

  if (typeof method !== "string") {
    if (isNotification) return null;
    return formatResponse(id, undefined, { code: -32600, message: "Invalid Request: method is required" });
  }

  try {
    if (method === "notifications/cancelled") {
      if (isRecord(params)) {
        const requestId = params.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          activeMcpRequests.get(requestId)?.abort(new DOMException("Request cancelled", "AbortError"));
        }
      }
      return null;
    }

    if (method === "initialize") {
      if (isNotification) return null;
      if (
        !isRecord(params) ||
        typeof params.protocolVersion !== "string" ||
        !isRecord(params.capabilities) ||
        !isRecord(params.clientInfo) ||
        typeof params.clientInfo.name !== "string" ||
        typeof params.clientInfo.version !== "string"
      ) {
        return formatResponse(id, undefined, {
          code: -32602,
          message: "Invalid params: protocolVersion, capabilities, and clientInfo name/version are required",
        });
      }
      const supportedVersions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
      const protocolVersion = supportedVersions.includes(params.protocolVersion)
        ? params.protocolVersion
        : supportedVersions[supportedVersions.length - 1];
      return formatResponse(id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "openmausbot-mcp",
          version: "1.1.0",
        },
        instructions: "Use bounded read tools before mutating the OpenMausBot team. Approval grants, deletion, and computer lifecycle are intentionally unavailable.",
      });
    }

    if (method === "notifications/initialized") {
      log("MCP client initialized session");
      return null;
    }

    if (method === "ping") {
      if (isNotification) return null;
      return formatResponse(id, {});
    }

    if (method === "tools/list") {
      if (isNotification) return null;
      return formatResponse(id, { tools: TOOLS });
    }

    if (method === "tools/call") {
      if (!isRecord(params)) {
        if (isNotification) return null;
        return formatResponse(id, undefined, { code: -32602, message: "Invalid params: tools/call expects an object" });
      }
      const name = params.name;
      const toolArgs = params.arguments === undefined ? {} : params.arguments;
      try {
        validateToolArguments(name, toolArgs);
      } catch (error) {
        if (isNotification) return null;
        return formatResponse(id, undefined, {
          code: -32602,
          message: `Invalid params: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const controller = new AbortController();
      activeMcpControllers.add(controller);
      if (!isNotification) activeMcpRequests.set(id as string | number, controller);
      let result: unknown;
      try {
        result = await toolHandler(name, toolArgs, request, controller.signal);
      } finally {
        activeMcpControllers.delete(controller);
        if (!isNotification && activeMcpRequests.get(id as string | number) === controller) {
          activeMcpRequests.delete(id as string | number);
        }
      }
      if (isNotification) return null;
      return formatResponse(id, {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
        ...(isRecord(result) ? { structuredContent: result } : {}),
      });
    }

    if (isNotification) return null;
    return formatResponse(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  } catch (err: any) {
    if ((err?.name === "AbortError" || err?.message === "Request cancelled") && !isNotification) {
      return formatResponse(id, undefined, { code: -32800, message: "Request cancelled" });
    }
    log(`Error handling ${method}: ${err?.message || err}`);
    if (err instanceof ToolInputError && !isNotification) {
      return formatResponse(id, undefined, { code: -32602, message: `Invalid params: ${err.message}` });
    }
    if (!isNotification) {
      return formatResponse(id, {
        content: [
          {
            type: "text",
            text: `Error: ${err?.message || String(err)}`,
          },
        ],
        isError: true,
      });
    }
    return null;
  }
}

// Start stdio interface when executed directly
if (process.argv[1] && (process.argv[1].endsWith("mcp-server.ts") || process.argv[1].endsWith("mcp-server.js"))) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const activeRequests = new Set<Promise<void>>();

  rl.on("line", (line) => {
    const task = (async () => {
      try {
        const response = await processMcpMessage(line);
        if (response) {
          process.stdout.write(response + "\n");
        }
      } catch (err) {
        log(`Error processing line: ${err}`);
      }
    })();
    activeRequests.add(task);
    task.finally(() => {
      activeRequests.delete(task);
    });
  });

  rl.on("close", async () => {
    for (const controller of activeMcpControllers) {
      controller.abort(new DOMException("Request cancelled", "AbortError"));
    }
    if (activeRequests.size > 0) {
      await Promise.allSettled(Array.from(activeRequests));
    }
    // Do not force an exit here: stdout may still be flushing the final
    // JSON-RPC frame. With stdin and readline closed, Node exits naturally
    // once that buffered write has drained.
    process.exitCode = 0;
  });

  log("OpenMausBot MCP server running on stdio");
}
