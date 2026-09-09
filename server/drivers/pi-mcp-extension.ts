// pi-mcp-extension — the Pi-side half of "hands" for the pi engine.
//
// Pi core deliberately ships no MCP client (see pi's docs: "does not include
// built-in MCP"). This extension is that client: loaded into the per-turn
// `pi --mode rpc --no-session` process via `-e`, it reads a JSON file whose
// path is handed in through OMB_MCP_CONFIG and mounts every server described
// there as first-class pi tools (pi.registerTool). OpenMausBot ships this file
// and the pi driver spawns it — the pi repo itself is never touched.
//
// Protocol: the OpenMausBot proxies speak raw JSON-RPC 2.0 over stdio, one
// frame per line (no MCP SDK, no Content-Length framing) — see
// server/mcp-bridge.ts and server/drivers/agents-proxy.ts. This client matches
// that exactly.
import { Type, type TObjectOptions, type TSchema, type TSchemaOptions } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";

interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** "local-computer" marks the user's real host desktop: every tool on such
   * a server is gated behind a permission card before it executes. */
  scope?: string;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerDef>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpTextContent {
  type: "text";
  text: unknown;
}

interface McpImageContent {
  type: "image";
  data: unknown;
  mimeType: unknown;
}

type PiToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface PiToolContext {
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
  };
}

interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: PiToolContext,
  ): Promise<{ content: PiToolContent[]; details: Record<string, never> }>;
}

/** Structural slice of Pi 0.84's ExtensionAPI used by this standalone file.
 * Keeping it local avoids bundling Pi into OpenMausBot; the extension is
 * loaded by the user's installed Pi, which supplies the real implementation. */
interface PiExtensionApi {
  registerTool(definition: PiToolDefinition): void;
  on(event: "session_shutdown", handler: () => void): void;
}

const MCP_STARTUP_TIMEOUT_MS = 8_000;
const MCP_TOOL_TIMEOUT_MS = 10 * 60_000;
const MCP_MAX_LIST_PAGES = 100;
const MCP_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
const TOOL_OUTPUT_MAX_LINES = 2_000;
const TOOL_NAME_MAX_LENGTH = 64;

/** A minimal stdio JSON-RPC 2.0 MCP client, matched to OpenMausBot's
 * newline-delimited house protocol. */
export class StdioMcp {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private disposed = false;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(def: McpServerDef) {
    this.child = spawn(def.command, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...def.env },
    });
    this.child.stderr.on("data", () => {
      /* best-effort drain so a chatty server never blocks */
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (err) => this.closeWithError(err));
    // A server that starts and then dies emits `exit`, never `error`; without
    // settling on it, an in-flight init/listTools would hang the extension
    // load for the whole turn.
    this.child.on("exit", (code) => this.closeWithError(new Error(`MCP server exited (code ${code ?? "?"})`)));
    // A write to a dead child errors asynchronously on the stream; an
    // unhandled stream error would kill the pi process (the same hazard
    // spawnCli documents for driver-spawned children in procs.ts).
    this.child.stdin.on("error", () => this.closeWithError(new Error("MCP server stdin closed")));
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private closeWithError(err: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(err);
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MCP_MAX_FRAME_BYTES) {
        this.closeWithError(new Error(`MCP frame exceeded ${MCP_MAX_FRAME_BYTES} bytes`));
        return;
      }
      let msg: { id?: unknown; method?: unknown; error?: { message?: string }; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
        else p.resolve(msg.result);
        continue;
      }
      // This minimal client does not implement server→client requests. Reply
      // explicitly instead of leaving a conforming server waiting forever.
      if (msg.id !== undefined && typeof msg.method === "string") {
        try {
          this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Client method not supported" } });
        } catch (err) {
          this.closeWithError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
      // Notifications (e.g. notifications/tools/list_changed) are intentionally
      // ignored for this single-shot mount.
    }
    if (Buffer.byteLength(this.buf, "utf8") > MCP_MAX_FRAME_BYTES) {
      this.closeWithError(new Error(`MCP frame exceeded ${MCP_MAX_FRAME_BYTES} bytes without a newline`));
    }
  }

  private write(frame: unknown): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("MCP server stdin is closed");
    }
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private call(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("MCP client is closed"));
    if (signal?.aborted) return Promise.reject(new Error(`MCP ${method} aborted`));

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const cancel = (reason: string) => {
        this.pending.delete(id);
        try {
          this.notify("notifications/cancelled", { requestId: id, reason });
        } catch {
          /* the transport may already be gone */
        }
        settle(() => reject(new Error(reason)));
      };
      const onAbort = () => cancel(`MCP ${method} aborted`);
      const timer = setTimeout(() => cancel(`MCP ${method} timed out after ${timeoutMs}ms`), timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (err) => settle(() => reject(err)),
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async init(): Promise<void> {
    await this.call(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openmausbot-pi", version: "1" },
      },
      MCP_STARTUP_TIMEOUT_MS,
    );
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const seenCursors = new Set<string>();
    const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;
    let cursor: string | undefined;
    for (let page = 0; page < MCP_MAX_LIST_PAGES; page += 1) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const res = (await this.call(
        "tools/list",
        cursor ? { cursor } : {},
        remainingMs,
      )) as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (!Array.isArray(res?.tools)) throw new Error("MCP tools/list returned no tools array");
      tools.push(...(res.tools as McpTool[]));
      if (typeof res.nextCursor !== "string" || !res.nextCursor) return tools;
      if (seenCursors.has(res.nextCursor)) throw new Error("MCP tools/list repeated a pagination cursor");
      seenCursors.add(res.nextCursor);
      cursor = res.nextCursor;
    }
    throw new Error(`MCP tools/list exceeded ${MCP_MAX_LIST_PAGES} pages`);
  }

  /** tools/call → Pi content, preserving screenshots and bounding text so a
   * remote server cannot flood the model context. */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ content: PiToolContent[]; isError: boolean }> {
    const res = (await this.call(
      "tools/call",
      { name, arguments: args ?? {} },
      MCP_TOOL_TIMEOUT_MS,
      signal,
    )) as { content?: unknown; isError?: boolean } | undefined;
    const rawContent = Array.isArray(res?.content) ? res.content : [];
    const text = rawContent
      .filter((c): c is McpTextContent => Boolean(c) && (c as { type?: unknown }).type === "text")
      .map((c) => String(c.text ?? ""))
      .join("\n");
    const images = rawContent
      .filter(
        (c): c is McpImageContent =>
          Boolean(c) &&
          (c as { type?: unknown }).type === "image" &&
          typeof (c as McpImageContent).data === "string" &&
          typeof (c as McpImageContent).mimeType === "string",
      )
      .map((c) => ({ type: "image" as const, data: String(c.data), mimeType: String(c.mimeType) }));
    const unsupported = rawContent.length - rawContent.filter((c) => (c as { type?: unknown })?.type === "text").length - images.length;
    let boundedText = truncateToolText(text || (images.length ? "" : "(empty result)"));
    if (unsupported > 0) boundedText += `${boundedText ? "\n" : ""}[${unsupported} unsupported MCP content item(s) omitted]`;
    return {
      content: [...(boundedText ? [{ type: "text" as const, text: boundedText }] : []), ...images],
      isError: Boolean(res?.isError),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("MCP client disposed"));
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

interface JsonSchema {
  type?: string | string[];
  title?: unknown;
  description?: unknown;
  default?: unknown;
  const?: unknown;
  enum?: unknown[];
  nullable?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
  items?: unknown | unknown[];
  prefixItems?: unknown[];
  properties?: Record<string, unknown>;
  required?: unknown;
  additionalProperties?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  multipleOf?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
  format?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  uniqueItems?: unknown;
  minProperties?: unknown;
  maxProperties?: unknown;
}

const SCHEMA_OPTION_KEYS = [
  "title",
  "description",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

function schemaOptions(schema: JsonSchema): TSchemaOptions {
  const options: TSchemaOptions = {};
  for (const key of SCHEMA_OPTION_KEYS) {
    const value = schema[key];
    if (value !== undefined) Reflect.set(options, key, value);
  }
  return options;
}

function isSchemaObject(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function primitiveLiteral(value: unknown): TSchema | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Type.Literal(value);
  }
  if (value === null) return Type.Null();
  return null;
}

function withNullable(schema: TSchema, nullable: unknown): TSchema {
  return nullable === true ? Type.Union([schema, Type.Null()]) : schema;
}

function collectObjectShape(schema: JsonSchema): { properties: Record<string, unknown>; required: Set<string> } {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  const visit = (candidate: unknown, mode: "root" | "all" | "choice") => {
    if (!isSchemaObject(candidate)) return;
    for (const branch of candidate.allOf ?? []) visit(branch, mode === "choice" ? "choice" : "all");
    for (const branch of [...(candidate.anyOf ?? []), ...(candidate.oneOf ?? [])]) visit(branch, "choice");
    for (const [key, value] of Object.entries(candidate.properties ?? {})) {
      // The root declaration is authoritative; branch-only properties are
      // still retained so the model knows which arguments exist.
      if (mode === "root" || properties[key] === undefined) properties[key] = value;
    }
    if (mode !== "choice" && Array.isArray(candidate.required)) {
      for (const key of candidate.required) if (typeof key === "string") required.add(key);
    }
  };

  visit(schema, "root");
  return { properties, required };
}

function objectSchema(schema: JsonSchema, root = false): TSchema {
  const { properties, required } = collectObjectShape(schema);
  const converted: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    const nested = nestedTypebox(value);
    converted[key] = required.has(key) ? nested : Type.Optional(nested);
  }
  const options: TObjectOptions = schemaOptions(schema);
  if (typeof schema.additionalProperties === "boolean") {
    options.additionalProperties = schema.additionalProperties;
  } else if (isSchemaObject(schema.additionalProperties)) {
    options.additionalProperties = nestedTypebox(schema.additionalProperties);
  }
  const object = Type.Object(converted, options);
  return root ? object : withNullable(object, schema.nullable);
}

function nestedTypebox(schema: unknown): TSchema {
  if (!isSchemaObject(schema)) return Type.Any();
  const options = schemaOptions(schema);

  const literal = primitiveLiteral(schema.const);
  if (literal) return withNullable(literal, schema.nullable);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.every((value) => typeof value === "string")) {
      // `{type:"string", enum:[...]}` works across Google/OpenAI/Anthropic;
      // Type.Union(Type.Literal(...)) does not work with Google's tool API.
      return withNullable(Type.String({ ...options, enum: schema.enum }), schema.nullable);
    }
    const literals = schema.enum.map(primitiveLiteral).filter((value): value is TSchema => value !== null);
    if (literals.length === schema.enum.length) {
      const union = literals.length === 1 ? literals[0] : Type.Union(literals, options);
      return withNullable(union, schema.nullable);
    }
  }

  if (Array.isArray(schema.type)) {
    const variants = schema.type.map((type) => nestedTypebox({ ...schema, type, nullable: false }));
    return variants.length === 1 ? variants[0] : Type.Union(variants, options);
  }

  if (schema.type === "object" || schema.properties) return objectSchema(schema);

  const choice = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(choice) && choice.length > 0) {
    const variants = choice.map(nestedTypebox);
    return withNullable(variants.length === 1 ? variants[0] : Type.Union(variants, options), schema.nullable);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const variants = schema.allOf.map(nestedTypebox);
    return withNullable(variants.length === 1 ? variants[0] : Type.Intersect(variants, options), schema.nullable);
  }

  switch (schema.type) {
    case "string":
      return withNullable(Type.String(options), schema.nullable);
    case "number":
      return withNullable(Type.Number(options), schema.nullable);
    case "integer":
      return withNullable(Type.Integer(options), schema.nullable);
    case "boolean":
      return withNullable(Type.Boolean(options), schema.nullable);
    case "null":
      return Type.Null();
    case "array": {
      const tupleItems = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined);
      const value = tupleItems
        ? Type.Tuple(tupleItems.map(nestedTypebox), options)
        : Type.Array(schema.items ? nestedTypebox(schema.items) : Type.Any(), options);
      return withNullable(value, schema.nullable);
    }
    default:
      return Type.Any();
  }
}

/** Best-effort JSON Schema → TypeBox. MCP tool parameters must always expose
 * an object at the root; Pi/provider tool serialization rejects a root schema
 * without `type: "object"`. Nested schemas retain unions, nullability and
 * constraints instead of being incorrectly rewritten as objects. */
export function toTypebox(schema: unknown): TSchema {
  return objectSchema(isSchemaObject(schema) ? schema : {}, true);
}

/** pi tool names are lowercase snake identifiers; MCP tool names are not
 * (COMPOSIO_SEARCH_TOOLS, browser_navigate, mcp__x…). Normalize and prefix
 * with the server so two servers can never collide. */
function sanitizeToolName(server: string, tool: string): string {
  const raw = `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return raw.slice(0, TOOL_NAME_MAX_LENGTH) || "mcp_tool";
}

export function allocateToolName(server: string, tool: string, used: Set<string>): string {
  const base = sanitizeToolName(server, tool);
  let candidate = base;
  for (let suffixNumber = 2; used.has(candidate); suffixNumber += 1) {
    const suffix = `_${suffixNumber}`;
    candidate = `${base.slice(0, Math.max(1, TOOL_NAME_MAX_LENGTH - suffix.length))}${suffix}`;
  }
  return candidate;
}

export function truncateToolText(text: string): string {
  const lines = text.split("\n");
  const lineLimited = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\n");
  const bytes = Buffer.from(lineLimited, "utf8");
  let byteEnd = Math.min(bytes.length, TOOL_OUTPUT_MAX_BYTES);
  // Avoid returning a replacement character when the byte limit lands in the
  // middle of a UTF-8 code point.
  while (byteEnd > 0 && byteEnd < bytes.length && (bytes[byteEnd] & 0xc0) === 0x80) byteEnd -= 1;
  const content = bytes.subarray(0, byteEnd).toString("utf8");
  const truncatedByLines = lines.length > TOOL_OUTPUT_MAX_LINES;
  const truncatedByBytes = bytes.length > TOOL_OUTPUT_MAX_BYTES;
  if (!truncatedByLines && !truncatedByBytes) return content;
  const reasons = [
    ...(truncatedByLines ? [`${TOOL_OUTPUT_MAX_LINES}-line limit`] : []),
    ...(truncatedByBytes ? [`${TOOL_OUTPUT_MAX_BYTES / 1024}KB limit`] : []),
  ];
  return `${content}\n\n[MCP output truncated: ${reasons.join(" and ")}. Refine the request for less output.]`;
}

/** A short human-readable line for the permission card's detail. */
function summarizeParams(params: unknown): string {
  try {
    const s = JSON.stringify(params ?? {});
    return s === "{}" ? "" : s.slice(0, 300);
  } catch {
    return "";
  }
}

export default async function (pi: PiExtensionApi): Promise<void> {
  const configPath = process.env.OMB_MCP_CONFIG;
  if (!configPath) return;

  let config: McpConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as McpConfig;
  } catch {
    return;
  }

  const used = new Set<string>();
  const clients: StdioMcp[] = [];
  const serverEntries = Object.entries(config.mcpServers ?? {});

  // Mount independent servers concurrently so one slow integration cannot
  // consume the startup timeout once per server. Registration remains in
  // config order below for deterministic tool names and collision suffixes.
  const mounts = await Promise.all(
    serverEntries.map(async ([serverName, def]) => {
      if (!def || typeof def.command !== "string" || !def.command.trim()) return { serverName };
      let client: StdioMcp | undefined;
      try {
        client = new StdioMcp(def);
        await client.init();
        return { serverName, def, client, tools: await client.listTools() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[openmausbot-pi-mcp] ${serverName}: ${message}\n`);
        client?.dispose();
        return { serverName };
      }
    }),
  );

  for (const mount of mounts) {
    if (!mount.client || !mount.def || !mount.tools) continue;
    const { serverName, def, client, tools } = mount;
    const gated = def.scope === "local-computer";
    let registered = 0;

    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
        process.stderr.write(`[openmausbot-pi-mcp] ${serverName}: skipped a tool with no valid name\n`);
        continue;
      }
      const toolName = tool.name;
      const name = allocateToolName(serverName, toolName, used);
      try {
        const parameters = toTypebox(tool.inputSchema);
        pi.registerTool({
          name,
          label: `${serverName}:${toolName}`,
          description: typeof tool.description === "string" ? tool.description : `${toolName} (MCP tool from ${serverName})`,
          parameters,
          async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            // Host tools ask first, using pi's native permission card
            // (ctx.ui.confirm → extension_ui_request → Allow/Deny card). This
            // mirrors ACP's session/request_permission and Codex's elicitation.
            if (gated) {
              const detail = summarizeParams(params);
              const allowed = await ctx.ui.confirm(
                `Allow ${toolName} on your computer?`,
                detail || `Run ${serverName}:${toolName}`,
              );
              if (!allowed) {
                return { content: [{ type: "text", text: "Blocked by the user." }], details: {} };
              }
            }
            const res = await client.callTool(toolName, params, signal);
            if (res.isError) {
              const message = res.content
                .filter((item): item is { type: "text"; text: string } => item.type === "text")
                .map((item) => item.text)
                .join("\n");
              // Pi marks a custom tool as failed only when execute throws;
              // returning error-looking text incorrectly produces isError=false.
              throw new Error(message || `MCP tool ${serverName}:${toolName} returned an error`);
            }
            return { content: res.content, details: {} };
          },
        });
        used.add(name);
        registered += 1;
      } catch (err) {
        // One malformed tool must not dispose the client behind tools that
        // were already registered from the same server.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[openmausbot-pi-mcp] ${serverName}:${toolName}: ${message}\n`);
      }
    }

    if (registered > 0) clients.push(client);
    else client.dispose();
  }

  pi.on("session_shutdown", () => {
    for (const c of clients) c.dispose();
    clients.length = 0;
  });
}
