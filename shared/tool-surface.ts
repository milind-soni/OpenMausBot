// Which place a tool call touched, read from its name alone, the same way on
// the server and in the renderer. Names arrive namespaced
// (`mcp__computer__click`, `computer__click`), prefixed (`computer_click`) or
// bare (`click`).

/** Tools whose completion can change what a screen shows. A bot on a
 * computer is illustrated only after one of these; the built-in browser's
 * read-only calls (snapshot, read, get_text, waits) stay out by the same rule. */
export const SCREEN_TOUCHING_TOOLS: ReadonlySet<string> = new Set([
  // cloud boat / remote computer
  "screenshot", "click", "type_text", "press_key", "key_press", "scroll", "computer_batch", "open_url", "browser_click", "browser_fill",
  // built-in browser: the Electron surface's names, from older remote harnesses
  "browser_navigate", "browser_type", "browser_press", "browser_scroll", "browser_hover", "browser_drag",
  "browser_select_option", "browser_back", "browser_forward", "browser_screenshot",
  // built-in browser: agent-browser's names, and the new browser's
  "agent_browser_open", "agent_browser_click", "agent_browser_fill", "agent_browser_type", "agent_browser_press",
  "agent_browser_select", "agent_browser_check", "agent_browser_screenshot", "agent_browser_hover", "agent_browser_upload",
  "agent_browser_navigate", "agent_browser_drag", "agent_browser_scroll", "agent_browser_tabs", "agent_browser_dialog", "agent_browser_eval",
  // Cua Driver (local Mac, Local VM, VPS)
  "double_click", "right_click", "drag", "hotkey", "move_cursor", "launch_app", "bring_to_front", "zoom",
]);

// Legacy MCP namespaces, or a desktop server__tool name under the MCP_NAME rule.
export const TOOL_NAMESPACE = /^(?:mcp__.+?|[a-z][a-z0-9_-]{0,31})__/;

/** The same tool reaches the poke site as `mcp__computer__click`,
 * `computer__click`, bare `click`, or pi's `computer_click`. A single-underscore
 * server prefix is stripped at most once, so pi's `computer_computer_exec`
 * lands on `computer_exec` (still a shell) and never on a bare `exec`. */
export function screenTouchingTool(toolName: string): boolean {
  const bare = toolName.toLowerCase().replace(TOOL_NAMESPACE, "");
  return SCREEN_TOUCHING_TOOLS.has(bare) || SCREEN_TOUCHING_TOOLS.has(bare.replace(/^(?:computer|browser)_/, ""));
}

/** Which surface a screen-touching tool acted on. The computer server's
 * browser_click/fill act inside the desktop, not in agent-browser, so the
 * server identity is checked before prefixes are stripped. */
export function screenSurfaceForTool(toolName: string): "browser" | "computer" {
  const name = toolName.toLowerCase();
  if (name.startsWith("mcp__computer__") || name.startsWith("computer_")) return "computer";
  if (name.startsWith("mcp__browser__") || name.startsWith("browser__")) return "browser";
  const bare = name.replace(TOOL_NAMESPACE, "");
  if (bare === "browser_click" || bare === "browser_fill") return "computer";
  return bare.startsWith("agent_browser_") || bare.startsWith("browser_") ? "browser" : "computer";
}

/** Whether a tool belongs to a screen place at all — the built-in browser, a
 * computer, or neither (shell, files, teammates, memory). Unlike
 * screenSurfaceForTool this never guesses "computer" for an unrelated tool. */
export function toolSurfaceKind(toolName: string): "browser" | "computer" | null {
  const name = toolName.toLowerCase();
  if (name.startsWith("mcp__browser__") || name.startsWith("browser__")) return "browser";
  if (name.startsWith("mcp__computer__") || name.startsWith("computer__") || name.startsWith("computer_")) return "computer";
  const bare = name.replace(TOOL_NAMESPACE, "");
  if (bare === "browser_click" || bare === "browser_fill") return "computer";
  if (bare.startsWith("agent_browser_") || bare.startsWith("browser_")) return "browser";
  return SCREEN_TOUCHING_TOOLS.has(bare) ? "computer" : null;
}
