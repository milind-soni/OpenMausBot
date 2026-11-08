// agent-browser 0.37.0's core profile advertises 29 tools at ~12.5k tokens, mostly fifteen launch/session parameters
// repeated on every tool, and every result arrives twice (text plus a 3-5x larger structuredContent that Codex keeps in history).
import { BrowserHostError, loaderMissingLibrary } from "./browser/chrome/host-setup.ts";
import { trimResultText } from "./mcp-trim.ts";

/** A model must never set these: `session` reaches another bot's browser, `extraArgs`/`caCert`/`headed`/`webgpu`/`webmcp`
 * change the launch (`headed` overrides AGENT_BROWSER_HEADED), `all` on close closes every bot's browser, and a
 * screenshot's `path`/`screenshotDir` writes anywhere the server can. */
export const HARNESS_OWNED_BROWSER_PARAMS: ReadonlySet<string> = new Set([
  "all", "allowedDomains", "caCert", "clearCaCert", "extraArgs", "headed", "idleTimeout", "namespace", "path",
  "restore", "restoreCheckFn", "restoreCheckText", "restoreCheckUrl", "restoreSave", "screenshotDir", "session", "timeoutMs", "webgpu", "webmcp",
]);

/** ~8k tokens: a heavy encyclopedia article's interactive snapshot (21k chars) fits; a whole product page as markdown (79k) does not. */
export const DEFAULT_BROWSER_RESULT_BUDGET = 32_000;

const BROWSER_NARROWING_HINT =
  " For a snapshot, pass selector or depth, or set compact; for one value such as a price, use agent_browser_get_text with a selector instead of reading the whole page.";

type Tool = { inputSchema?: { properties?: Record<string, unknown>; required?: unknown } & Record<string, unknown> } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function verifiedBrowserNavigation(args: unknown, observation: unknown): boolean {
  if (!isRecord(observation) || observation.isError === true || !Array.isArray(observation.content)) return false;
  const structured = observation.structuredContent;
  const response = isRecord(structured) ? structured.response : undefined;
  const data = isRecord(response) ? response.data : undefined;
  const url = isRecord(args) ? args.url : undefined;
  if (typeof url === "string" && /^https?:\/\//i.test(url.trim()) &&
      isRecord(data) && data.origin === "about:blank") return false;
  return observation.content.some((item) => isRecord(item) && item.type === "text" &&
    typeof item.text === "string" && item.text.trim().length > 0);
}

/** agent-browser 0.37.0 fetches a `url` given to agent_browser_read with its own HTTP client, around the browser and its
 * egress gate, and ignores every proxy setting; without one it reads the open tab. */
const READ_TOOL = "agent_browser_read";
export const READ_OPEN_PAGE_ONLY = "agent_browser_read reads the page open in this browser. Open the address with agent_browser_open first, then call agent_browser_read without url.";

export function readsAroundBrowser(params: unknown): boolean {
  return isRecord(params) && params.name === READ_TOOL && isRecord(params.arguments) && params.arguments.url !== undefined;
}

export function slimBrowserToolList(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.tools)) return result;
  const tools = (result.tools as unknown[]).map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.inputSchema)) return tool;
    const schema = tool.inputSchema as NonNullable<Tool["inputSchema"]>;
    const hidden = (name: string) => HARNESS_OWNED_BROWSER_PARAMS.has(name) || (tool.name === READ_TOOL && name === "url");
    const properties = isRecord(schema.properties)
      ? Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !hidden(name)))
      : schema.properties;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name) => typeof name !== "string" || !hidden(name))
      : schema.required;
    return { ...tool, inputSchema: { ...schema, ...(properties === undefined ? {} : { properties }), ...(required === undefined ? {} : { required }) } };
  });
  return { ...result, tools };
}

export function stripHarnessOwnedArguments(params: unknown): unknown {
  if (!isRecord(params) || !isRecord(params.arguments)) return params;
  const kept = Object.entries(params.arguments).filter(([name]) => !HARNESS_OWNED_BROWSER_PARAMS.has(name));
  return kept.length === Object.keys(params.arguments).length ? params : { ...params, arguments: Object.fromEntries(kept) };
}

/** agent-browser's `lifecycle` block is ~330 of a click's 420 characters; only a relaunch (pages and refs gone) is kept. */
export function withoutLifecycle(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!isRecord(parsed) || !isRecord(parsed.data) || !isRecord(parsed.data.lifecycle)) return text;
  const { lifecycle, ...data } = parsed.data;
  if (lifecycle.relaunchedBrowser === true) data.browserRelaunched = true;
  return JSON.stringify({ ...parsed, data });
}

export interface PageState { url: string; title: string; text: string }

/** agent-browser renumbers every @eN ref on each snapshot, so the page is read with eval and a model's refs stay valid. */
export const OBSERVE_PAGE_SCRIPT =
  "JSON.stringify({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 200000) })";

export function parsePageState(result: unknown): PageState | null {
  if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) return null;
  const text = (result.content as unknown[]).find((part) => isRecord(part) && part.type === "text" && typeof part.text === "string") as { text: string } | undefined;
  try {
    let value: unknown = JSON.parse(text?.text ?? "");
    if (typeof value === "string") value = JSON.parse(value);
    if (isRecord(value) && typeof value.url === "string" && typeof value.title === "string" && typeof value.text === "string") {
      return { url: value.url, title: value.title, text: value.text };
    }
  } catch {}
  return null;
}

const CHANGE_LINES = 20;
const CHANGE_CHARS = 1_500;

function visibleLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function linesOnlyIn(next: string[], previous: string[]): string[] {
  const left = new Map<string, number>();
  for (const line of previous) left.set(line, (left.get(line) ?? 0) + 1);
  return next.filter((line) => {
    const count = left.get(line) ?? 0;
    if (count) left.set(line, count - 1);
    return !count;
  });
}

function listLines(lines: string[]): string {
  const shown: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (shown.length === CHANGE_LINES || chars + line.length > CHANGE_CHARS) break;
    shown.push(JSON.stringify(line));
    chars += line.length;
  }
  return shown.join(", ") + (shown.length < lines.length ? ` and ${lines.length - shown.length} more lines` : "");
}

const SENSITIVE_PARAM = /token|code|key|secret|pass|pwd|auth|session|sig|otp|state|nonce|credential|ticket|email/iu;
/** A hash route names a page; any other fragment may carry a token, as OAuth's `#access_token=…` does. */
const HASH_ROUTE = /^#!?\/[\w\-./~%]*$/u;

/** Origin, path and query with sensitive values (and any email) replaced by `…`; no credentials, no fragment beyond a hash route. */
export function sanitizeUrl(href: string): string {
  let url: URL;
  try { url = new URL(href); } catch {
    try { url = new URL(`https://${href}`); } catch { return ""; }
    if (!url.hostname.includes(".")) return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol === "about:" ? "about:blank" : `${url.protocol}…`;
  const query = [...url.searchParams].map(([key, value]) =>
    `${encodeURIComponent(key)}=${SENSITIVE_PARAM.test(key) || value.includes("@") ? "…" : encodeURIComponent(value)}`).join("&");
  const text = `${url.origin}${url.pathname}${query ? `?${query}` : ""}${HASH_ROUTE.test(url.hash) ? url.hash : ""}`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

export function describePageChange(before: PageState, after: PageState): string {
  if (after.url !== before.url) {
    return `The page is now ${sanitizeUrl(after.url) || "a new address"}${after.title ? ` (${JSON.stringify(after.title)})` : ""}. Refs from earlier snapshots do not apply to it; take a snapshot before acting on refs.`;
  }
  const previous = visibleLines(before.text);
  const next = visibleLines(after.text);
  const added = linesOnlyIn(next, previous);
  const removed = linesOnlyIn(previous, next);
  const title = after.title !== before.title ? ` The title is now ${JSON.stringify(after.title)}.` : "";
  if (!added.length && !removed.length) return `The visible text of the page did not change.${title}`;
  return [
    added.length ? `Text that appeared on the page: ${listLines(added)}.` : "",
    removed.length ? `Text that disappeared: ${listLines(removed)}.` : "",
  ].filter(Boolean).join(" ") + title;
}

/** agent-browser's own error when the Chrome it launched dies before DevTools is up. */
const LAUNCH_FAILURE = "Chrome exited early (exit code:";
/** agent-browser prints that launch's stderr after this line ("Chrome stderr:" or "Chrome stderr (last N lines):"). */
const CHROME_STDERR = /^Chrome stderr(?: \(last \d+ lines\))?:$/m;
const MAX_LIBRARY_NAME = 120;

/** The library a failed Chrome launch's own stderr names, not one a page's text merely quotes. */
function launchMissingLibrary(text: string): string | undefined {
  if (!text.trimStart().startsWith(LAUNCH_FAILURE)) return undefined;
  const stderr = CHROME_STDERR.exec(text);
  const library = stderr ? loaderMissingLibrary(text.slice(stderr.index)) : undefined;
  return library && library.length > MAX_LIBRARY_NAME ? `${library.slice(0, MAX_LIBRARY_NAME)}…` : library;
}

export function shapeBrowserToolResult(result: unknown, options: { toolName?: string; budget?: number } = {}): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const budget = options.budget ?? DEFAULT_BROWSER_RESULT_BUDGET;
  let textParts = 0;
  let library: string | undefined;
  const content = (result.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
    textParts++;
    if (result.isError === true && process.platform === "linux") library ??= launchMissingLibrary(part.text);
    const outcome = trimResultText({ text: withoutLifecycle(part.text), budget, toolName: options.toolName });
    return { ...part, text: outcome.trimmed ? outcome.text + BROWSER_NARROWING_HINT : outcome.text };
  });
  if (!textParts) return { ...result, content };
  // agent-browser launches Chrome itself, so a host missing system libraries
  // only shows the loader's words; say how to install them, as our own launch does.
  // The advice leads the first text part: some MCP clients show only that one,
  // and a long stderr can be cut off at the end.
  if (library) {
    const first = content.find((part): part is { text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string");
    if (first) first.text = `${new BrowserHostError("libraries", [library]).message}\n\n${first.text}`;
  }
  return { ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "structuredContent")), content };
}

/** Images and binary data pass through: a screenshot cannot be scrubbed. */
export function scrubBrowserResult(result: unknown, scrub: (text: string) => string, depth = 0): unknown {
  if (typeof result === "string") return scrub(result);
  if (depth > 32 || result === null || typeof result !== "object") return result;
  if (Array.isArray(result)) return result.map((item) => scrubBrowserResult(item, scrub, depth + 1));
  const record = result as Record<string, unknown>;
  const binary = record.type === "image" || record.type === "audio";
  return Object.fromEntries(Object.entries(record).map(([key, value]) =>
    [key, (binary && key === "data") || key === "blob" ? value : scrubBrowserResult(value, scrub, depth + 1)]));
}
