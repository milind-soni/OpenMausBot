#!/usr/bin/env node
// Model Context Protocol (MCP) Server for OpenMausBot
// Standard JSON-RPC 2.0 stdio transport for external agent orchestration (Hermes, Claude Desktop, Cursor, etc.).
import readline from "node:readline";

export function validateBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid OpenMausBot URL: '${url}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenMausBot URL must use http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OpenMausBot URL must not contain credentials; use OPENMAUSBOT_TOKEN instead");
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("OpenMausBot URL must be an origin without a path, query, or fragment");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (parsed.protocol === "http:" && !isLoopback && process.env.ALLOW_INSECURE_HTTP !== "true") {
    throw new Error(
      `Insecure cleartext HTTP origin '${parsed.origin}' is rejected. Use https:// or set ALLOW_INSECURE_HTTP=true.`,
    );
  }
  return parsed.origin;
}

const configuredUrl = process.env.OPENMAUSBOT_URL ||
  (process.env.OMB_PORT ? `http://127.0.0.1:${process.env.OMB_PORT}` : undefined);

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
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
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

export const TOOLS: McpToolDefinition[] = [
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
    description: "Send an instruction to a bot's active task. Optionally name the expected task to prevent cross-task races. This may cause the bot to use external tools.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot to message." },
        task_id: { type: "string", description: "Optional expected active task/thread ID." },
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
    description: "Switch a bot or channel to an existing task. Running or approval-blocked conversations are refused.",
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
    description: "Change an idle bot to an exact configured provider instance and model.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
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
    description: "Interrupt the active turn in a bot or channel conversation.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
      },
      required: ["target_type", "target_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
  },
];

function parsePositiveLimit(raw: unknown, fallback = 30, maximum = 200): number {
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

export class ToolInputError extends Error {}

export function validateToolArguments(name: unknown, args: unknown): asserts args is Record<string, unknown> {
  if (typeof name !== "string" || !name) throw new ToolInputError("tool name must be a non-empty string");
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolInputError(`Unknown tool: ${name}`);
  if (!isRecord(args)) throw new ToolInputError("tool arguments must be an object");
  const error = schemaError(tool.inputSchema as Record<string, any>, args, "arguments");
  if (error) throw new ToolInputError(error);
}

function stringArg(args: Record<string, unknown>, key: string, options: { trim?: boolean; allowEmpty?: boolean; max?: number } = {}): string {
  const raw = args[key];
  if (typeof raw !== "string") throw new ToolInputError(`${key} must be a string`);
  const value = options.trim === false ? raw : raw.trim();
  if (!options.allowEmpty && !value) throw new ToolInputError(`${key} must not be empty`);
  if (options.max && value.length > options.max) throw new ToolInputError(`${key} must be at most ${options.max} characters`);
  return value;
}

function optionalStringArg(
  args: Record<string, unknown>,
  key: string,
  options: { trim?: boolean; allowEmpty?: boolean; max?: number } = {},
): string | undefined {
  if (!(key in args)) return undefined;
  return stringArg(args, key, options);
}

function idArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key);
  if (!/^[\w-]+$/.test(value)) throw new ToolInputError(`${key} is not a valid OpenMausBot ID`);
  return value;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ToolInputError(`${key} must be a non-empty list of IDs`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function records(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function projectTask(task: Record<string, any>, activeThreadId: unknown) {
  return {
    taskId: task.threadId,
    title: task.title,
    createdAt: task.createdAt,
    ...(typeof activeThreadId === "string" ? { active: task.threadId === activeThreadId } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
  };
}

function projectBot(bot: Record<string, any>) {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    section: bot.section ?? null,
    chiefOfStaff: Boolean(bot.chiefOfStaff),
    modelSelection: bot.modelSelection,
    busy: Boolean(bot.busy),
    activity: bot.activity,
    unread: Boolean(bot.unread),
    activeTaskId: bot.threadId,
    tasks: records(bot.tasks).map((task) => projectTask(task, bot.threadId)),
  };
}

function projectChannel(channel: Record<string, any>) {
  return {
    id: channel.id,
    name: channel.name,
    memberIds: channel.memberIds,
    bulletin: channel.bulletin,
    defaultResponder: channel.defaultResponder,
    section: channel.section ?? null,
    directMessage: Boolean(channel.dm),
    working: Boolean(channel.working),
    busyBotId: channel.busyBotId ?? null,
    activeTaskId: channel.threadId,
    tasks: records(channel.tasks).map((task) => projectTask(task, channel.threadId)),
  };
}

function projectMessage(message: Record<string, any>) {
  const card = isRecord(message.card)
    ? {
        title: message.card.title,
        subtitle: message.card.subtitle,
        options: message.card.options,
        answered: message.card.answered,
        dismissed: message.card.dismissed,
      }
    : undefined;
  const tool = isRecord(message.tool)
    ? { name: message.tool.name, ok: message.tool.ok, spoken: message.tool.spoken, setup: message.tool.setup }
    : undefined;
  const connector = isRecord(message.connector)
    ? {
        slug: message.connector.slug,
        label: message.connector.label,
        description: message.connector.description,
        status: message.connector.status,
        dismissed: message.connector.dismissed,
        resumed: message.connector.resumed,
      }
    : undefined;
  const secret = isRecord(message.secret)
    ? {
        target: message.secret.target,
        label: message.secret.label,
        description: message.secret.description,
        placeholder: message.secret.placeholder,
        helpUrl: message.secret.helpUrl,
        provided: message.secret.provided,
        dismissed: message.secret.dismissed,
        resumed: message.secret.resumed,
      }
    : undefined;
  return {
    id: message.id,
    at: message.at,
    role: message.role,
    kind: message.kind,
    text: message.text,
    from: message.from,
    replyToId: message.replyToId,
    reactions: message.reactions,
    steered: message.steered,
    queued: message.queued,
    ...(tool ? { tool } : {}),
    ...(card ? { card } : {}),
    ...(connector ? { connector } : {}),
    ...(secret ? { secret } : {}),
    ...(message.kind === "screen" ? { hasImage: Boolean(message.hasImage || message.png) } : {}),
  };
}

async function fleet(fetcher: (path: string, options?: RequestInit) => Promise<any>) {
  return fetcher("/api/bots?messages=0");
}

function taskBelongsTo(owner: Record<string, any>, taskId: string): boolean {
  return owner.threadId === taskId || records(owner.tasks).some((task) => task.threadId === taskId);
}

function messageNeedsInput(message: Record<string, any>): boolean {
  const card = isRecord(message.card) && message.card.requestId && !message.card.answered && !message.card.dismissed;
  const connector = isRecord(message.connector) &&
    !message.connector.dismissed &&
    !message.connector.resumed &&
    message.connector.status !== "connected";
  const secret = isRecord(message.secret) && !message.secret.provided && !message.secret.dismissed;
  return Boolean(card || connector || secret);
}

function dispatchFailedAfterLatestUser(messages: Array<Record<string, any>>): boolean {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const turnMessages = messages.slice(lastUser + 1);
  if (turnMessages.some((message) => message.role === "bot" && message.kind === "text" && message.text?.trim())) {
    return false;
  }
  return turnMessages.some(
    (message) =>
      message.kind === "activity" &&
      message.tool?.ok === false &&
      typeof message.tool?.name === "string" &&
      /^error:/i.test(message.tool.name.trim()),
  );
}

async function conversationTail(
  fetcher: (path: string, options?: RequestInit) => Promise<any>,
  taskId: string,
  limit = 10,
) {
  const page = await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
  const raw = records(page.messages);
  return {
    raw,
    messages: raw.map(projectMessage),
    hasMore: Boolean(page.hasMore),
  };
}

function normalizeResponder(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ToolInputError("default_responder must be an object");
  if (value.kind === "everyone" || value.kind === "mentions") return { kind: value.kind };
  if (value.kind === "member" && typeof value.bot_id === "string" && value.bot_id.trim()) {
    return { kind: "member", botId: value.bot_id.trim() };
  }
  throw new ToolInputError("default_responder is invalid");
}

async function checkedModelSelection(
  args: Record<string, unknown>,
  fetcher: (path: string, options?: RequestInit) => Promise<any>,
) {
  const instanceId = stringArg(args, "instance_id");
  const model = stringArg(args, "model");
  const effort = optionalStringArg(args, "effort");
  const described = await fetcher("/api/instances");
  const instance = records(described.instances).find((candidate) => candidate.instanceId === instanceId);
  if (!instance) throw new ToolInputError(`model instance not found: ${instanceId}`);
  if (instance.snapshot?.state !== "available") throw new ToolInputError(`model instance is unavailable: ${instanceId}`);
  const models = isRecord(instance.models) ? instance.models : {};
  const offered = records(models.options).map((option) => option.id).filter((id) => typeof id === "string");
  if (models.default !== model && !offered.includes(model)) {
    throw new ToolInputError(`model '${model}' is not offered by instance '${instanceId}'`);
  }
  const efforts = Array.isArray(instance.capabilities?.effortLevels) ? instance.capabilities.effortLevels : [];
  if (effort && !efforts.includes(effort)) {
    throw new ToolInputError(`effort '${effort}' is not offered by instance '${instanceId}'`);
  }
  return { instanceId, model, ...(effort ? { effort } : {}) };
}

function taskRoute(targetType: unknown, targetId: string): string {
  if (targetType === "bot") return `/api/bots/${encodeURIComponent(targetId)}/tasks`;
  if (targetType === "channel") return `/api/groups/${encodeURIComponent(targetId)}/tasks`;
  throw new ToolInputError("target_type must be bot or channel");
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Request cancelled"));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Request cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  switch (name) {
    case "get_system_health": {
      const res = await fetcher("/api/health");
      if (res?.app !== "openmausbot") throw new Error("The configured endpoint is not an OpenMausBot server");
      return {
        status: "connected",
        endpoint: discoveredBaseUrl ?? OMB_BASE_URL,
        app: "openmausbot",
        packaged: Boolean(res.static),
      };
    }

    case "list_bots": {
      const res = await fleet(fetcher);
      return { bots: records(res.bots).map(projectBot) };
    }

    case "get_bot_messages": {
      const botId = idArg(args, "bot_id");
      const res = await fleet(fetcher);
      const bot = records(res.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Bot not found: ${botId}`);
      const taskId = args.task_id === undefined ? String(bot.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(bot, taskId)) throw new Error(`Task '${taskId}' does not belong to bot '${botId}'`);
      const limit = parsePositiveLimit(args.limit, 30, 200);
      const page = await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
      return {
        bot: projectBot(bot),
        taskId,
        messages: records(page.messages).map(projectMessage),
        hasMore: Boolean(page.hasMore),
      };
    }

    case "send_bot_message": {
      const botId = idArg(args, "bot_id");
      const text = stringArg(args, "text", { trim: true, max: 100_000 });
      const state = await fleet(fetcher);
      const bot = records(state.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Bot not found: ${botId}`);
      const taskId = args.task_id === undefined ? String(bot.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(bot, taskId)) throw new Error(`Task '${taskId}' does not belong to bot '${botId}'`);
      if (bot.threadId !== taskId) {
        throw new Error(`Task '${taskId}' is not active for bot '${botId}'; switch to it before sending`);
      }
      const busyChannel = records(state.groups).find((channel) => channel.busyBotId === botId);
      if (busyChannel) {
        throw new Error(`Bot '${botId}' is working in channel '${busyChannel.id}'; send to or interrupt that channel instead`);
      }
      await fetcher(`/api/bots/${encodeURIComponent(botId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, threadId: taskId }),
      });
      return { success: true, botId, taskId };
    }

    case "create_bot": {
      const name = stringArg(args, "name", { max: 100 });
      const title = optionalStringArg(args, "title", { trim: false, allowEmpty: true, max: 200 });
      const description = optionalStringArg(args, "description", { trim: false, allowEmpty: true, max: 4_000 });
      const section = optionalStringArg(args, "section", { max: 60 });
      const wantsModel = args.instance_id !== undefined || args.model !== undefined || args.effort !== undefined;
      if (wantsModel && (args.instance_id === undefined || args.model === undefined)) {
        throw new ToolInputError("instance_id and model must be provided together");
      }
      const selection = wantsModel ? await checkedModelSelection(args, fetcher) : undefined;
      const created = await fetcher("/api/bots", {
        method: "POST",
        body: JSON.stringify({
          name,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(section !== undefined ? { section } : {}),
          ...(selection ? { modelSelection: selection, requireAvailableModel: true } : {}),
        }),
      });
      if (!isRecord(created?.bot) || typeof created.bot.id !== "string") {
        throw new Error("OpenMausBot did not return the created bot");
      }
      return { success: true, bot: projectBot(created.bot) };
    }

    case "update_bot_profile": {
      const botId = idArg(args, "bot_id");
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = stringArg(args, "name", { max: 100 });
      if (args.title !== undefined) patch.title = stringArg(args, "title", { trim: false, allowEmpty: true, max: 200 });
      if (args.description !== undefined) patch.description = stringArg(args, "description", { trim: false, allowEmpty: true, max: 4_000 });
      if ("section" in args) patch.section = args.section === null ? null : stringArg(args, "section", { max: 60 });
      if (!Object.keys(patch).length) throw new ToolInputError("provide at least one profile field to update");
      const result = await fetcher(`/api/bots/${encodeURIComponent(botId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!isRecord(result?.bot)) {
        throw new Error("OpenMausBot did not return the updated bot");
      }
      return { success: true, bot: projectBot(result.bot) };
    }

    case "list_channels": {
      const res = await fleet(fetcher);
      return { channels: records(res.groups).map(projectChannel) };
    }

    case "get_channel_messages": {
      const channelId = idArg(args, "channel_id");
      const res = await fleet(fetcher);
      const channel = records(res.groups).find((candidate) => candidate.id === channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);
      const taskId = args.task_id === undefined ? String(channel.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(channel, taskId)) throw new Error(`Task '${taskId}' does not belong to channel '${channelId}'`);
      const limit = parsePositiveLimit(args.limit, 30, 200);
      const page = await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
      return {
        channel: projectChannel(channel),
        taskId,
        messages: records(page.messages).map(projectMessage),
        hasMore: Boolean(page.hasMore),
      };
    }

    case "send_channel_message": {
      const channelId = idArg(args, "channel_id");
      const text = stringArg(args, "text", { trim: true, max: 100_000 });
      const state = await fleet(fetcher);
      const channel = records(state.groups).find((candidate) => candidate.id === channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);
      const taskId = args.task_id === undefined ? String(channel.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(channel, taskId)) {
        throw new Error(`Task '${taskId}' does not belong to channel '${channelId}'`);
      }
      if (channel.threadId !== taskId) {
        throw new Error(`Task '${taskId}' is not active for channel '${channelId}'; switch to it before sending`);
      }
      await fetcher(`/api/groups/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, threadId: taskId }),
      });
      return { success: true, channelId, taskId };
    }

    case "create_channel": {
      const name = stringArg(args, "name", { max: 100 });
      const memberIds = stringArrayArg(args, "member_ids");
      const section = optionalStringArg(args, "section", { max: 60 });
      const bulletin = optionalStringArg(args, "bulletin", { trim: false, allowEmpty: true, max: 12_000 }) ?? "";
      const requestedResponder = normalizeResponder(args.default_responder);
      if (requestedResponder?.kind === "member" && !memberIds.includes(requestedResponder.botId)) {
        throw new ToolInputError("default_responder bot must be a channel member");
      }
      const responder = requestedResponder ?? { kind: "member", botId: memberIds[0] };
      const created = await fetcher("/api/groups", {
        method: "POST",
        body: JSON.stringify({
          name,
          memberIds,
          ...(section ? { section } : {}),
          setup: { bulletin, defaultResponder: responder },
        }),
      });
      if (!isRecord(created?.group) || typeof created.group.id !== "string") {
        throw new Error("OpenMausBot did not return the created channel");
      }
      return { success: true, channel: projectChannel(created.group) };
    }

    case "update_channel": {
      const channelId = idArg(args, "channel_id");
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = stringArg(args, "name", { max: 100 });
      if (args.member_ids !== undefined) patch.memberIds = stringArrayArg(args, "member_ids");
      if (args.section !== undefined) patch.section = args.section === null ? null : stringArg(args, "section", { max: 60 });
      if (args.bulletin !== undefined) patch.bulletin = stringArg(args, "bulletin", { trim: false, allowEmpty: true, max: 12_000 });
      if (args.default_responder !== undefined) patch.defaultResponder = normalizeResponder(args.default_responder);
      if (Object.keys(patch).length === 0) throw new ToolInputError("provide at least one channel field to update");
      const memberIds = patch.memberIds as string[] | undefined;
      const responder = patch.defaultResponder as Record<string, string> | undefined;
      if (memberIds && responder?.kind === "member" && !memberIds.includes(responder.botId)) {
        throw new ToolInputError("default_responder bot must be a channel member");
      }
      const result = await fetcher(`/api/groups/${encodeURIComponent(channelId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!isRecord(result?.group)) {
        throw new Error("OpenMausBot did not return the updated channel");
      }
      return { success: true, channel: projectChannel(result.group) };
    }

    case "create_task": {
      const targetId = idArg(args, "target_id");
      const title = optionalStringArg(args, "title", { max: 80 });
      const route = taskRoute(args.target_type, targetId);
      const result = await fetcher(route, { method: "POST", body: JSON.stringify(title ? { title } : {}) });
      if (!isRecord(result?.task) || typeof result.task.threadId !== "string") {
        throw new Error("OpenMausBot did not return the created task");
      }
      const activeTaskId = result.bot?.threadId ?? result.group?.threadId ?? result.task?.threadId;
      return {
        success: true,
        targetType: args.target_type,
        targetId,
        task: projectTask(result.task, activeTaskId),
      };
    }

    case "switch_task": {
      const targetId = idArg(args, "target_id");
      const taskId = idArg(args, "task_id");
      const route = taskRoute(args.target_type, targetId);
      const result = await fetcher(`${route}/${encodeURIComponent(taskId)}?messages=0`, { method: "POST", body: "{}" });
      const target = args.target_type === "bot" ? result.bot : result.group;
      return {
        success: true,
        targetType: args.target_type,
        targetId,
        taskId,
        ...(isRecord(target)
          ? { target: args.target_type === "bot" ? projectBot(target) : projectChannel(target) }
          : {}),
      };
    }

    case "rename_task": {
      const targetId = idArg(args, "target_id");
      const taskId = idArg(args, "task_id");
      const title = stringArg(args, "title", { max: 80 });
      const route = taskRoute(args.target_type, targetId);
      const result = await fetcher(`${route}/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      if (!isRecord(result?.task)) {
        throw new Error("OpenMausBot did not return the renamed task");
      }
      return {
        success: true,
        targetType: args.target_type,
        targetId,
        task: projectTask(result.task, undefined),
      };
    }

    case "search_messages": {
      const query = stringArg(args, "query", { max: 500 });
      const limit = parsePositiveLimit(args.limit, 40, 100);
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (args.task_id !== undefined) params.set("threadId", idArg(args, "task_id"));
      const result = await fetcher(`/api/search?${params.toString()}`);
      return { hits: records(result.hits) };
    }

    case "wait_for_conversation": {
      const targetType = args.target_type;
      if (targetType !== "bot" && targetType !== "channel") {
        throw new ToolInputError("target_type must be bot or channel");
      }
      const targetId = idArg(args, "target_id");
      const timeoutSeconds = parsePositiveLimit(args.timeout_seconds, 30, 120);
      const deadline = Date.now() + timeoutSeconds * 1_000;
      const startupGraceDeadline = Math.min(deadline, Date.now() + 750);
      let state = await fleet(fetcher);
      const collection = targetType === "bot" ? records(state.bots) : records(state.groups);
      let target = collection.find((candidate) => candidate.id === targetId);
      if (!target) throw new Error(`${targetType === "bot" ? "Bot" : "Channel"} not found: ${targetId}`);
      const taskId = args.task_id === undefined ? String(target.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(target, taskId)) {
        throw new Error(`Task '${taskId}' does not belong to ${targetType} '${targetId}'`);
      }
      let sawBusy = false;
      while (true) {
        const liveCollection = targetType === "bot" ? records(state.bots) : records(state.groups);
        target = liveCollection.find((candidate) => candidate.id === targetId);
        if (!target) throw new Error(`${targetType === "bot" ? "Bot" : "Channel"} not found: ${targetId}`);
        if (!taskBelongsTo(target, taskId)) {
          throw new Error(`Task '${taskId}' no longer belongs to ${targetType} '${targetId}'`);
        }
        const projectedTarget = targetType === "bot" ? projectBot(target) : projectChannel(target);
        const terminal = async (status: string, existingTail?: Awaited<ReturnType<typeof conversationTail>>) => {
          const tail = existingTail ?? await conversationTail(fetcher, taskId);
          const needsInput = tail.raw.some(messageNeedsInput);
          const terminalStatus = status === "settled" && dispatchFailedAfterLatestUser(tail.raw)
            ? "failed"
            : status;
          return {
            status: needsInput ? "needs-user" : terminalStatus,
            targetType,
            targetId,
            taskId,
            target: projectedTarget,
            messages: tail.messages,
            hasMore: tail.hasMore,
          };
        };

        // Historical tasks cannot be running: all provider turns are bound
        // to the owner's active thread, and task switching is blocked while busy.
        if (target.threadId !== taskId) return terminal("settled");

        if (targetType === "bot") {
          const busyChannel = records(state.groups).find((channel) => channel.busyBotId === targetId);
          if (busyChannel) {
            throw new Error(`Bot '${targetId}' is working in channel '${busyChannel.id}'; wait on that channel instead`);
          }
          if (target.activity === "waiting-on-you") return terminal("needs-user");
          if (target.activity === "dead") return terminal("failed");
          if (target.activity === "no-signal") return terminal("stalled");
          if (!target.busy) return terminal("settled");
          sawBusy = true;
        } else {
          const tail = await conversationTail(fetcher, taskId);
          if (tail.raw.some(messageNeedsInput)) {
            return terminal("needs-user", tail);
          }
          const channelWorking = target.working === true || Boolean(target.busyBotId);
          if (channelWorking) {
            sawBusy = true;
            const busyBotId = target.busyBotId;
            if (busyBotId) {
              const speaker = records(state.bots).find((bot) => bot.id === busyBotId);
              if (!speaker) return terminal("stalled");
              if (speaker.activity === "waiting-on-you") return terminal("needs-user");
              if (speaker.activity === "dead") return terminal("failed");
              if (speaker.activity === "no-signal") return terminal("stalled");
            }
          } else {
            const latest = tail.raw.at(-1);
            // New servers expose `working` synchronously before returning a
            // channel send. The short grace remains only for older servers
            // that have no operation-level field and report a user message
            // just before their first speaker becomes busy.
            if (sawBusy || target.working === false || latest?.role !== "user") {
              return terminal("settled", tail);
            }
            if (Date.now() >= startupGraceDeadline) {
              return terminal("settled", tail);
            }
          }
        }

        if (Date.now() >= deadline) return terminal("timed-out");
        await sleep(Math.min(500, Math.max(0, deadline - Date.now())), signal);
        state = await fleet(fetcher);
      }
    }

    case "set_bot_model": {
      const botId = idArg(args, "bot_id");
      const current = await fleet(fetcher);
      const bot = records(current.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Bot not found: ${botId}`);
      if (bot.busy) throw new Error("Interrupt the bot or let it finish before changing its model");
      const selection = await checkedModelSelection(args, fetcher);
      const res = await fetcher(`/api/bots/${encodeURIComponent(botId)}`, {
        method: "PATCH",
        body: JSON.stringify({ modelSelection: selection, requireAvailableModel: true }),
      });
      return { success: true, bot: projectBot(res.bot) };
    }

    case "list_available_models": {
      const res = await fetcher("/api/instances");
      return {
        instances: records(res.instances).map((instance) => ({
          instanceId: instance.instanceId,
          driverKind: instance.driverKind,
          displayName: instance.displayName,
          snapshot: { state: instance.snapshot?.state },
          models: instance.models,
          capabilities: instance.capabilities,
          access: instance.access,
        })),
      };
    }

    case "interrupt_conversation": {
      const targetType = args.target_type;
      if (targetType !== "bot" && targetType !== "channel") {
        throw new ToolInputError("target_type must be bot or channel");
      }
      const targetId = idArg(args, "target_id");
      const current = await fleet(fetcher);
      const target = (targetType === "bot" ? records(current.bots) : records(current.groups))
        .find((candidate) => candidate.id === targetId);
      if (!target) throw new Error(`${targetType === "bot" ? "Bot" : "Channel"} not found: ${targetId}`);
      const taskId = String(target.threadId);
      if (targetType === "bot") {
        const busyChannel = records(current.groups).find((channel) => channel.busyBotId === targetId);
        if (busyChannel) {
          throw new Error(`Bot '${targetId}' is working in channel '${busyChannel.id}'; interrupt that channel instead`);
        }
      }
      const route = targetType === "bot" ? "bots" : "groups";
      await fetcher(`/api/${route}/${encodeURIComponent(targetId)}/interrupt`, {
        method: "POST",
        body: JSON.stringify({ threadId: taskId }),
      });
      return { success: true, targetType, targetId, taskId };
    }

    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
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
