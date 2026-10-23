// Connection requests become OpenMausBot chat cards: the agent never authors an auth URL and credentials never pass
// through its transcript. stdout is the MCP transport: never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CONNECTOR_ALLOWED_TOOLS_ENV,
  CONNECTOR_SERVICE_SLUGS_ENV,
  filterToolsListFrame,
  parseConnectorAllowedToolsEnv,
  parseConnectorServiceSlugsEnv,
} from "./connector-advertisement.ts";
import { withSignedOutHint } from "./connector-signed-out-hint.ts";
import { AUTH_CONFIG_ID } from "../shared/connector-availability.ts";
import { fitToolListResult } from "./mcp-tool-schema.ts";
import { toolSchemaProfileFromEnv } from "./tool-schema-profile.ts";

type Json = Record<string, unknown>;

const UPSTREAM = process.env.OMB_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_CONNECTOR_TOKEN ?? process.env.OMB_COMMS_TOKEN ?? "";
const ALLOWED_TOOLS = parseConnectorAllowedToolsEnv(process.env[CONNECTOR_ALLOWED_TOOLS_ENV]);
const SERVICE_SLUGS = parseConnectorServiceSlugsEnv(process.env[CONNECTOR_SERVICE_SLUGS_ENV]);
const SCHEMA_PROFILE = toolSchemaProfileFromEnv(process.env);
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const INITIALIZE_RELAY_TIMEOUT_MS = 1_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;
const TOOLS_LIST_RETRY_MS = 500;

function parsedHeaders(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(process.env.OMB_CONNECTOR_UPSTREAM_HEADERS ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

const upstreamHeaders = parsedHeaders();
let upstreamSessionId = "";
const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

function textResult(id: unknown, text: string, isError = false): Json {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } };
}

function jsonRpcError(id: unknown, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function initializeResult(id: unknown, protocolVersion: unknown): Json {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: typeof protocolVersion === "string" && protocolVersion ? protocolVersion : "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openmausbot-connectors", version: "1" },
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("connector response exceeded 20 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("connector response exceeded 20 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseUpstream(text: string, id: unknown): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? frames.at(-1) ?? null;
}

async function relay(message: Json, timeoutMs = RELAY_TIMEOUT_MS): Promise<Json | null> {
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...upstreamHeaders,
      ...(upstreamSessionId ? { "mcp-session-id": upstreamSessionId } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) throw new Error(`connector service returned HTTP ${response.status}`);
  return parseUpstream(await readBounded(response), message.id);
}

interface ConnectorRequest {
  slug: string;
  alias?: string;
  authConfigId?: string;
}

const BAD_AUTH_CONFIG_ID = "OpenMausBot showed no card: auth_config_id must be a Composio auth config id (ac_ and then letters "
  + "or digits), copied from Auth Configs in the person's Composio project. Leave it out to use their newest enabled config.";

/** Composio's own error names `auth_config_override`, so either spelling is read: on a toolkit entry, or at the top level
 * as one id for a single toolkit or a { toolkit: id } map. */
function requestedAuthConfig(row: Record<string, unknown>): unknown {
  return row.auth_config_id ?? row.auth_config_override;
}

function topLevelAuthConfig(args: Record<string, unknown>, slug: string, toolkitCount: number): unknown {
  const value = requestedAuthConfig(args);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).find(([key]) => key.trim().toLowerCase() === slug)?.[1];
  }
  // One id cannot say which of several toolkits it belongs to.
  return value !== undefined && toolkitCount !== 1 ? null : value;
}

function connectorAdds(args: unknown): { requests: ConnectorRequest[]; badAuthConfig: boolean } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { requests: [], badAuthConfig: false };
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return { requests: [], badAuthConfig: false };
  const seen = new Set<string>();
  const requests: Array<ConnectorRequest & { authConfig?: unknown }> = [];
  for (const item of toolkits) {
    if (typeof item === "string") {
      const slug = item.trim().toLowerCase();
      const key = JSON.stringify([slug, ""]);
      if (!seen.has(key)) {
        seen.add(key);
        requests.push({ slug });
      }
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown; alias?: unknown; account?: unknown };
    const action = String(row.action ?? "add").toLowerCase();
    if (!["add", "connect", "initiate"].includes(action)) continue;
    const slug = typeof row.toolkit === "string" ? row.toolkit : row.name;
    if (typeof slug !== "string") continue;
    const normalized = slug.trim().toLowerCase();
    const alias = (typeof row.alias === "string" ? row.alias : typeof row.account === "string" ? row.account : "").trim();
    const key = JSON.stringify([normalized, alias.toLowerCase()]);
    if (seen.has(key)) continue;
    seen.add(key);
    const authConfig = requestedAuthConfig(row as Record<string, unknown>);
    requests.push({ slug: normalized, ...(alias ? { alias } : {}), ...(authConfig !== undefined ? { authConfig } : {}) });
  }
  let badAuthConfig = false;
  const checked = requests.map(({ authConfig, ...request }) => {
    const value = authConfig ?? topLevelAuthConfig(args as Record<string, unknown>, request.slug, requests.length);
    if (value === undefined) return request;
    if (typeof value !== "string" || !AUTH_CONFIG_ID.test(value.trim())) {
      badAuthConfig = true;
      return request;
    }
    return { ...request, authConfigId: value.trim() };
  });
  return { requests: checked, badAuthConfig };
}

async function showConnectorCards(items: ConnectorRequest[]): Promise<void> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, items, resumeKey: randomUUID() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(String(body.error ?? `could not show connection card (HTTP ${response.status})`));
  }
}

function fittedList(frame: Json): Json {
  if (!SCHEMA_PROFILE || !("result" in frame)) return frame;
  return { ...frame, result: fitToolListResult(frame.result, SCHEMA_PROFILE, (line) => process.stderr.write(`connector-proxy: ${line}\n`)) };
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  // OpenCode and other MCP clients mark a stdio server failed unless initialize returns capabilities and serverInfo.
  if (method === "notifications/initialized" || method === "initialized") {
    if (UPSTREAM) void relay(message).catch(() => {});
    return;
  }
  if (method === "initialize") {
    if (UPSTREAM) {
      try {
        // A stalled provider must never keep the local MCP client from mounting the connector tools.
        await relay(message, INITIALIZE_RELAY_TIMEOUT_MS);
      } catch {
      }
    }
    if (id !== undefined) {
      const params = (message.params ?? {}) as Json;
      send(initializeResult(id, params.protocolVersion));
    }
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    const { requests, badAuthConfig } = /MANAGE_CONNECTIONS$/i.test(name)
      ? connectorAdds(params.arguments)
      : { requests: [], badAuthConfig: false };
    if (badAuthConfig) {
      send(textResult(id, BAD_AUTH_CONFIG_ID, true));
      return;
    }
    if (requests.length) {
      await showConnectorCards(requests);
      const labels = requests.map((r) => (r.alias ? `${r.slug} (${r.alias})` : r.slug)).join(", ");
      send(textResult(
        id,
        `OpenMausBot showed the user a secure connection card for ${labels}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "OpenMausBot is handling connection completion and will continue the task automatically."));
      return;
    }
  }
  try {
    // The engine lists tools once per session, so one failed listing would leave the whole session without them.
    const response = method === "tools/list"
      ? await relay(message).catch(() => delay(TOOLS_LIST_RETRY_MS).then(() => relay(message)))
      : await relay(message);
    if (response && id !== undefined) {
      send(method === "tools/list" ? fittedList(ALLOWED_TOOLS ? filterToolsListFrame(response, ALLOWED_TOOLS, SERVICE_SLUGS) : response)
        : method === "tools/call" ? withSignedOutHint(message, response, SERVICE_SLUGS) : response);
    }
  } catch (error) {
    if (id === undefined) return;
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(id, messageText, true));
    else send(jsonRpcError(id, messageText));
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Json;
  try {
    message = JSON.parse(trimmed) as Json;
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    if (message.id === undefined) return;
    const method = String(message.method ?? "");
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(message.id, messageText, true));
    else send(jsonRpcError(message.id, messageText));
  });
});
input.on("close", () => process.exit(0));
