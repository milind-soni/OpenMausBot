// What the built-in browser shows a model, and what its results put into the
// conversation. Pure: the runtime applies it on every MCP frame.
//
// Measured on agent-browser 0.37.0 (2026-09-15, main): the core profile
// advertises 29 tools at ~12.5k tokens of schema, of which ~440 tokens are the
// tool descriptions. The rest is fifteen launch/session parameters repeated on
// every tool. Every result also arrives twice — `content[].text` and a
// `structuredContent` object 3-5x larger — and Codex keeps the structured form
// in history: a product-page snapshot cost 10-17k tokens instead of 2-4k, and
// every later model call in the thread re-read it. This module fixes both at
// the boundary so the saving applies to every engine.
import { trimResultText } from "./mcp-trim.ts";

/** Launch, session and network settings OpenMausBot owns through the
 * environment (see browser-engine.ts). A model has no business setting them
 * per call — `session` would reach another bot's browser, `extraArgs`,
 * `caCert` and `headed` change the launch — and each one cost more schema
 * than the tool's own description. `headed` in particular overrides
 * AGENT_BROWSER_HEADED and the managed config, so a single call can pin a
 * daemon to a launch mode this host cannot satisfy (#1383). */
export const HARNESS_OWNED_BROWSER_PARAMS: ReadonlySet<string> = new Set([
  "allowedDomains", "caCert", "clearCaCert", "extraArgs", "headed", "idleTimeout", "namespace",
  "restore", "restoreCheckFn", "restoreCheckText", "restoreCheckUrl", "restoreSave", "session", "timeoutMs",
]);

/** Characters of one browser result that may enter the model's context.
 * ~8k tokens: the interactive snapshot of a heavy encyclopedia article
 * (21k chars) fits; a whole product page read as markdown (79k) does not. */
export const DEFAULT_BROWSER_RESULT_BUDGET = 32_000;

const BROWSER_NARROWING_HINT =
  " For a snapshot, pass selector or depth, or set compact; for one value such as a price, use agent_browser_get_text with a selector instead of reading the whole page.";

type Tool = { inputSchema?: { properties?: Record<string, unknown>; required?: unknown } & Record<string, unknown> } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Remove harness-owned parameters from every advertised tool schema. */
export function slimBrowserToolList(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.tools)) return result;
  const tools = (result.tools as unknown[]).map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.inputSchema)) return tool;
    const schema = tool.inputSchema as NonNullable<Tool["inputSchema"]>;
    const properties = isRecord(schema.properties)
      ? Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !HARNESS_OWNED_BROWSER_PARAMS.has(name)))
      : schema.properties;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name) => typeof name !== "string" || !HARNESS_OWNED_BROWSER_PARAMS.has(name))
      : schema.required;
    return { ...tool, inputSchema: { ...schema, ...(properties === undefined ? {} : { properties }), ...(required === undefined ? {} : { required }) } };
  });
  return { ...result, tools };
}

/** Drop harness-owned arguments a model sent anyway. */
export function stripHarnessOwnedArguments(params: unknown): unknown {
  if (!isRecord(params) || !isRecord(params.arguments)) return params;
  const kept = Object.entries(params.arguments).filter(([name]) => !HARNESS_OWNED_BROWSER_PARAMS.has(name));
  return kept.length === Object.keys(params.arguments).length ? params : { ...params, arguments: Object.fromEntries(kept) };
}

/** agent-browser's action results carry a `lifecycle` block about the
 * daemon (launch hash, restore status...): about 330 of a click's 420
 * characters. Keep only the fact a model can act on, a relaunched browser,
 * whose pages and refs are gone. Text that is not such a result is unchanged. */
export function withoutLifecycle(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!isRecord(parsed) || !isRecord(parsed.data) || !isRecord(parsed.data.lifecycle)) return text;
  const { lifecycle, ...data } = parsed.data;
  if (lifecycle.relaunchedBrowser === true) data.browserRelaunched = true;
  return JSON.stringify({ ...parsed, data });
}

/** The URL, title and visible text the runtime reads around an action. */
export interface PageState { url: string; title: string; text: string }

/** In-page script for PageState. agent-browser renumbers every @eN ref on
 * each snapshot, so the runtime reads the page with eval, never a snapshot:
 * the refs a model holds keep pointing at the same elements. */
export const OBSERVE_PAGE_SCRIPT =
  "JSON.stringify({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 200000) })";

/** Parse an eval result of OBSERVE_PAGE_SCRIPT: a JSON string inside the
 * result text. Null when the result is anything else. */
export function parsePageState(result: unknown): PageState | null {
  if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) return null;
  const text = (result.content as unknown[]).find((part) => isRecord(part) && part.type === "text" && typeof part.text === "string") as { text: string } | undefined;
  try {
    let value: unknown = JSON.parse(text?.text ?? "");
    if (typeof value === "string") value = JSON.parse(value);
    if (isRecord(value) && typeof value.url === "string" && typeof value.title === "string" && typeof value.text === "string") {
      return { url: value.url, title: value.title, text: value.text };
    }
  } catch { /* not a page state */ }
  return null;
}

const CHANGE_LINES = 20;
const CHANGE_CHARS = 1_500;

function visibleLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Lines of `next` that `previous` does not have, counting repeats. */
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

/** What a model needs after an action so it does not read the page back:
 * where the page is now, or which lines of visible text the action added or
 * removed. Text only: it does not prove the action did what was meant. */
export function describePageChange(before: PageState, after: PageState): string {
  if (after.url !== before.url) {
    return `The page is now ${after.url}${after.title ? ` (${JSON.stringify(after.title)})` : ""}. Refs from earlier snapshots do not apply to it; take a snapshot before acting on refs.`;
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

/** Keep the text form of a result, drop its structured duplicate, and cut
 * oversized text with a marker that says how to ask for less next time. */
export function shapeBrowserToolResult(result: unknown, options: { toolName?: string; budget?: number } = {}): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const budget = options.budget ?? DEFAULT_BROWSER_RESULT_BUDGET;
  let textParts = 0;
  const content = (result.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
    textParts++;
    const outcome = trimResultText({ text: withoutLifecycle(part.text), budget, toolName: options.toolName });
    return { ...part, text: outcome.trimmed ? outcome.text + BROWSER_NARROWING_HINT : outcome.text };
  });
  if (!textParts) return { ...result, content };
  return { ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "structuredContent")), content };
}
