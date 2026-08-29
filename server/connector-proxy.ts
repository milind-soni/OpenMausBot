// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class OpenMausBot chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";

type Json = Record<string, unknown>;

const UPSTREAM = process.env.OMB_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
// Identity is an explicit connector-session setting, never inferred from an
// account alias. Provider is derived only from the closed canonical tool
// family below; unknown families are sent empty and fail closed in the
// harness policy route.
const ACCOUNT_IDENTITY = process.env.OMB_CONNECTOR_IDENTITY?.trim() || "Personal";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const CONNECTOR_POLICY = process.env.OMB_CONNECTOR_POLICY === "read-only"
  ? "read-only"
  : process.env.OMB_CONNECTOR_POLICY === "draft-only"
    ? "draft-only"
    : "execute";
const RESTRICTED = CONNECTOR_POLICY !== "execute";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const READ_ACTIONS = new Set([
  "DESCRIBE", "DOWNLOAD", "FETCH", "FIND", "GET", "INSPECT", "LIST", "LOOKUP", "QUERY", "READ", "RETRIEVE", "SEARCH",
]);
const WRITE_ACTIONS = new Set([
  "ACCEPT", "ADD", "ARCHIVE", "ATTACH", "CANCEL", "COPY", "CREATE", "DECLINE", "DELETE", "DRAFT", "EXECUTE",
  "FORWARD", "GRANT", "INVITE", "MARK", "MODIFY", "MOVE", "PATCH", "PERMISSION", "POST", "PUBLISH", "PUT",
  "REMOVE", "REPLY", "RSVP", "RUN", "SCHEDULE", "SEND", "SHARE", "TRASH", "TRIGGER", "UPDATE", "UPLOAD", "WRITE",
]);
const SAFE_META_TOOLS = new Set(["COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_SEARCH_TOOLS"]);
const GUARDED_EXECUTOR = "COMPOSIO_MULTI_EXECUTE_TOOL";

export function isReadOnlyConnectorTool(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  if (SAFE_META_TOOLS.has(normalized)) return true;
  const tokens = normalized.split(/[^A-Z0-9]+/).filter(Boolean);
  if (tokens.some((token) => WRITE_ACTIONS.has(token))) return false;
  return tokens.some((token) => READ_ACTIONS.has(token));
}

function objectField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Reflect.get(value, key);
}

function guardedToolSlugs(args: unknown): string[] | null {
  const tools = objectField(args, "tools");
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 50) return null;
  const slugs: string[] = [];
  for (const tool of tools) {
    const slug = objectField(tool, "tool_slug");
    if (typeof slug !== "string" || !slug.trim()) return null;
    slugs.push(slug);
  }
  return slugs;
}

function isReadOnlyConnectorCall(name: string, args: unknown): boolean {
  if (name.trim().toUpperCase() !== GUARDED_EXECUTOR) return isReadOnlyConnectorTool(name);
  const slugs = guardedToolSlugs(args);
  return slugs !== null && slugs.every(isReadOnlyConnectorTool);
}

function isDraftConnectorTool(name: string): boolean {
  const tokens = name.trim().toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return tokens.includes("DRAFT") && !tokens.some((token) => ["SEND", "PUBLISH", "POST", "REPLY", "FORWARD"].includes(token));
}

function isAllowedConnectorCall(name: string, args: unknown): boolean {
  if (CONNECTOR_POLICY === "execute") return true;
  if (isReadOnlyConnectorCall(name, args)) return true;
  if (CONNECTOR_POLICY !== "draft-only") return false;
  if (name.trim().toUpperCase() !== GUARDED_EXECUTOR) return isDraftConnectorTool(name);
  const slugs = guardedToolSlugs(args);
  return slugs !== null && slugs.every((slug) => isReadOnlyConnectorTool(slug) || isDraftConnectorTool(slug));
}

function isVisibleReadOnlyTool(name: string): boolean {
  return name.trim().toUpperCase() === GUARDED_EXECUTOR || isReadOnlyConnectorTool(name);
}

function filterRestrictedToolList(response: Json): Json {
  if (!RESTRICTED) return response;
  const result = response.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return response;
  const tools = (result as Json).tools;
  if (!Array.isArray(tools)) return response;
  return {
    ...response,
    result: {
      ...(result as Json),
      tools: tools.filter((tool) => {
        if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
        const name = String((tool as Json).name ?? "");
        return isVisibleReadOnlyTool(name) || (CONNECTOR_POLICY === "draft-only" && isDraftConnectorTool(name));
      }),
    },
  };
}

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

async function relay(message: Json): Promise<Json | null> {
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
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) throw new Error(`connector service returned HTTP ${response.status}`);
  return parseUpstream(await readBounded(response), message.id);
}

function connectorAdds(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return [];
  return [...new Set(toolkits.flatMap((item) => {
    if (typeof item === "string") return [item.toLowerCase()];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown };
    const slug = typeof row.toolkit === "string" ? row.toolkit : row.name;
    const action = String(row.action ?? "add").toLowerCase();
    return typeof slug === "string" && ["add", "connect", "initiate"].includes(action) ? [slug.toLowerCase()] : [];
  }))];
}

async function showConnectorCards(slugs: string[]): Promise<void> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, slugs, resumeKey: randomUUID() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(String(body.error ?? `could not show connection card (HTTP ${response.status})`));
  }
}

interface AuthorizedConnectorAction {
  readonly proposalId: string;
  readonly workId: string;
}

const authorizeConnectorResponseSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("allow"), proposalId: z.string().min(1), workId: z.string().min(1) }),
  z.object({ decision: z.literal("deny"), error: z.string().optional() }),
]);

async function authorizeConnectorCall(name: string, args: unknown): Promise<AuthorizedConnectorAction> {
  const response = await fetch(`${HARNESS}/api/internal/action-policy/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      botId: BOT_ID,
      threadId: THREAD_ID,
      name,
      arguments: args,
      identity: ACCOUNT_IDENTITY,
      provider: providerForTool(name, args),
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const parsed = authorizeConnectorResponseSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success || parsed.data.decision === "deny") {
    const error = parsed.success && parsed.data.decision === "deny" ? parsed.data.error : undefined;
    throw new Error(error ?? "This connected-app action was not authorized.");
  }
  return { proposalId: parsed.data.proposalId, workId: parsed.data.workId };
}

function providerForTool(name: string, args: unknown): string {
  const normalized = name.trim().toUpperCase();
  const nested = normalized === GUARDED_EXECUTOR ? objectField(args, "tools") : undefined;
  const first = Array.isArray(nested) ? nested[0] : undefined;
  const toolName = first && typeof first === "object" && !Array.isArray(first)
    ? String(objectField(first, "tool_slug") ?? objectField(first, "name") ?? "")
    : normalized;
  if (toolName.startsWith("GMAIL_")) return "gmail";
  if (toolName.startsWith("GOOGLECALENDAR_")) return "calendar";
  if (toolName.startsWith("GOOGLEDRIVE_")) return "drive";
  if (toolName.startsWith("GITHUB_")) return "github";
  return "";
}

async function reportConnectorResult(action: AuthorizedConnectorAction, response: Json | null): Promise<void> {
  const serialized = JSON.stringify(response ?? null);
  const receiptHash = createHash("sha256").update(serialized, "utf8").digest("hex");
  const failed = response === null || response.error !== undefined || objectField(response.result, "isError") === true;
  await fetch(`${HARNESS}/api/internal/action-policy/result`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      botId: BOT_ID,
      threadId: THREAD_ID,
      proposalId: action.proposalId,
      workId: action.workId,
      ok: !failed,
      receiptHash,
      reference: `connector-receipt:sha256:${receiptHash}`,
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  let authorizedAction: AuthorizedConnectorAction | null = null;
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    if (RESTRICTED && !isAllowedConnectorCall(name, params.arguments)) {
      const rule = CONNECTOR_POLICY === "read-only" ? "blocked non-read tool" : "blocked non-read/non-draft tool";
      send(textResult(id, `Task connected-app policy (${CONNECTOR_POLICY}) ${rule}: ${name || "unknown"}.`, true));
      return;
    }
    const slugs = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    if (slugs.length) {
      await showConnectorCards(slugs);
      send(textResult(
        id,
        `OpenMausBot showed the user a secure connection card for ${slugs.join(", ")}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "OpenMausBot is handling connection completion and will continue the task automatically."));
      return;
    }
    if (!isReadOnlyConnectorCall(name, params.arguments)) {
      authorizedAction = await authorizeConnectorCall(name, params.arguments);
    }
  }
  const response = await relay(message);
  if (authorizedAction) await reportConnectorResult(authorizedAction, response);
  if (response && id !== undefined) send(method === "tools/list" ? filterRestrictedToolList(response) : response);
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
    if (message.id !== undefined) {
      send(textResult(message.id, error instanceof Error ? error.message : String(error), true));
    }
  });
});
input.on("close", () => process.exit(0));
