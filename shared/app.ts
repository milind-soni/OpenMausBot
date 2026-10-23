// Chat apps: HTML in a sandboxed frame inside a chat row, speaking the MCP Apps bridge
// (io.modelcontextprotocol/ui, SEP-1865). Bot HTML (show_html) and an MCP server's UI
// (_meta.ui.resourceUri) share the one wire kind, `app`.

export const APP_MIME = "text/html;profile=mcp-app";
export const APP_PROTOCOL_VERSION = "2026-01-26";
export const APP_EXTENSION_KEY = "io.modelcontextprotocol/ui";

export const APP_LIMITS = {
  /** show_html / update_html `html` or `jsx`, UTF-8 bytes after trimming. */
  htmlBytes: 256 * 1024,
  title: 80,
  fallback: 1_500,
  fallbackExcerpt: 600,
  heightMin: 80,
  heightMax: 720,
  /** ui/message text, and the appMessage on the send route. */
  messageText: 4_000,
  /** ui/update-model-context text, stored per row. */
  contextText: 4_000,
  /** An MCP server's UI resource, decoded. */
  mcpHtmlBytes: 2 * 1024 * 1024,
  /** tools/call arguments on the rpc route. */
  rpcArgumentsBytes: 64 * 1024,
  /** resources/read through the rpc route. */
  rpcResourceBytes: 8 * 1024 * 1024,
  /** appMessage sends per app row per hour. */
  messagesPerHour: 20,
  /** rpc calls per app row per minute. */
  rpcPerMinute: 60,
} as const;

/** Versions of one bot page kept for stepping back, the current one included. */
export const APP_PAGE_VERSIONS = 10;

export type AppSource = "html" | "mcp";

/** Origins a frame may reach, after the host's filter. `refused`: what a server asked for and the
 * filter dropped. */
export interface AppNetwork {
  connect: string[];
  resources: string[];
  refused?: string[];
}

/** The latest ui/update-model-context of one app row, delivered with the person's next message in
 * its thread. */
export interface AppContextState {
  text: string;
  at: number;
  delivered: boolean;
}

export interface AppMcpRef {
  /** the mount name in config.json mcpServers */
  server: string;
  /** initialize serverInfo.title ?? name */
  serverTitle?: string;
  tool: string;
  /** ui://... */
  resourceUri: string;
  isError?: boolean;
}

/** Never carries the HTML: a client fetches the AppDocument when it mounts the frame. */
export interface AppPayload {
  v: 1;
  source: AppSource;
  /** Header title, one line, ≤ 80 chars. Bot HTML: the bot's title. MCP:
   * the tool's title, else its name. */
  title: string;
  /** Content id of the stored document; a new value means the frame must reload. Empty when nothing
   * could be stored (`blocked`): the row then shows only its text. */
  doc: string;
  /** 0, bumped by update_html. */
  rev: number;
  /** Content ids of the versions before `doc`, oldest first, at most APP_PAGE_VERSIONS - 1: the last one is
   * rev - 1. */
  history?: string[];
  /** Bot HTML whose document is a React component file (show_html `jsx`), wrapped in the page shell when served. */
  format?: "jsx";
  /** UTF-8 bytes of the HTML, for the info popover. */
  bytes: number;
  /** Initial height in px before the frame reports its own (show_html
   * `height`, clamped 80..720). */
  height?: number;
  /** Draw the host's border and background (MCP prefersBorder; bot HTML: true). */
  border: boolean;
  /** Origins the frame may reach, after the host's filter, for the info popover. */
  network: AppNetwork;
  mcp?: AppMcpRef;
  /** The latest ui/update-model-context, delivered with the person's next
   * message in this thread. */
  context?: AppContextState;
  /** Why the document could not be stored or read when the row was written
   * (`too-large`, or an MCP server that was signed out or unreachable). The
   * row is still written, with its text. */
  blocked?: AppBlockedReason;
}

/** A user row an app's ui/message sent. */
export interface AppFromRef {
  messageId: string;
  title: string;
}

/** One part of a bot's page the person pointed at, as its chip on their message reads. `label` is the page's own
 * words. */
export interface AppPointedRef {
  appId: string;
  label: string;
}

/** Why an app's server calls are off, or why its document is missing. `unavailable`: the UI resource
 * could not be read when the row was written (offline, wrong mime type). */
export type AppBlockedReason = "signed-out" | "server-removed" | "server-disabled" | "apps-off" | "too-large" | "unavailable";

/** What the frame may do right now; hostCapabilities is built from this. */
export interface AppCan {
  serverTools: boolean;
  serverResources: boolean;
  message: boolean;
  openLinks: boolean;
  modelContext: boolean;
}

export interface AppToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: object;
  annotations?: object;
  _meta?: object;
}

export interface AppToolResult {
  content: unknown[];
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

/** What a client fetches to mount a frame (GET /api/threads/:threadId/messages/:messageId/app), never
 * part of a thread load. A document with `tool` is an MCP app; one without is bot HTML. */
export interface AppDocument {
  v: 1;
  messageId: string;
  rev: number;
  /** Set verbatim as the iframe's srcdoc. Starts with
   * `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="…">`. */
  srcdoc: string;
  /** The policy in that meta, repeated for phone network enforcement. */
  csp: string;
  network: { connect: string[]; resources: string[] };
  /** MCP only: hostContext.toolInfo.tool, and the two notifications. */
  tool?: AppToolDefinition;
  toolInput?: Record<string, unknown>;
  toolResult?: AppToolResult;
  can: AppCan;
  /** Why serverTools/serverResources are off: drawn as a strip under the frame. */
  blocked?: { reason: AppBlockedReason; text: string };
}

/** Exactly one of `html` (wrapped when it was a fragment), `jsx` and `path` (a folder with index.html, or an .html
 * file, in the bot's own folders), none yet scrubbed of secrets. */
export interface ShowHtmlInput {
  html?: string;
  jsx?: string;
  path?: string;
  title: string;
  height?: number;
  fallbackText?: string;
}

export interface UpdateHtmlInput {
  appId: string;
  html?: string;
  jsx?: string;
  path?: string;
  title?: string;
}

export type AppInputResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A fragment gets a minimal document, so the CSP meta can lead its head. */
export function wrapHtmlFragment(html: string): string {
  if (/<(?:html|body)[\s>/]/i.test(html) || /<(?:html|body)$/i.test(html)) return html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

function checkHtml(value: unknown): AppInputResult<string> {
  if (typeof value !== "string") return { ok: false, error: "html: must be a string holding one HTML document." };
  const html = value.trim();
  if (!html) return { ok: false, error: "html: is empty; send one HTML document with inline style and script." };
  const bytes = utf8Bytes(html);
  if (bytes > APP_LIMITS.htmlBytes) {
    return { ok: false, error: `html: is ${bytes} bytes, over the ${APP_LIMITS.htmlBytes}-byte limit; load libraries from a CDN and embed less data.` };
  }
  return { ok: true, value: wrapHtmlFragment(html) };
}

function checkJsx(value: unknown): AppInputResult<string> {
  if (typeof value !== "string") return { ok: false, error: "jsx: must be a string holding one React component file." };
  const jsx = value.trim();
  if (!jsx) return { ok: false, error: "jsx: is empty; send one React component file with a default export." };
  const bytes = utf8Bytes(jsx);
  if (bytes > APP_LIMITS.htmlBytes) return { ok: false, error: `jsx: is ${bytes} bytes, over the ${APP_LIMITS.htmlBytes}-byte limit; embed less data.` };
  if (!/\bexport\s+default\b/.test(jsx)) return { ok: false, error: "jsx: needs `export default` of the page's component." };
  return { ok: true, value: jsx };
}

function checkPage(input: Record<string, unknown>): AppInputResult<{ html: string } | { jsx: string } | { path: string }> {
  const given = (value: unknown) => value !== undefined && value !== null;
  if ([input.html, input.jsx, input.path].filter(given).length > 1) return { ok: false, error: "Send one of html, jsx or path." };
  if (given(input.path)) {
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path || path.length > 4_096) return { ok: false, error: "path: the folder with index.html, or the .html file, in your working folder." };
    return { ok: true, value: { path } };
  }
  if (given(input.jsx)) {
    const jsx = checkJsx(input.jsx);
    return jsx.ok ? { ok: true, value: { jsx: jsx.value } } : jsx;
  }
  const html = checkHtml(input.html);
  return html.ok ? { ok: true, value: { html: html.value } } : html;
}

function checkTitle(value: unknown): AppInputResult<string> {
  if (typeof value !== "string") return { ok: false, error: "title: must be a string of 1 to 80 characters." };
  const title = oneLine(value);
  if (!title || title.length > APP_LIMITS.title) return { ok: false, error: "title: must be 1 to 80 characters on one line." };
  return { ok: true, value: title };
}

export function parseShowHtmlInput(input: unknown): AppInputResult<ShowHtmlInput> {
  if (!isRecord(input)) return { ok: false, error: "show_html needs {html, jsx or path, title, height?, fallback_text?}." };
  const page = checkPage(input);
  if (!page.ok) return page;
  const title = checkTitle(input.title);
  if (!title.ok) return title;
  const out: ShowHtmlInput = { ...page.value, title: title.value };
  if (input.height !== undefined && input.height !== null) {
    if (typeof input.height !== "number" || !Number.isFinite(input.height)) return { ok: false, error: "height: must be a number of pixels, 80 to 720." };
    out.height = Math.round(Math.min(APP_LIMITS.heightMax, Math.max(APP_LIMITS.heightMin, input.height)));
  }
  if (input.fallback_text !== undefined && input.fallback_text !== null) {
    if (typeof input.fallback_text !== "string") return { ok: false, error: "fallback_text: must be a string." };
    const fallback = input.fallback_text.trim();
    if (fallback.length > APP_LIMITS.fallback) return { ok: false, error: `fallback_text: must be at most ${APP_LIMITS.fallback} characters.` };
    if (fallback) out.fallbackText = fallback;
  }
  return { ok: true, value: out };
}

export function parseUpdateHtmlInput(input: unknown): AppInputResult<UpdateHtmlInput> {
  if (!isRecord(input)) return { ok: false, error: "update_html needs {app_id, html, jsx or path, title?}." };
  if (typeof input.app_id !== "string" || !/^[\w-]{1,128}$/.test(input.app_id.trim())) {
    return { ok: false, error: "app_id: is required, the id show_html returned." };
  }
  const page = checkPage(input);
  if (!page.ok) return page;
  const out: UpdateHtmlInput = { appId: input.app_id.trim(), ...page.value };
  if (input.title !== undefined && input.title !== null) {
    const title = checkTitle(input.title);
    if (!title.ok) return title;
    out.title = title.value;
  }
  return { ok: true, value: out };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

/** A preview, not a parser or a sanitizer: it only ever feeds the row's readable fallback. */
export function htmlVisibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|template|noscript|title|head)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<[^>]*>?/g, " ")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+\d*);/gi, (whole, name: string) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower] !== undefined) return ENTITIES[lower]!;
      const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : lower.startsWith("#") ? Number.parseInt(lower.slice(1), 10) : NaN;
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function htmlFallbackText(title: string, html: string, fallbackText?: string): string {
  const given = fallbackText?.trim();
  if (given) return clip(given, APP_LIMITS.fallback);
  const visible = clip(htmlVisibleText(html), APP_LIMITS.fallbackExcerpt);
  return clip(visible ? `[App] ${title}\n${visible}` : `[App] ${title}`, APP_LIMITS.fallback);
}

export function mcpAppFallbackText(serverTitle: string, toolTitle: string, result: { content?: unknown } | undefined): string {
  const texts = Array.isArray(result?.content)
    ? result.content.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    : [];
  const excerpt = clip(oneLine(texts.join(" ")), APP_LIMITS.fallbackExcerpt);
  const head = `${oneLine(serverTitle)} · ${oneLine(toolTitle)}`;
  return clip(excerpt ? `${head}\n${excerpt}` : head, APP_LIMITS.fallback);
}

export function appBlockedText(reason: AppBlockedReason, server?: string): string {
  const name = server?.trim() || "This app's server";
  switch (reason) {
    case "signed-out": return `Sign in to ${name} again`;
    case "server-removed": return `${name} is no longer connected`;
    case "server-disabled": return `${name} is switched off in Settings`;
    case "apps-off": return `Apps from ${name} are switched off in Settings`;
    case "too-large": return "This app is too large to store";
    case "unavailable": return `${name} did not send this app's page`;
  }
}
