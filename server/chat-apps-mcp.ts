import { approvalModeFor } from "../shared/approval-mode.ts";
import { APP_LIMITS, APP_MIME, appBlockedText, mcpAppFallbackText, oneLine, type AppBlockedReason, type AppCan, type AppDocument, type AppPayload, type AppToolResult } from "../shared/app.ts";
import { mcpAppNetwork } from "../shared/app-frame/csp.ts";
import { allowsTool, canUseMcpServer } from "../shared/tool-scope.ts";
import { rowRate, type ChatApps } from "./chat-apps.ts";
import type { AgentCardResult } from "./chat-widgets.ts";
import type { McpServerSpec } from "./contracts.ts";
import { McpAppCatalog, mcpServerConfigHash } from "./mcp-app-catalog.ts";
import { AppConnections } from "./mcp-app-connections.ts";
import { toolUiResource, toolVisibility, uiMeta } from "./mcp-app-observer.ts";
import { McpHttpError, McpRpcError } from "./mcp-http.ts";
import type { McpOAuthManager } from "./mcp-oauth.ts";
import { withMcpSignIn } from "./mcp-oauth.ts";
import { probeMcpServer, type McpProbeOptions } from "./mcp-probe.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type StoredMcpServer } from "./mcp-registry.ts";
import { lenientToolValidator, schemaProblems } from "./mcp-schema-validator.ts";
import { redactSecretsInText } from "./redact.ts";
import type { McpRpcAnswer, McpRpcRequest } from "./routes/chat-apps.ts";
import type { BotRecord, Message, Store } from "./store.ts";

export const APP_RESOURCE_CACHE_MS = 10 * 60_000;
const STARTUP_PROBE_DELAY_MS = 20_000;
const RPC_CALL_MS = 120_000;
const RPC_OTHER_MS = 30_000;
const REMOTE_ERROR_CHARS = 1_000;
/** A command server started through `npx` may first have to fetch its package. */
const BACKGROUND_PROBE_MS = 45_000;
const AUTOMATIC_PROBE_EVERY_MS = 10 * 60_000;
/** An app's change outside Full access: declined, with no card of our own. */
export const APP_WRITE_DECLINED = "This bot asks before it changes anything, so its apps can only look. Ask the bot to make the change, or set it to Full access.";

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type ChatAppsMcpStore = Pick<Store, "bot" | "botByThread" | "groupByThread" | "messagesFor" | "appendMessage" | "patchMessage" | "projectBotForTask">;

export type ChatAppsMcpOAuth = Pick<McpOAuthManager, "authState" | "accessToken">;

export interface ChatAppsMcpDeps {
  store: ChatAppsMcpStore;
  apps: ChatApps;
  storedServers(): Record<string, unknown>;
  mountedServers(bot: BotRecord): Record<string, McpServerSpec>;
  personMcp?(): readonly string[];
  oauth: ChatAppsMcpOAuth;
  dataDir?: string;
  catalog?: McpAppCatalog;
  connections?: AppConnections;
  probe?: typeof probeMcpServer;
  startupProbes?: boolean;
  log?(line: string): void;
  now?(): number;
}

export interface McpAppCallArgs {
  bot: { id: string; name: string };
  threadId: string;
  input: Record<string, unknown>;
  authored?(messageId: string): void;
}

export interface ChatAppsMcp {
  readonly catalog: McpAppCatalog;
  readonly connections: AppConnections;
  recordMcpAppCall(args: McpAppCallArgs): Promise<AgentCardResult>;
  access(row: Message & { app: AppPayload }, threadId: string): { can: AppCan; blocked?: AppDocument["blocked"] };
  rpc(request: McpRpcRequest): Promise<McpRpcAnswer>;
  turnMounts(custom: Record<string, McpServerSpec>, toolScope?: unknown): { mcpApps?: Record<string, { extension: boolean }> };
  hasApps(name: string): boolean | undefined;
  probeOptions(name: string, server: StoredMcpServer): McpProbeOptions;
  serverChanged(name: string): void;
  forgetServer(name: string): void;
  close(): void;
}

function storedServer(name: string, raw: unknown): StoredMcpServer | null {
  if (raw === undefined) return null;
  const parsed = parseStoredMcpServer(name, raw);
  return parsed.ok ? parsed.server : null;
}

function loopbackServer(server: McpServerSpec): boolean {
  if (!("url" in server)) return true;
  try {
    const host = new URL(server.url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch { return false; }
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

type ResourceRead =
  | { ok: true; html: string; ui: Json | undefined }
  | { ok: false; reason: AppBlockedReason };

const rpcError = (status: number, code: number, message: string, extra: Json = {}): McpRpcAnswer => ({ status, body: { error: { code, message }, ...extra } });

export function createChatAppsMcp(deps: ChatAppsMcpDeps): ChatAppsMcp {
  const { store, apps } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(`chat apps: ${line}`));
  const catalog = deps.catalog ?? new McpAppCatalog(deps.dataDir ? `${deps.dataDir}/mcp-app-catalog.json` : null);
  const connections = deps.connections ?? new AppConnections({
    onTools: (name, server, tools, extensions) => {
      if (storedServer(name, deps.storedServers()[name])?.apps === false) return;
      catalog.recordList(name, server, tools, extensions);
    },
  });
  const probe = deps.probe ?? probeMcpServer;
  const rate = rowRate(APP_LIMITS.rpcPerMinute, 60_000);
  const resources = new Map<string, { at: number; read: Promise<ResourceRead> }>();

  const extensionFor = (name: string, server: McpServerSpec | StoredMcpServer) => catalog.get(name, server)?.uiExtension !== "refused";

  const signedIn = async (name: string, server: McpServerSpec): Promise<McpServerSpec | null> => {
    if (!("url" in server)) return server;
    const out = await withMcpSignIn({ [name]: server }, deps.oauth as McpOAuthManager);
    return out[name] ?? null;
  };

  const readResource = (name: string, server: McpServerSpec, uri: string): Promise<ResourceRead> => {
    const key = `${name}\u0000${mcpServerConfigHash(server)}\u0000${uri}`;
    const cached = resources.get(key);
    if (cached && now() - cached.at < APP_RESOURCE_CACHE_MS) return cached.read;
    const read = (async (): Promise<ResourceRead> => {
      try {
        const extension = extensionFor(name, server);
        const result = await connections.request(name, server, "resources/read", { uri }, AbortSignal.timeout(RPC_OTHER_MS), extension);
        const contents = isRecord(result) && Array.isArray(result.contents) ? result.contents.filter(isRecord) : [];
        const item = contents.find((content) => content.uri === uri) ?? contents[0];
        if (!item || item.mimeType !== APP_MIME) return { ok: false, reason: "unavailable" };
        let html: string | undefined;
        if (typeof item.text === "string") html = item.text;
        else if (typeof item.blob === "string" && item.blob.length <= Math.ceil(APP_LIMITS.mcpHtmlBytes / 3) * 4 + 4) html = Buffer.from(item.blob, "base64").toString("utf8");
        if (html === undefined || Buffer.byteLength(html) > APP_LIMITS.mcpHtmlBytes) return { ok: false, reason: html === undefined ? "unavailable" : "too-large" };
        let ui = uiMeta(item);
        if (!ui) {
          // The MCP Apps draft also allows `_meta.ui` on the resources/list entry.
          const listed = await connections.request(name, server, "resources/list", {}, AbortSignal.timeout(RPC_OTHER_MS), extension).catch(() => undefined);
          const entry = isRecord(listed) && Array.isArray(listed.resources) ? listed.resources.find((resource) => isRecord(resource) && resource.uri === uri) : undefined;
          ui = uiMeta(entry);
        }
        return { ok: true, html, ui };
      } catch (error) {
        return { ok: false, reason: error instanceof McpHttpError && error.status === 401 ? "signed-out" : "unavailable" };
      }
    })();
    resources.set(key, { at: now(), read });
    void read.then((value) => { if (!value.ok && resources.get(key)?.read === read) resources.delete(key); });
    if (resources.size > 200) for (const [other, entry] of resources) if (now() - entry.at >= APP_RESOURCE_CACHE_MS) resources.delete(other);
    return read;
  };

  async function recordMcpAppCall(args: McpAppCallArgs): Promise<AgentCardResult> {
    const { threadId, input } = args;
    // No row for a room, an unmounted server, one outside the bot's scope or one whose apps are off; the
    // observer reads nothing back.
    if (store.groupByThread(threadId)) return { ok: false, status: 409, error: "Apps are not shown in rooms yet." };
    const bot = store.bot(args.bot.id);
    if (!bot) return { ok: false, status: 404, error: "No such bot." };
    const name = input.server;
    const definition = input.definition;
    const call = input.call;
    const result = input.result;
    if (typeof name !== "string" || !isRecord(definition) || typeof definition.name !== "string" || !definition.name || !isRecord(definition._meta)
      || !isRecord(call) || (call.arguments !== undefined && !isRecord(call.arguments))
      || !isRecord(result) || !Array.isArray(result.content)) {
      return { ok: false, status: 400, error: "mcp_app takes {server, definition, call, result}." };
    }
    const resourceUri = toolUiResource(definition);
    if (!resourceUri) return { ok: false, status: 400, error: "That tool has no app." };
    const mounted = deps.mountedServers(bot);
    const server = Object.hasOwn(mounted, name) ? mounted[name] : undefined;
    if (!server || !canUseMcpServer(bot.toolScope, name)) return { ok: false, status: 404, error: "That server is not one of this bot's." };
    if (storedServer(name, deps.storedServers()[name])?.apps === false) return { ok: false, status: 409, error: "Apps are off for that server." };

    const spec = await signedIn(name, server);
    const read: ResourceRead = spec ? await readResource(name, spec, resourceUri) : { ok: false, reason: "signed-out" };
    const info = isRecord(input.serverInfo) ? input.serverInfo : (spec ? await connections.serverInfo(name, spec) : undefined);
    const serverTitle = oneLine(String((typeof info?.title === "string" && info.title) || (typeof info?.name === "string" && info.name) || name)).slice(0, 80);
    const annotations = isRecord(definition.annotations) ? definition.annotations : {};
    const toolTitle = oneLine(String((typeof definition.title === "string" && definition.title) || (typeof annotations.title === "string" && annotations.title) || definition.name)).slice(0, APP_LIMITS.title) || definition.name.slice(0, APP_LIMITS.title);
    const toolResult: AppToolResult = {
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
    };
    const tool = {
      name: definition.name,
      ...(typeof definition.title === "string" ? { title: definition.title } : {}),
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      ...(isRecord(definition.inputSchema) ? { inputSchema: definition.inputSchema } : {}),
      ...(isRecord(definition.annotations) ? { annotations: definition.annotations } : {}),
      _meta: definition._meta,
    };
    let payload: AppPayload;
    const ref = {
      server: name, serverTitle, tool: definition.name, resourceUri,
      ...(toolResult.isError ? { isError: true } : {}),
    };
    if (read.ok) {
      const { network } = mcpAppNetwork(read.ui?.csp, loopbackServer(server));
      const stored = apps.docs.put({
        source: "mcp", html: read.html,
        data: { tool, toolInput: isRecord(call.arguments) ? call.arguments : {}, toolResult, network },
      });
      payload = {
        v: 1, source: "mcp", title: toolTitle, doc: stored.ok ? stored.doc : "", rev: 0, bytes: Buffer.byteLength(read.html),
        border: read.ui?.prefersBorder !== false, network, mcp: ref,
        ...(stored.ok ? {} : { blocked: "too-large" as const }),
      };
    } else {
      payload = { v: 1, source: "mcp", title: toolTitle, doc: "", rev: 0, bytes: 0, border: true, network: { connect: [], resources: [] }, mcp: ref, blocked: read.reason };
    }
    const message = store.appendMessage(threadId, {
      role: "bot", kind: "app", text: redactSecretsInText(mcpAppFallbackText(serverTitle, toolTitle, toolResult)), app: payload,
    });
    args.authored?.(message.id);
    catalog.recordTool(name, server, definition);
    log(`app row ${message.id}: bot=${bot.id} server=${name} tool=${definition.name}${payload.blocked ? ` blocked=${payload.blocked}` : ""}`);
    return { ok: true, messageId: message.id };
  }

  const OPEN: AppCan = { serverTools: true, serverResources: true, message: true, openLinks: true, modelContext: true };
  const CLOSED: AppCan = { ...OPEN, serverTools: false, serverResources: false };

  function blockedReason(name: string, threadId: string): AppBlockedReason | null {
    const stored = storedServer(name, deps.storedServers()[name]);
    if (!stored) return "server-removed";
    if (!stored.enabled) return "server-disabled";
    if (stored.apps === false) return "apps-off";
    if (isRemoteMcpServer(stored) && deps.oauth.authState(name, stored.url) === "needs-sign-in") return "signed-out";
    const bot = store.botByThread(threadId);
    if (!bot || !Object.hasOwn(deps.mountedServers(bot), name) || !canUseMcpServer(bot.toolScope, name)) return "server-removed";
    return null;
  }

  function access(row: Message & { app: AppPayload }, threadId: string): { can: AppCan; blocked?: AppDocument["blocked"] } {
    const ref = row.app.mcp;
    const reason = ref ? blockedReason(ref.server, threadId) : "server-removed";
    if (!reason) return { can: { ...OPEN } };
    return { can: { ...CLOSED }, blocked: { reason, text: appBlockedText(reason, ref?.serverTitle ?? ref?.server) } };
  }

  const approvalOf = (botId: string, threadId: string): "full" | "confirm" => {
    const task = store.projectBotForTask(botId, threadId);
    return task && approvalModeFor({ ...task, threadId }) === "full" ? "full" : "confirm";
  };

  /** Nothing configured and nothing secret-shaped reaches the view. */
  const serverErrorText = (detail: string, server: McpServerSpec): string => {
    let text = detail.slice(0, REMOTE_ERROR_CHARS * 4);
    const configured = "url" in server ? [server.url, ...Object.values(server.headers)] : Object.values(server.env);
    for (const value of configured) if (value && value.length >= 4) text = text.split(value).join("«redacted»");
    return clip(redactSecretsInText(text).trim(), REMOTE_ERROR_CHARS) || "The app's server refused this.";
  };

  async function answer(request: McpRpcRequest, name: string, server: McpServerSpec): Promise<McpRpcAnswer> {
    const { bot, method, params } = request;
    const extension = extensionFor(name, server);
    if (method === "resources/read") {
      if (typeof params.uri !== "string" || !params.uri || params.uri.length > 2_048) return rpcError(400, -32602, "resources/read needs a uri.");
      const result = await connections.request(name, server, method, { uri: params.uri }, AbortSignal.timeout(RPC_OTHER_MS), extension);
      if (Buffer.byteLength(JSON.stringify(result ?? null)) > APP_LIMITS.rpcResourceBytes) return rpcError(413, -32000, "That resource is too large for this app.");
      return { status: 200, body: isRecord(result) ? result : {} };
    }
    if (method === "resources/list") {
      const cursor = typeof params.cursor === "string" ? { cursor: params.cursor } : {};
      const result = await connections.request(name, server, method, cursor, AbortSignal.timeout(RPC_OTHER_MS), extension);
      return { status: 200, body: isRecord(result) ? result : {} };
    }
    const tools = await connections.tools(name, server, AbortSignal.timeout(RPC_OTHER_MS), extension);
    const callable = (tool: Json) => {
      const visibility = toolVisibility(tool);
      if (!visibility.includes("app")) return false;
      return visibility.includes("model")
        ? allowsTool(bot.toolScope, { kind: "mcp", server: name, name: String(tool.name) })
        : canUseMcpServer(bot.toolScope, name);
    };
    if (method === "tools/list") return { status: 200, body: { tools: tools.filter(callable) } };

    if (typeof params.name !== "string" || !params.name || (params.arguments !== undefined && !isRecord(params.arguments))) {
      return rpcError(400, -32602, "tools/call needs {name, arguments?}.");
    }
    const tool = tools.find((candidate) => candidate.name === params.name);
    if (!tool) return rpcError(403, -32602, "This app's server has no tool by that name.");
    const visibility = toolVisibility(tool);
    if (!visibility.includes("app")) return rpcError(403, -32602, "That tool is not available to apps.");
    if (!callable(tool)) return rpcError(403, -32602, "The bot's tool selection does not include that tool.");
    const callArgs = isRecord(params.arguments) ? params.arguments : {};
    if (Buffer.byteLength(JSON.stringify(callArgs)) > APP_LIMITS.rpcArgumentsBytes) return rpcError(400, -32602, "Those arguments are too large.");
    const validate = lenientToolValidator(tool.inputSchema);
    let problems: string[] | undefined;
    try { problems = validate && !validate(callArgs) ? schemaProblems(validate.errors) : undefined; } catch { problems = undefined; }
    if (problems?.length) return rpcError(400, -32602, `Invalid arguments: ${problems.join("; ")}`);
    // A change follows the bot's approval level: it runs at Full access, and at any other level, where the bot
    // itself would ask first, it is declined. OpenMausBot draws no Allow card of its own.
    const annotations = isRecord(tool.annotations) ? tool.annotations : {};
    const runs = annotations.readOnlyHint === true
      || (!visibility.includes("model") && annotations.destructiveHint !== true)
      || approvalOf(bot.id, request.threadId) === "full";
    if (!runs) return rpcError(403, -32000, APP_WRITE_DECLINED);
    const result = await connections.request(name, server, "tools/call", { name: tool.name, arguments: callArgs }, AbortSignal.timeout(RPC_CALL_MS), extension);
    return { status: 200, body: isRecord(result) ? result : { content: [] } };
  }

  async function rpc(request: McpRpcRequest): Promise<McpRpcAnswer> {
    const { bot, threadId, row, method, params } = request;
    const ref = row.app.mcp;
    const tool = method === "tools/call" && typeof params.name === "string" ? ` tool=${params.name.slice(0, 120)}` : "";
    const done = (answer: McpRpcAnswer): McpRpcAnswer => {
      // Every app-initiated call is logged; its arguments never are.
      log(`rpc bot=${bot.id} server=${ref?.server ?? "-"} method=${method}${tool} → ${answer.status}`);
      return answer;
    };
    if (!ref) return done({ status: 404, body: { error: "That app has no server to call." } });
    const reason = blockedReason(ref.server, threadId);
    const text = (why: AppBlockedReason) => appBlockedText(why, ref.serverTitle ?? ref.server);
    const signIn = () => rpcError(401, -32000, "Sign-in needed", { signIn: { server: ref.server } });
    if (reason === "signed-out") return done(signIn());
    if (reason) return done(rpcError(410, -32000, text(reason), { blocked: { reason, text: text(reason) } }));
    if (!rate.take(`${threadId}:${row.id}`)) return done(rpcError(429, -32000, "Too many calls from this app. Wait a minute."));
    const mounted = deps.mountedServers(bot)[ref.server];
    const server = mounted ? await signedIn(ref.server, mounted) : null;
    if (!server) return done(signIn());
    try {
      return done(await answer(request, ref.server, server));
    } catch (error) {
      if (error instanceof McpHttpError && error.status === 401) return done(signIn());
      if (error instanceof McpRpcError) return done(rpcError(502, error.code ?? -32603, serverErrorText(error.detail, server)));
      return done(rpcError(502, -32603, "The app's server could not be reached."));
    }
  }

  // A probe of a command server starts it on this computer, so one is probed only by Settings → Test, or in
  // the background for a turn whose bot may use it (that turn starts it anyway).

  const queued = new Set<string>();
  const lastAutomatic = new Map<string, number>();
  const probeStale = (name: string) => {
    const last = lastAutomatic.get(name);
    if (last !== undefined && now() - last < AUTOMATIC_PROBE_EVERY_MS) return;
    lastAutomatic.set(name, now());
    queueProbe(name);
  };
  const remote = (name: string) => {
    const stored = storedServer(name, deps.storedServers()[name]);
    return stored !== null && isRemoteMcpServer(stored);
  };
  let probing: Promise<void> = Promise.resolve();
  let closed = false;

  function probeOptions(name: string, server: StoredMcpServer): McpProbeOptions {
    if (server.apps === false) return {};
    return {
      extension: extensionFor(name, server),
      observe: (info) => { catalog.recordList(name, server, info.tools, info.uiExtension); },
    };
  }

  function serverChanged(name: string): void {
    if (remote(name)) queueProbe(name);
  }

  function queueProbe(name: string): void {
    if (closed || queued.has(name)) return;
    queued.add(name);
    probing = probing.then(async () => {
      queued.delete(name);
      if (closed || deps.personMcp?.().includes(name)) return;
      const stored = storedServer(name, deps.storedServers()[name]);
      if (!stored?.enabled || stored.apps === false) return;
      if (isRemoteMcpServer(stored) && deps.oauth.authState(name, stored.url) === "needs-sign-in") return;
      const target = isRemoteMcpServer(stored) ? await signedIn(name, stored) : stored;
      if (!target) return;
      const result = await probe({ ...target, enabled: true } as StoredMcpServer, BACKGROUND_PROBE_MS, undefined, probeOptions(name, stored));
      log(`probed ${name}: ${result.ok ? `apps=${catalog.get(name, stored)?.apps === true}` : "failed"}`);
    }).catch((error: unknown) => log(`probe of ${name} failed: ${String(error)}`));
  }

  function turnMounts(custom: Record<string, McpServerSpec>, toolScope?: unknown): { mcpApps?: Record<string, { extension: boolean }> } {
    const mcpApps: Record<string, { extension: boolean }> = {};
    const stored = deps.storedServers();
    for (const [name, server] of Object.entries(custom)) {
      if (storedServer(name, stored[name])?.apps === false) continue;
      const entry = catalog.get(name, server);
      if (catalog.stale(name, server) && canUseMcpServer(toolScope, name)) probeStale(name);
      if (entry?.apps) mcpApps[name] = { extension: entry.uiExtension !== "refused" };
    }
    return Object.keys(mcpApps).length ? { mcpApps } : {};
  }

  const onExit = () => connections.closeAll();
  process.once("exit", onExit);
  const startup = deps.startupProbes === false ? undefined : setTimeout(() => {
    for (const [name, raw] of Object.entries(deps.storedServers())) {
      const stored = storedServer(name, raw);
      if (stored?.enabled && stored.apps !== false && isRemoteMcpServer(stored) && catalog.stale(name, stored)) probeStale(name);
    }
  }, STARTUP_PROBE_DELAY_MS);
  startup?.unref?.();

  const service: ChatAppsMcp = {
    catalog, connections, recordMcpAppCall, access, rpc, turnMounts, probeOptions, serverChanged,
    hasApps(name) {
      const raw = deps.storedServers()[name];
      return raw && typeof raw === "object" ? catalog.get(name, raw as Record<string, unknown>)?.apps : undefined;
    },
    forgetServer(name) {
      catalog.forget(name);
      connections.closeServer(name);
      for (const key of resources.keys()) if (key.startsWith(`${name}\u0000`)) resources.delete(key);
    },
    close() {
      closed = true;
      if (startup) clearTimeout(startup);
      process.off("exit", onExit);
      connections.closeAll();
    },
  };
  apps.mcpAccess = access;
  apps.recordMcpAppCall = recordMcpAppCall;
  return service;
}
