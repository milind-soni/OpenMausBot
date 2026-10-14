import {
  APP_LIMITS, appBlockedText, htmlFallbackText, oneLine, parseShowHtmlInput, parseUpdateHtmlInput,
  type AppCan, type AppDocument, type AppPayload,
} from "../shared/app.ts";
import { BOT_HTML_NETWORK } from "../shared/app-frame/csp.ts";
import { botHtmlDocument, mcpAppDocument } from "../shared/app-frame/document.ts";
import { AppDocs } from "./app-docs.ts";
import type { AgentCardResult, AgentCardStore } from "./chat-widgets.ts";
import { appDocRefs } from "./message-db.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message, StoreChange } from "./store.ts";

const ROOM_REFUSAL = "Pages are not available in rooms yet. Answer in text.";
const NO_SUCH_PAGE = "No page with that id in this conversation.";
const NOT_A_PAGE = "That app came from an MCP server, not from show_html; it cannot be replaced. Show a new page instead.";

export interface ChatAppsStore extends AgentCardStore {
  onChange?(listener: (change: StoreChange) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function appRow(store: Pick<AgentCardStore, "messagesFor">, threadId: string, messageId: string): (Message & { app: AppPayload }) | undefined {
  const row = store.messagesFor(threadId).find((message) => message.id === messageId);
  return row && row.kind === "app" && isRecord(row.app) ? row as Message & { app: AppPayload } : undefined;
}

export function appOrigin(payload: AppPayload): string {
  if (payload.source === "mcp" && payload.mcp) return `${oneLine(payload.mcp.serverTitle || payload.mcp.server)} · ${oneLine(payload.mcp.tool)}`;
  return "a page you made with show_html";
}

function scrubbed(html: string, title: string): { html: string; title: string; masked: boolean } {
  const cleanHtml = redactSecretsInText(html);
  const cleanTitle = oneLine(redactSecretsInText(title)).slice(0, APP_LIMITS.title) || "Page";
  return { html: cleanHtml, title: cleanTitle, masked: cleanHtml !== html || cleanTitle !== title };
}

/** The route has already checked that the conversation is the calling bot's own. */
export function createAppCard(args: {
  store: AgentCardStore;
  docs: AppDocs;
  bot: { id: string; name: string };
  threadId: string;
  input: Record<string, unknown>;
  authored?(messageId: string): void;
}): AgentCardResult {
  const { store, docs, bot, threadId, input } = args;
  if (input.tool !== "show_html" && input.tool !== "update_html") {
    return { ok: false, status: 400, error: "tool: must be show_html or update_html." };
  }
  if (store.groupByThread(threadId)) return { ok: false, status: 409, error: ROOM_REFUSAL };

  if (input.tool === "show_html") {
    const parsed = parseShowHtmlInput(input);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const page = scrubbed(parsed.value.html, parsed.value.title);
    const fallback = redactSecretsInText(htmlFallbackText(page.title, page.html, parsed.value.fallbackText));
    const stored = docs.put({ source: "html", html: page.html });
    const payload: AppPayload = {
      v: 1, source: "html", title: page.title,
      doc: stored.ok ? stored.doc : "", rev: 0, bytes: Buffer.byteLength(page.html),
      ...(parsed.value.height !== undefined ? { height: parsed.value.height } : {}),
      border: true,
      network: { connect: [...BOT_HTML_NETWORK.connect], resources: [...BOT_HTML_NETWORK.resources] },
      ...(stored.ok ? {} : { blocked: "too-large" as const }),
    };
    // No `from`: in a direct thread a bot-authored row carrying one is replayed as another bot's line.
    const message = store.appendMessage(threadId, { role: "bot", kind: "app", text: fallback, app: payload });
    args.authored?.(message.id);
    return { ok: true, messageId: message.id, ...(page.masked ? { masked: true as const } : {}) };
  }

  const parsed = parseUpdateHtmlInput(input);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const existing = appRow(store, threadId, parsed.value.appId);
  if (!existing || (existing.from && existing.from.botId !== bot.id)) return { ok: false, status: 404, error: NO_SUCH_PAGE };
  if (existing.app.source !== "html") return { ok: false, status: 409, error: NOT_A_PAGE };
  const page = scrubbed(parsed.value.html, parsed.value.title ?? existing.app.title);
  const stored = docs.put({ source: "html", html: page.html });
  // The page reloads: what the old one told the model about itself no longer holds.
  const { context: _context, blocked: _blocked, ...kept } = existing.app;
  const payload: AppPayload = {
    ...kept,
    title: page.title,
    doc: stored.ok ? stored.doc : "",
    rev: (existing.app.rev ?? 0) + 1,
    bytes: Buffer.byteLength(page.html),
    ...(stored.ok ? {} : { blocked: "too-large" as const }),
  };
  const patched = store.patchMessage(threadId, existing.id, { text: redactSecretsInText(htmlFallbackText(page.title, page.html)), app: payload });
  if (!patched) return { ok: false, status: 404, error: NO_SUCH_PAGE };
  args.authored?.(patched.id);
  return { ok: true, messageId: patched.id, ...(page.masked ? { masked: true as const } : {}) };
}

export type McpAppAccess = (row: Message & { app: AppPayload }, threadId: string) => { can: AppCan; blocked?: AppDocument["blocked"] };

const MCP_READ_ONLY: McpAppAccess = (row) => ({
  can: { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true },
  blocked: { reason: "server-removed", text: appBlockedText("server-removed", row.app.mcp?.serverTitle ?? row.app.mcp?.server) },
});

export function appDocument(args: {
  store: Pick<AgentCardStore, "messagesFor">;
  docs: AppDocs;
  threadId: string;
  messageId: string;
  approval: "full" | "confirm";
  mcpAccess?: McpAppAccess;
}): AppDocument | null {
  const row = appRow(args.store, args.threadId, args.messageId);
  if (!row?.app.doc) return null;
  const stored = args.docs.read(row.app.doc);
  if (!stored || stored.source !== row.app.source) return null;
  const rev = row.app.rev ?? 0;
  if (stored.source === "html") return botHtmlDocument({ messageId: row.id, rev, html: stored.html, approval: args.approval });
  if (!stored.data?.tool) return null;
  const access = (args.mcpAccess ?? MCP_READ_ONLY)(row, args.threadId);
  return mcpAppDocument({
    messageId: row.id, rev, html: stored.html,
    network: { connect: stored.data.network?.connect ?? [], resources: stored.data.network?.resources ?? [] },
    tool: stored.data.tool,
    ...(stored.data.toolInput ? { toolInput: stored.data.toolInput } : {}),
    ...(stored.data.toolResult ? { toolResult: stored.data.toolResult } : {}),
    can: access.can,
    ...(access.blocked ? { blocked: access.blocked } : {}),
    approval: args.approval,
  });
}

export type AppRouteResult = { ok: true } | { ok: false; status: 400 | 404 | 409 | 429; error: string };

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function appContextText(content: unknown, structuredContent: unknown): string {
  const texts = Array.isArray(content)
    ? content.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    : [];
  let structured = "";
  if (isRecord(structuredContent)) {
    try { structured = JSON.stringify(structuredContent); } catch { structured = ""; }
  }
  return clip([texts.join("\n").trim(), structured].filter(Boolean).join("\n"), APP_LIMITS.contextText);
}

export function setAppContext(
  store: Pick<AgentCardStore, "messagesFor" | "patchMessage">,
  args: { threadId: string; messageId: string; content?: unknown; structuredContent?: unknown; now?: number },
): AppRouteResult {
  if ((args.content !== undefined && !Array.isArray(args.content)) || (args.structuredContent !== undefined && !isRecord(args.structuredContent))) {
    return { ok: false, status: 400, error: "context takes {threadId, content?, structuredContent?}." };
  }
  const row = appRow(store, args.threadId, args.messageId);
  if (!row) return { ok: false, status: 404, error: "That app is not in this conversation." };
  const text = redactSecretsInText(appContextText(args.content, args.structuredContent));
  const { context: _previous, ...rest } = row.app;
  const app: AppPayload = text ? { ...rest, context: { text, at: args.now ?? Date.now(), delivered: false } } : rest;
  return store.patchMessage(args.threadId, row.id, { app }) ? { ok: true } : { ok: false, status: 404, error: "That app is not in this conversation." };
}

const CONTEXT_OPEN = "--- app context ---";
const CONTEXT_CLOSE = "--- end app context ---";
const CONTEXT_FENCE = /-{3,}\s*end\s*app\s*context\s*-{3,}/gi;

/** Nothing an app wrote may close the fence it is quoted in. */
function inContextFence(text: string): string {
  let out = text;
  for (let pass = 0; pass < 4 && out.search(CONTEXT_FENCE) !== -1; pass += 1) out = out.replace(CONTEXT_FENCE, "- end app context -");
  return out;
}

/** `deliver()` marks the blocks handed once the message is accepted; a newer update that arrived meanwhile
 * stays undelivered. */
export function appContextBlock(
  store: Pick<AgentCardStore, "messagesFor" | "patchMessage">,
  threadId: string,
): { block: string; deliver(): void } | null {
  const rows = store.messagesFor(threadId).filter((message): message is Message & { app: AppPayload } =>
    message.kind === "app" && isRecord(message.app) && Boolean(message.app.context?.text) && message.app.context?.delivered === false);
  if (rows.length === 0) return null;
  const taken = rows.map((row) => ({ id: row.id, at: row.app.context!.at }));
  const blocks = rows.map((row) => [
    CONTEXT_OPEN,
    `${inContextFence(oneLine(row.app.title))} (${inContextFence(appOrigin(row.app))}), as the person sees it now:`,
    inContextFence(row.app.context!.text),
    CONTEXT_CLOSE,
  ].join("\n"));
  return {
    block: `${blocks.join("\n")}\n\n`,
    deliver() {
      for (const { id, at } of taken) {
        const row = appRow(store, threadId, id);
        if (row?.app.context && row.app.context.at === at && !row.app.context.delivered) {
          store.patchMessage(threadId, id, { app: { ...row.app, context: { ...row.app.context, delivered: true } } });
        }
      }
    },
  };
}

export function withAppContext(store: Pick<AgentCardStore, "messagesFor" | "patchMessage">, text: string, threadId: string): { text: string; deliver(): void } {
  const context = appContextBlock(store, threadId);
  return context ? { text: `${context.block}${text}`, deliver: context.deliver } : { text, deliver: () => {} };
}

export type AppMessage =
  | { ok: true; messageId: string; text: string; title: string; origin: string }
  | { ok: false; status: 400 | 404; error: string };

const BAD_APP_MESSAGE = "appMessage must be {messageId, text}, with text of 1 to 4,000 characters.";

export function prepareAppMessage(store: Pick<AgentCardStore, "messagesFor">, threadId: string, appMessage: unknown): AppMessage {
  if (!isRecord(appMessage) || typeof appMessage.messageId !== "string" || !/^[\w-]{1,128}$/.test(appMessage.messageId) || typeof appMessage.text !== "string") {
    return { ok: false, status: 400, error: BAD_APP_MESSAGE };
  }
  const text = appMessage.text.trim();
  if (!text || text.length > APP_LIMITS.messageText) return { ok: false, status: 400, error: BAD_APP_MESSAGE };
  const row = appRow(store, threadId, appMessage.messageId);
  if (!row) return { ok: false, status: 404, error: "That app is not in this conversation." };
  return { ok: true, messageId: row.id, text, title: oneLine(row.app.title), origin: appOrigin(row.app) };
}

export class AppMessageRate {
  private readonly sent = new Map<string, Array<{ at: number; sendId?: string }>>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number = APP_LIMITS.messagesPerHour, windowMs = 60 * 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** `release()` when the send is refused; null when the row is over its rate. */
  reserve(key: string, sendId: string | undefined, now = Date.now()): { release(): void } | null {
    const recent = (this.sent.get(key) ?? []).filter((entry) => now - entry.at < this.windowMs);
    if (sendId && recent.some((entry) => entry.sendId === sendId)) {
      this.sent.set(key, recent);
      return { release: () => {} };
    }
    if (recent.length >= this.limit) {
      this.sent.set(key, recent);
      return null;
    }
    const entry = { at: now, ...(sendId ? { sendId } : {}) };
    recent.push(entry);
    this.sent.set(key, recent);
    return {
      release: () => {
        const list = this.sent.get(key);
        const index = list?.indexOf(entry) ?? -1;
        if (list && index !== -1) list.splice(index, 1);
      },
    };
  }
}

export function rowRate(limit: number, windowMs: number): { take(key: string, now?: number): boolean } {
  const stamps = new Map<string, number[]>();
  return {
    take(key, now = Date.now()) {
      const recent = (stamps.get(key) ?? []).filter((at) => now - at < windowMs);
      if (recent.length >= limit) {
        stamps.set(key, recent);
        return false;
      }
      recent.push(now);
      stamps.set(key, recent);
      if (stamps.size > 2_000) for (const [other, list] of stamps) if (!list.some((at) => now - at < windowMs)) stamps.delete(other);
      return true;
    },
  };
}

export interface ChatApps {
  readonly docs: AppDocs;
  createAppCard(args: { bot: { id: string; name: string }; threadId: string; input: Record<string, unknown>; authored?(messageId: string): void }): AgentCardResult;
  appDocument(threadId: string, messageId: string, approval: "full" | "confirm"): AppDocument | null;
  setAppContext(args: { threadId: string; messageId: string; content?: unknown; structuredContent?: unknown }): AppRouteResult;
  withAppContext(text: string, threadId: string): { text: string; deliver(): void };
  mcpAccess?: McpAppAccess;
  recordMcpAppCall?(args: { bot: { id: string; name: string }; threadId: string; input: Record<string, unknown>; authored?(messageId: string): void }): Promise<AgentCardResult>;
  sweep(): number;
  close(): void;
}

export function createChatApps(deps: {
  store: ChatAppsStore;
  dataDir: string;
  maxBytes?: number;
  references?(): string[];
  sweeps?: boolean;
}): ChatApps {
  const docs = new AppDocs(`${deps.dataDir}/app-docs`, deps.maxBytes ? { maxBytes: deps.maxBytes } : {});
  const references = deps.references ?? appDocRefs;
  const sweep = () => {
    try { return docs.sweep(references()); } catch (error) {
      console.error("chat apps: document sweep failed", error);
      return 0;
    }
  };
  let pending: ReturnType<typeof setTimeout> | null = null;
  let pendingAt = Infinity;
  const later = (ms: number) => {
    const at = Date.now() + ms;
    if (pending && pendingAt <= at) return;
    if (pending) clearTimeout(pending);
    pendingAt = at;
    pending = setTimeout(() => { pending = null; pendingAt = Infinity; sweep(); }, ms);
    pending.unref?.();
  };
  const unsubscribe = deps.sweeps === false ? undefined : deps.store.onChange?.((change) => {
    if (change.type === "thread.deleted") later(2_000);
  });
  if (deps.sweeps !== false) later(30_000);
  const apps: ChatApps = {
    docs,
    createAppCard: (args) => createAppCard({ ...args, store: deps.store, docs }),
    appDocument: (threadId, messageId, approval) => appDocument({ store: deps.store, docs, threadId, messageId, approval, ...(apps.mcpAccess ? { mcpAccess: apps.mcpAccess } : {}) }),
    setAppContext: (args) => setAppContext(deps.store, args),
    withAppContext: (text, threadId) => withAppContext(deps.store, text, threadId),
    sweep,
    close() {
      unsubscribe?.();
      if (pending) clearTimeout(pending);
      pending = null;
    },
  };
  return apps;
}
