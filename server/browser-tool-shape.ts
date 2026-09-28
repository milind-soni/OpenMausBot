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
 * per call — `session` would reach another bot's browser, `extraArgs` and
 * `caCert` change the launch — and each one cost more schema than the tool's
 * own description. */
export const HARNESS_OWNED_BROWSER_PARAMS: ReadonlySet<string> = new Set([
  "allowedDomains", "caCert", "clearCaCert", "extraArgs", "idleTimeout", "namespace",
  "restore", "restoreCheckFn", "restoreCheckText", "restoreCheckUrl", "restoreSave", "session", "timeoutMs",
]);

/** Characters of one browser result that may enter the model's context.
 * ~8k tokens: the interactive snapshot of a heavy encyclopedia article
 * (21k chars) fits; a whole product page read as markdown (79k) does not. */
export const DEFAULT_BROWSER_RESULT_BUDGET = 32_000;

const BROWSER_NARROWING_HINT =
  " For a snapshot, pass selector or depth, or set compact; for one value such as a price, use agent_browser_get_text or agent_browser_find instead of reading the whole page.";

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

/** Keep the text form of a result, drop its structured duplicate, and cut
 * oversized text with a marker that says how to ask for less next time. */
export function shapeBrowserToolResult(result: unknown, options: { toolName?: string; budget?: number } = {}): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const budget = options.budget ?? DEFAULT_BROWSER_RESULT_BUDGET;
  let textParts = 0;
  const content = (result.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
    textParts++;
    const outcome = trimResultText({ text: part.text, budget, toolName: options.toolName });
    return outcome.trimmed ? { ...part, text: outcome.text + BROWSER_NARROWING_HINT } : part;
  });
  if (!textParts) return { ...result, content };
  return { ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "structuredContent")), content };
}
