// The host side of the MCP Apps bridge (io.modelcontextprotocol/ui, stable 2026-01-26) for one app frame. It
// runs in the desktop renderer and, bundled, in the phones' web views, so it never touches a window: a platform
// hands it each `message` event and an adapter for the rest.
import { APP_LIMITS, APP_PROTOCOL_VERSION, utf8Bytes, type AppDocument } from "../app.ts";

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

export const APP_RPC_METHODS = ["tools/call", "tools/list", "resources/read", "resources/list"] as const;
export type AppRpcMethod = (typeof APP_RPC_METHODS)[number];

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_HOST_REFUSED = -32000;

export const APP_FRAME_LIMITS = {
  messageBytes: 1_000_000,
  minHeight: 48,
  defaultHeight: 160,
  /** When the host context names no maxHeight. */
  maxHeight: 720,
  linkChars: 2_048,
  teardownMs: 1_000,
  /** Phones: a touch within this long counts as engagement. */
  engagedTouchMs: 10_000,
  contextCoalesceMs: 1_000,
  logsPerMinute: 50,
  /** [window ms, max calls] pairs, all of which must have room. */
  rates: {
    message: [[3_000, 1], [600_000, 10]] as ReadonlyArray<readonly [number, number]>,
    openLink: [[2_000, 1]] as ReadonlyArray<readonly [number, number]>,
    rpc: [[10_000, 10], [600_000, 120]] as ReadonlyArray<readonly [number, number]>,
  },
} as const;

/** McpUiHostContext; the bridge adds `toolInfo` for an MCP document. */
export interface AppHostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
  displayMode?: "inline";
  availableDisplayModes?: Array<"inline">;
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number };
  locale?: string;
  timeZone?: string;
  platform?: "desktop" | "web" | "mobile";
  deviceCapabilities?: { touch?: boolean; hover?: boolean };
  userAgent?: string;
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  toolInfo?: { tool: object };
  [key: string]: unknown;
}

export interface AppContextUpdate {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
}

export interface AppBridgeAdapter {
  post(message: JsonRpcMessage): void;
  /** Resolves with the JSON-RPC `result`; rejects with { code, message }. */
  callRpc(method: AppRpcMethod, params: Record<string, unknown>): Promise<unknown>;
  sendMessage(text: string): Promise<void>;
  openLink(url: string): Promise<void> | void;
  setContext(update: AppContextUpdate): Promise<void> | void;
  resize(height: number): void;
  engaged(): boolean;
  teardownRequested(): void;
  now(): number;
}

export interface AppBridgeOptions {
  doc: AppDocument;
  hostContext: AppHostContext;
  adapter: AppBridgeAdapter;
  /** The frame's window: a message event whose `source` is anything else is dropped. */
  source(): unknown;
  /** hostInfo.version */
  hostVersion: string;
  /** Overrides hostContext.containerDimensions.maxHeight for the clamp. */
  limits?: { maxHeight?: number };
  /** notifications/message from the View, at most 50 a minute. */
  log?(params: unknown): void;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface AppBridge {
  handleMessage(event: { source: unknown; data: unknown }): void;
  /** Sent as host-context-changed once the View is initialized, else folded into what it will be sent. */
  contextChanged(partial: AppHostContext): void;
  /** ui/resource-teardown; resolves when the View answers or after 1 s. */
  teardown(): Promise<void>;
  dispose(): void;
  readonly initialized: boolean;
}

export function hostCapabilitiesFor(doc: AppDocument): Record<string, unknown> {
  const mcp = isMcpDocument(doc);
  return {
    ...(doc.can.openLinks ? { openLinks: {} } : {}),
    logging: {},
    ...(doc.can.modelContext ? { updateModelContext: { text: {}, structuredContent: {} } } : {}),
    ...(doc.can.message ? { message: { text: {} } } : {}),
    ...(mcp && doc.can.serverTools ? { serverTools: {} } : {}),
    ...(mcp && doc.can.serverResources ? { serverResources: {} } : {}),
    sandbox: { permissions: {}, csp: { connectDomains: [...doc.network.connect], resourceDomains: [...doc.network.resources] } },
  };
}

export function isMcpDocument(doc: AppDocument): boolean {
  return Boolean(doc.tool);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return (typeof value === "string" && value.length <= 200) || (typeof value === "number" && Number.isFinite(value));
}

function jsonBytes(value: unknown): number | null {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { return null; }
  if (text === undefined) return null;
  // Under a third of the limit in UTF-16 units is under the limit in bytes.
  if (text.length * 3 <= APP_FRAME_LIMITS.messageBytes) return text.length;
  return utf8Bytes(text);
}

export function asJsonRpcMessage(data: unknown): JsonRpcMessage | null {
  if (!isRecord(data) || data.jsonrpc !== "2.0") return null;
  const bytes = jsonBytes(data);
  if (bytes === null || bytes > APP_FRAME_LIMITS.messageBytes) return null;
  if (data.params !== undefined && !isRecord(data.params)) return null;
  if (typeof data.method === "string") {
    if (!data.method || data.method.length > 200) return null;
    if ("id" in data && !isId(data.id)) return null;
    return data as JsonRpcMessage;
  }
  if (data.method !== undefined || !isId(data.id)) return null;
  if ("result" in data) return data as JsonRpcMessage;
  if (isRecord(data.error) && typeof data.error.code === "number" && typeof data.error.message === "string") return data as JsonRpcMessage;
  return null;
}

function rateLimiter(rules: ReadonlyArray<readonly [number, number]>, now: () => number) {
  const stamps: number[] = [];
  const longest = Math.max(...rules.map(([ms]) => ms));
  return {
    take(): boolean {
      const at = now();
      while (stamps.length && at - stamps[0]! >= longest) stamps.shift();
      for (const [ms, max] of rules) {
        if (stamps.filter((stamp) => at - stamp < ms).length >= max) return false;
      }
      stamps.push(at);
      return true;
    },
  };
}

function rpcErrorFrom(error: unknown): JsonRpcError {
  if (isRecord(error) && typeof error.code === "number" && Number.isInteger(error.code)) {
    return { code: error.code, message: typeof error.message === "string" && error.message ? error.message : "The host refused this." };
  }
  return { code: RPC_HOST_REFUSED, message: error instanceof Error && error.message ? error.message : "The host could not do that." };
}

export function openableLink(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > APP_FRAME_LIMITS.linkChars) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href.length <= APP_FRAME_LIMITS.linkChars ? url.href : null;
}

function messageText(params: Record<string, unknown> | undefined): string | null {
  if (!params || params.role !== "user" || !Array.isArray(params.content) || params.content.length === 0) return null;
  const texts: string[] = [];
  for (const block of params.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
    texts.push(block.text);
  }
  const text = texts.join("\n").trim();
  return text && text.length <= APP_LIMITS.messageText ? text : null;
}

export function createAppBridge(options: AppBridgeOptions): AppBridge {
  const { doc, adapter } = options;
  const mcp = isMcpDocument(doc);
  const timers = options.timers ?? {
    set: (run: () => void, ms: number) => setTimeout(run, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const now = () => adapter.now();
  let context: AppHostContext = {
    ...options.hostContext,
    ...(mcp && doc.tool ? { toolInfo: { tool: doc.tool } } : {}),
  };
  /** Changes made after the initialize answer and before `initialized`. */
  let pendingContext: AppHostContext | null = null;
  let answeredInitialize = false;
  let initialized = false;
  let disposed = false;
  let toolNotificationsSent = false;
  let hostSeq = 0;
  const hostRequests = new Map<JsonRpcId, (message: JsonRpcMessage) => void>();
  const rates = {
    message: rateLimiter(APP_FRAME_LIMITS.rates.message, now),
    openLink: rateLimiter(APP_FRAME_LIMITS.rates.openLink, now),
    rpc: rateLimiter(APP_FRAME_LIMITS.rates.rpc, now),
    log: rateLimiter([[60_000, APP_FRAME_LIMITS.logsPerMinute]], now),
  };
  // ui/update-model-context: the latest wins, at most one a second.
  let contextLatest: AppContextUpdate | null = null;
  let contextTimer: unknown = null;
  let contextSentAt = -Infinity;

  const post = (message: JsonRpcMessage) => {
    if (disposed) return;
    try { adapter.post(message); } catch { /* a frame that went away mid-send */ }
  };
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) => post({ jsonrpc: "2.0", id, error: { code, message } });

  const maxHeight = () => {
    const fromLimits = options.limits?.maxHeight;
    const fromContext = context.containerDimensions?.maxHeight;
    const max = typeof fromLimits === "number" && fromLimits > 0 ? fromLimits
      : typeof fromContext === "number" && fromContext > 0 ? fromContext
        : APP_FRAME_LIMITS.maxHeight;
    return Math.max(APP_FRAME_LIMITS.minHeight, max);
  };

  const flushContext = () => {
    contextTimer = null;
    if (disposed || !contextLatest) return;
    const update = contextLatest;
    contextLatest = null;
    contextSentAt = now();
    Promise.resolve().then(() => adapter.setContext(update)).catch(() => {});
  };

  /** A message goes after what the View last said about itself, so it is never read against an older view. */
  const flushContextNow = async () => {
    if (contextTimer === null || !contextLatest) return;
    timers.clear(contextTimer);
    contextTimer = null;
    const update = contextLatest;
    contextLatest = null;
    contextSentAt = now();
    try { await adapter.setContext(update); } catch { /* the message still goes */ }
  };

  const afterInitialized = () => {
    if (mcp && !toolNotificationsSent) {
      toolNotificationsSent = true;
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: doc.toolInput ?? {} } });
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: (doc.toolResult ?? { content: [] }) as unknown as Record<string, unknown> });
    }
    if (pendingContext) {
      const partial = pendingContext;
      pendingContext = null;
      post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: partial });
    }
  };

  const onRpc = async (id: JsonRpcId, method: AppRpcMethod, params: Record<string, unknown>) => {
    if (!mcp) return fail(id, RPC_METHOD_NOT_FOUND, "Method not found");
    const allowed = method.startsWith("tools/") ? doc.can.serverTools : doc.can.serverResources;
    if (!allowed) return fail(id, RPC_HOST_REFUSED, doc.blocked?.text ?? "This app cannot reach its server right now.");
    if (method === "tools/call" && (typeof params.name !== "string" || !params.name || (params.arguments !== undefined && !isRecord(params.arguments)))) {
      return fail(id, RPC_INVALID_PARAMS, "tools/call needs {name, arguments?}.");
    }
    if (method === "resources/read" && typeof params.uri !== "string") return fail(id, RPC_INVALID_PARAMS, "resources/read needs {uri}.");
    if (!rates.rpc.take()) return fail(id, RPC_HOST_REFUSED, "Too many calls from this app. Wait a moment.");
    try {
      const result = await adapter.callRpc(method, params);
      respond(id, result ?? {});
    } catch (error) {
      const failure = rpcErrorFrom(error);
      fail(id, failure.code, failure.message);
    }
  };

  const onRequest = async (id: JsonRpcId, method: string, params: Record<string, unknown> | undefined) => {
    if (method === "ui/initialize") {
      answeredInitialize = true;
      return respond(id, {
        protocolVersion: APP_PROTOCOL_VERSION,
        hostInfo: { name: "mausbot", version: options.hostVersion },
        hostCapabilities: hostCapabilitiesFor(doc),
        hostContext: context,
      });
    }
    // Nothing but the initialize answer reaches a View before `initialized`.
    if (!initialized) return;
    switch (method) {
      case "ping":
        return respond(id, {});
      case "ui/request-display-mode":
        return respond(id, { mode: "inline" });
      case "ui/open-link": {
        if (!doc.can.openLinks) return fail(id, RPC_HOST_REFUSED, "This app cannot open links here.");
        if (!adapter.engaged()) return fail(id, RPC_HOST_REFUSED, "Links open only after the person clicks in the app.");
        const url = openableLink(params?.url);
        if (!url) return fail(id, RPC_INVALID_PARAMS, "Only http and https links of at most 2,048 characters, without a user name or password, can be opened.");
        if (!rates.openLink.take()) return fail(id, RPC_HOST_REFUSED, "Too many links from this app. Wait a moment.");
        try {
          await adapter.openLink(url);
          return respond(id, {});
        } catch (error) {
          return fail(id, RPC_HOST_REFUSED, rpcErrorFrom(error).message);
        }
      }
      case "ui/message": {
        if (!doc.can.message) return fail(id, RPC_HOST_REFUSED, "This app cannot send messages here.");
        if (!adapter.engaged()) return fail(id, RPC_HOST_REFUSED, "Messages are sent only after the person clicks in the app.");
        const text = messageText(params);
        if (text === null) return fail(id, RPC_INVALID_PARAMS, `Only text messages of 1 to ${APP_LIMITS.messageText} characters can be sent.`);
        if (!rates.message.take()) return fail(id, RPC_HOST_REFUSED, "Too many messages from this app. Wait a moment.");
        try {
          await flushContextNow();
          await adapter.sendMessage(text);
          return respond(id, {});
        } catch (error) {
          return fail(id, RPC_HOST_REFUSED, rpcErrorFrom(error).message);
        }
      }
      case "ui/update-model-context": {
        if (!doc.can.modelContext) return fail(id, RPC_HOST_REFUSED, "This app cannot update the model's context here.");
        if ((params?.content !== undefined && !Array.isArray(params.content)) || (params?.structuredContent !== undefined && !isRecord(params.structuredContent))) {
          return fail(id, RPC_INVALID_PARAMS, "ui/update-model-context takes {content?, structuredContent?}.");
        }
        contextLatest = {
          ...(Array.isArray(params?.content) ? { content: params.content } : {}),
          ...(isRecord(params?.structuredContent) ? { structuredContent: params.structuredContent } : {}),
        };
        if (contextTimer === null) {
          const wait = contextSentAt + APP_FRAME_LIMITS.contextCoalesceMs - now();
          if (wait <= 0) flushContext();
          else contextTimer = timers.set(flushContext, wait);
        }
        return respond(id, {});
      }
      default:
        if ((APP_RPC_METHODS as readonly string[]).includes(method)) return onRpc(id, method as AppRpcMethod, params ?? {});
        return fail(id, RPC_METHOD_NOT_FOUND, "Method not found");
    }
  };

  const onNotification = (method: string, params: Record<string, unknown> | undefined) => {
    if (method === "ui/notifications/initialized") {
      // An SDK view pasted into a bot's page initializes beside the helper:
      // the second `initialized` changes nothing.
      if (!answeredInitialize || initialized) return;
      initialized = true;
      afterInitialized();
      return;
    }
    if (!initialized) return;
    switch (method) {
      case "ui/notifications/size-changed": {
        const height = params?.height;
        if (typeof height !== "number" || !Number.isFinite(height)) return;
        adapter.resize(Math.round(Math.min(maxHeight(), Math.max(APP_FRAME_LIMITS.minHeight, height))));
        return;
      }
      case "notifications/message":
        if (options.log && rates.log.take()) options.log(params);
        return;
      case "ui/notifications/request-teardown":
        adapter.teardownRequested();
        return;
      default:
        // Other notifications (tool list changes, cancellations) are dropped.
    }
  };

  return {
    get initialized() { return initialized; },
    handleMessage(event) {
      if (disposed) return;
      const frame = options.source();
      // Only the frame's own window, and only well-formed JSON-RPC.
      if (frame === null || frame === undefined || event.source !== frame) return;
      const message = asJsonRpcMessage(event.data);
      if (!message) return;
      if ("method" in message) {
        if ("id" in message) void onRequest(message.id, message.method, message.params);
        else onNotification(message.method, message.params);
        return;
      }
      const waiting = hostRequests.get(message.id);
      if (waiting) {
        hostRequests.delete(message.id);
        waiting(message);
      }
    },
    contextChanged(partial) {
      if (disposed) return;
      context = { ...context, ...partial };
      if (initialized) {
        post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: partial });
      } else if (answeredInitialize) {
        pendingContext = { ...pendingContext, ...partial };
      }
    },
    teardown() {
      if (disposed || !initialized) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const id = `host:${++hostSeq}`;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          hostRequests.delete(id);
          timers.clear(timer);
          resolve();
        };
        const timer = timers.set(finish, APP_FRAME_LIMITS.teardownMs);
        hostRequests.set(id, finish);
        post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      });
    },
    dispose() {
      disposed = true;
      if (contextTimer !== null) timers.clear(contextTimer);
      contextTimer = null;
      for (const waiting of hostRequests.values()) waiting({ jsonrpc: "2.0", id: "", result: {} });
      hostRequests.clear();
    },
  };
}
