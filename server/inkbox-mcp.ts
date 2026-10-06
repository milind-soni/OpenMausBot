import { randomUUID } from "node:crypto";

export interface InkboxToolConnection { identityId: string; apiKey: string; binding: string }
interface Options { connection(botId: string): InkboxToolConnection | null; fetch?: typeof fetch }
interface Context { botId: string; binding: string; assertActive(): void;
  approve(input: { tool: string; arguments: Record<string, unknown> }): Promise<boolean>; signal?: AbortSignal }
type ObjectValue = Record<string, unknown>;
interface Session { id?: string; protocol: string; initialized: boolean; starting?: Promise<void>; tools?: ObjectValue[]; resources: Set<string> }
const ENDPOINT = "https://inkbox.ai/mcp";
const MAX_INPUT = 1_048_576;
const MAX_OUTPUT = 4_194_304;
const RESOURCE_TOOL = "inkbox_resource_read";
const RESOURCE_TOOL_DEFINITION = { name: RESOURCE_TOOL,
  description: "Read an exact protected inkbox:// resource URI returned by another Inkbox tool. Text and images are returned directly; other files are bounded base64 bytes, not parsed documents.",
  inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } };
function resourceUri(value: unknown, identityId: string): value is string {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("inkbox://") || /\s/.test(value) ||
      Array.from(value).some(char => char.charCodeAt(0) < 32)) return false;
  try {
    const uri = new URL(value), actors = uri.searchParams.getAll("acting_identity_id");
    return uri.protocol === "inkbox:" && !!uri.hostname && !uri.username && !uri.password && !uri.hash &&
      (actors.length === 0 || (actors.length === 1 && actors[0] === identityId));
  } catch { return false; }
}
function grantResources(result: unknown, session: Session, identityId: string): void {
  if (object(result)?.isError === true) return;
  const grant = (uri: unknown) => {
    if (!resourceUri(uri, identityId)) return;
    if (session.resources.size >= 256 && !session.resources.has(uri)) session.resources.delete(session.resources.values().next().value!);
    session.resources.add(uri);
  };
  // Only typed protocol resource blocks carry authority. Text (even valid
  // result-shaped JSON) and structuredContent may be participant-authored.
  const root = object(result); if (!root) return;
  if (Array.isArray(root.content)) for (const value of root.content) {
    const row = object(value); if (!row) continue;
    if (row.type === "resource_link") grant(row.uri);
    if (row.type === "resource") grant(object(row.resource)?.uri);
  }
}
function resourceToolResult(value: unknown): ObjectValue {
  const result = object(value);
  if (!Array.isArray(result?.contents)) throw reject("Inkbox returned invalid resource contents.");
  return { content: result.contents.map(item => {
    const row = object(item);
    if (!row || typeof row.uri !== "string") throw reject("Inkbox returned invalid resource contents.");
    if (typeof row.text === "string") return { type: "text", text: row.text };
    if (typeof row.blob !== "string") throw reject("Inkbox returned invalid resource contents.");
    if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(row.mimeType))) return { type: "image", mimeType: row.mimeType, data: row.blob };
    return { type: "text", text: "Unparsed binary file; base64 bytes require a compatible document reader. " + JSON.stringify(row) };
  }) };
}
function readableToolLinks(value: unknown): unknown {
  const row = object(value);
  if (!Array.isArray(row?.content)) return value;
  return { ...row, content: row.content.map(item => {
    const entry = object(item);
    if (entry?.type !== "resource_link" && entry?.type !== "resource") return item;
    return { type: "text", text: "Protected resource metadata (not parsed file content). Use inkbox_resource_read with the exact issued Inkbox URI: " + JSON.stringify(entry) };
  }) };
}
// Reviewed, documented reads only. Unknown/new tools always need a person's
// decision, irrespective of the provider's advisory readOnlyHint or suffix.
const READ_TOOLS = new Set([
  "inkbox_identity_get", "inkbox_channel_status_get", "inkbox_conversations_list", "inkbox_conversation_get",
  "inkbox_slack_connections_list", "inkbox_slack_channels_list", "inkbox_slack_conversation_members_list",
  "inkbox_slack_messages_search", "inkbox_slack_message_get", "inkbox_slack_users_list", "inkbox_slack_user_get",
  "inkbox_slack_file_get", "inkbox_a2a_agents_list",
]);
export function inkboxToolNeedsApproval(name: string): boolean { return !READ_TOOLS.has(name); }
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const failure = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
const reject = (text: string) => Object.assign(new Error(text), { status: 409 });
function scrub(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(secret).join("[REDACTED]");
  if (Array.isArray(value)) return value.map(item => scrub(item, secret));
  if (object(value)) return Object.fromEntries(Object.entries(value as ObjectValue).map(([name, item]) => [name.split(secret).join("[REDACTED]"), scrub(item, secret)]));
  return value;
}
function rpcResult(value: unknown, id: string): unknown {
  const frame = object(value);
  if (!frame || frame.jsonrpc !== "2.0" || frame.id !== id || Object.hasOwn(frame, "method") || !Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")) {
    throw reject("Inkbox returned an invalid or rejected tool response. Check the action's status before retrying.");
  }
  return frame.result;
}
async function boundedResult(response: Response, id: string): Promise<unknown> {
  if (!response.body) throw reject("Inkbox returned an empty response.");
  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  if (contentType !== "application/json" && contentType !== "text/event-stream") throw reject("Inkbox returned an unsupported response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OUTPUT) throw reject("Inkbox response exceeded the size limit.");
      buffer += decoder.decode(value, { stream: true });
      if (contentType === "text/event-stream") {
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          const frame = object(JSON.parse(data));
          // Progress notifications are not results; never execute a provider
          // request (sampling, elicitation, roots, or anything else).
          if (frame && !Object.hasOwn(frame, "id") && typeof frame.method === "string") continue;
          return rpcResult(frame, id);
        }
      }
    }
    buffer += decoder.decode();
    if (contentType === "text/event-stream") throw reject("Inkbox stream ended without its response.");
    return rpcResult(JSON.parse(buffer), id);
  } finally { await reader.cancel().catch(() => {}); }
}

/** Credentials and resource grants remain in the host. All RPCs use the fixed
 * provider endpoint. This relay never retries a request. */
export class InkboxMcpRelay {
  private readonly options: Options;
  private readonly sessions = new Map<string, Session>();
  constructor(options: Options) { this.options = options; }
  async request(input: unknown, context: Context): Promise<unknown> {
    const raw = JSON.stringify(input);
    if (!raw || Buffer.byteLength(raw) > MAX_INPUT) throw reject("Inkbox request exceeded the size limit.");
    const frame = object(JSON.parse(raw));
    if (!frame || (frame.method !== "tools/list" && frame.method !== "tools/call" && frame.method !== "resources/read" && frame.method !== "resources/list")) throw reject("Unsupported Inkbox method.");
    const params = frame.params === undefined ? {} : object(frame.params);
    if (!params) throw reject("Invalid Inkbox parameters.");
    const connection = this.options.connection(context.botId);
    const check = () => {
      context.assertActive();
      context.signal?.throwIfAborted();
      const current = this.options.connection(context.botId);
      if (!connection || !current || !connection.apiKey || /[\r\n]/.test(connection.apiKey) || current.binding !== context.binding ||
          current.binding !== connection.binding || current.identityId !== connection.identityId || current.apiKey !== connection.apiKey) {
        throw reject("The Inkbox connection changed. Start a new bot turn.");
      }
    };
    check();
    const args = params.arguments === undefined ? {} : object(params.arguments);
    if (frame.method === "tools/call" && (!args || typeof params.name !== "string" || !/^inkbox_[a-z0-9_]{1,100}$/.test(params.name))) {
      throw reject("Invalid Inkbox tool call.");
    }
    if (args && args.acting_identity_id !== undefined && args.acting_identity_id !== connection!.identityId) {
      throw reject("This Inkbox capability cannot act as another identity.");
    }
    let session = this.sessions.get(connection!.binding);
    if (!session) {
      if (this.sessions.size >= 8) this.sessions.delete(this.sessions.keys().next().value!);
      session = { protocol: "2025-03-26", initialized: false, resources: new Set() };
      this.sessions.set(connection!.binding, session);
    }
    // Native clients may enumerate only links already issued to this binding.
    // No upstream resource discovery is needed or authorized by this list.
    if (frame.method === "resources/list") return { resources: [...session.resources].map(uri => ({ uri, name: uri })) };
    const readUri = frame.method === "resources/read" ? params.uri : params.name === RESOURCE_TOOL ? args?.uri : undefined;
    const isResourceRead = frame.method === "resources/read" || params.name === RESOURCE_TOOL;
    if (isResourceRead && (!resourceUri(readUri, connection!.identityId) || !session.resources.has(readUri))) {
      throw reject("This Inkbox resource was not issued for the current connection.");
    }
    const request = async (method: string, parameters: ObjectValue, notification = false): Promise<unknown> => {
      check();
      const id = randomUUID();
      let result: unknown;
      try {
        const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "X-API-Key": connection!.apiKey,
          "MCP-Protocol-Version": session.protocol, ...(session.id ? { "Mcp-Session-Id": session.id } : {}) };
        const response = await (this.options.fetch ?? fetch)(ENDPOINT, { method: "POST", redirect: "error", headers,
          body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params: parameters }),
          signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(context.signal ? [context.signal] : [])]) });
        if (!response.ok || response.redirected) { await response.body?.cancel(); throw reject("Inkbox rejected this request."); }
        if (method === "initialize") {
          const token = response.headers.get("mcp-session-id");
          if (token && (!/^[\x21-\x7e]{1,256}$/.test(token))) { await response.body?.cancel(); throw reject("Inkbox returned an invalid session."); }
          session.id = token ?? undefined;
        }
        if (notification) { await response.body?.cancel(); result = {}; }
        else result = await boundedResult(response, id);
      } catch {
        if (this.sessions.get(connection!.binding) === session) this.sessions.delete(connection!.binding);
        // No upstream error text, key, URL or response body crosses into the
        // model. A failed write may already have happened; never replay it.
        throw reject(method === "tools/call"
          ? "Inkbox did not confirm this action; its outcome may be uncertain. Inspect its status before trying again. Do not resend automatically."
          : "Inkbox could not return a valid response. Check the connection and start a new turn.");
      }
      check();
      return scrub(result, connection!.apiKey);
    };
    if (!session.initialized) {
      if (!session.starting) session.starting = (async () => {
        const initialized = object(await request("initialize", { protocolVersion: session.protocol, capabilities: {}, clientInfo: { name: "OpenMausBot", version: "1" } }));
        const version = initialized?.protocolVersion;
        if (typeof version !== "string" || !["2024-11-05", "2025-03-26", "2025-06-18"].includes(version)) throw reject("Inkbox negotiated an unsupported protocol.");
        session.protocol = version;
        await request("notifications/initialized", {}, true);
        session.initialized = true;
      })().finally(() => { session.starting = undefined; });
      await session.starting;
      check();
    }
    if (isResourceRead) {
      const result = await request("resources/read", { uri: readUri });
      const contents = object(result)?.contents;
      if (!Array.isArray(contents) || !contents.length || contents.some(item => {
        const row = object(item);
        return !row || row.uri !== readUri || (typeof row.text !== "string" && typeof row.blob !== "string");
      })) throw reject("Inkbox returned invalid resource contents.");
      grantResources(result, session, connection!.identityId);
      return frame.method === "resources/read" ? result : resourceToolResult(result);
    }
    if (frame.method === "tools/list" || !session.tools) {
      // Aggregate bounded pages so a model can call every advertised tool.
      const catalog: ObjectValue[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const page = object(await request("tools/list", cursor ? { cursor } : {}));
        if (!page || !Array.isArray(page.tools)) throw reject("Inkbox returned an invalid tool catalog.");
        for (const value of page.tools) {
          const tool = object(value);
          if (!tool || typeof tool.name !== "string" || !/^inkbox_[a-z0-9_]{1,100}$/.test(tool.name) || !object(tool.inputSchema) || tool.name === RESOURCE_TOOL || catalog.some(row => row.name === tool.name)) throw reject("Inkbox returned an invalid tool catalog.");
          const read = !inkboxToolNeedsApproval(tool.name);
          catalog.push({ name: tool.name, ...(typeof tool.title === "string" ? { title: tool.title.slice(0, 200) } : {}),
            ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 12000) } : {}), inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: read, destructiveHint: !read, idempotentHint: read, openWorldHint: true } });
        }
        if (catalog.length > 512 || Buffer.byteLength(JSON.stringify(catalog)) > MAX_OUTPUT) throw reject("Inkbox tool catalog exceeded the size limit.");
        if (!page.nextCursor) break;
        if (typeof page.nextCursor !== "string" || page.nextCursor.length > 2000 || cursors.has(page.nextCursor) || cursors.size >= 15) throw reject("Inkbox catalog pagination is invalid.");
        cursor = page.nextCursor; cursors.add(cursor);
      }
      session.tools = catalog;
    }
    check();
    if (frame.method === "tools/list") return { tools: [...session.tools, RESOURCE_TOOL_DEFINITION] };
    const name = params.name as string;
    if (!session.tools.some(tool => tool.name === name)) throw reject("That Inkbox tool is not available in this connection.");
    if (inkboxToolNeedsApproval(name)) {
      const approved = await context.approve({ tool: name, arguments: structuredClone(args!) });
      check();
      if (!approved) return failure("The person declined this Inkbox action. It was not sent. Do not retry without a new instruction.");
    }
    const result = await request("tools/call", { name, arguments: args! });
    grantResources(result, session, connection!.identityId);
    return readableToolLinks(result);
  }
}
