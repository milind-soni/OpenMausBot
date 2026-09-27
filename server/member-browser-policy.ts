// What a member workspace's browser tools may be asked. The browser runs on
// this machine, so the core tools of agent-browser 0.37.0 (measured
// 2026-09-27) are narrowed where they would otherwise reach past the web:
//   - open and tab_new take web addresses only (http, https, about:blank): a
//     file:// address opens this machine's files, chrome:// its settings;
//   - read may not be given a url: agent-browser fetches that itself, outside
//     Chrome and past the egress guard (browser-egress-guard.ts). The model
//     opens the page, then reads it;
//   - screenshot keeps its picture inline: `path` and `screenshotDir` would
//     write a file anywhere this server may write;
//   - `headed` (there is no display) and `webmcp` (page-provided tools) stay off.
// Tools outside this list (upload, state files, profiles, downloads) are
// refused rather than trusted to be absent from the engine.

export const MEMBER_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "agent_browser_tools_profiles", "agent_browser_open", "agent_browser_read", "agent_browser_snapshot",
  "agent_browser_click", "agent_browser_fill", "agent_browser_type", "agent_browser_press",
  "agent_browser_check", "agent_browser_uncheck", "agent_browser_select", "agent_browser_scroll",
  "agent_browser_wait_ms", "agent_browser_wait_for_selector", "agent_browser_wait_for_text", "agent_browser_wait_for_load",
  "agent_browser_screenshot", "agent_browser_get_text", "agent_browser_get_url", "agent_browser_get_title",
  "agent_browser_eval", "agent_browser_close", "agent_browser_back", "agent_browser_forward", "agent_browser_reload",
  "agent_browser_tab_new", "agent_browser_tab_list", "agent_browser_tab_switch", "agent_browser_tab_close",
]);

/** Arguments dropped from every call and every advertised schema. */
export const MEMBER_BROWSER_DROPPED_PARAMS: ReadonlySet<string> = new Set(["path", "screenshotDir", "headed", "webmcp"]);

const ADDRESS_TOOLS = new Set(["agent_browser_open", "agent_browser_tab_new"]);

export const MEMBER_BROWSER_WEB_ONLY = "Only web addresses (http or https) can be opened in the NATION browser.";
export const MEMBER_BROWSER_READ_URL = "Open the page with agent_browser_open first, then call agent_browser_read without a url.";
export const MEMBER_BROWSER_UNKNOWN_TOOL = "That browser tool is not available in NATION.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A web address a member's browser may open. */
export function memberBrowserAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.trim() === "about:blank") return true;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The call to forward, with the dropped arguments removed, or why it is refused. */
export function memberBrowserCall(params: unknown): { params: unknown } | { error: string } {
  if (!isRecord(params) || typeof params.name !== "string") return { error: MEMBER_BROWSER_UNKNOWN_TOOL };
  if (!MEMBER_BROWSER_TOOLS.has(params.name)) return { error: MEMBER_BROWSER_UNKNOWN_TOOL };
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (ADDRESS_TOOLS.has(params.name) && args.url !== undefined && !memberBrowserAddress(args.url)) return { error: MEMBER_BROWSER_WEB_ONLY };
  if (params.name === "agent_browser_read" && args.url !== undefined) return { error: MEMBER_BROWSER_READ_URL };
  const kept = Object.fromEntries(Object.entries(args).filter(([name]) => !MEMBER_BROWSER_DROPPED_PARAMS.has(name)));
  return { params: { ...params, arguments: kept } };
}

/** The tool list a member's model sees: the allowed tools, without the dropped
 * arguments, and read without its url. */
export function memberBrowserToolList(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.tools)) return result;
  const tools = (result.tools as unknown[]).flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string" || !MEMBER_BROWSER_TOOLS.has(tool.name)) return [];
    if (!isRecord(tool.inputSchema)) return [tool];
    const schema = tool.inputSchema;
    const hidden = (name: string) => MEMBER_BROWSER_DROPPED_PARAMS.has(name) || (tool.name === "agent_browser_read" && name === "url");
    const properties = isRecord(schema.properties)
      ? Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !hidden(name)))
      : schema.properties;
    const required = Array.isArray(schema.required) ? schema.required.filter((name) => typeof name !== "string" || !hidden(name)) : schema.required;
    return [{ ...tool, inputSchema: { ...schema, ...(properties === undefined ? {} : { properties }), ...(required === undefined ? {} : { required }) } }];
  });
  return { ...result, tools };
}
