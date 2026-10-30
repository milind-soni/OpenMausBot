// What Cua Driver 0.28.2 lists on Windows (its MCP reference for that version: 57 tools), and stdio MCP servers that list
// synthetic tools by name, for turns shaped like a real one.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CUA_DRIVER_WINDOWS_TOOLS: readonly string[] = [
  "list_apps", "list_windows", "get_window_state", "get_accessibility_tree", "get_desktop_state", "get_screen_size",
  "get_cursor_position", "get_config", "get_recording_state", "get_agent_cursor_state",
  "launch_app", "kill_app", "bring_to_front", "set_window_frame", "click", "double_click", "right_click", "drag", "type_text",
  "press_key", "hotkey", "set_value", "scroll", "move_cursor", "zoom",
  "page", "clipboard_read", "clipboard_write", "start_recording", "stop_recording", "replay_trajectory",
  "set_config", "start_session", "end_session", "set_agent_cursor_enabled", "set_agent_cursor_motion",
  "check_permissions", "health_report", "check_for_update", "install_ffmpeg",
  "verify_state", "invoke_menu", "debug_window_info", "set_agent_cursor_theme", "get_browser_state", "browser_prepare",
  "browser_navigate", "browser_click", "browser_type", "browser_dialog", "browser_set_input_files", "browser_download",
  "browser_pointer", "escalate_session", "get_session", "list_sessions", "get_session_state",
];

/** `count` tool names that read as one server's own, `prefix_1` onwards. */
export function syntheticToolNames(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index + 1}`);
}

const CATALOG_SERVER = `
import { createInterface } from "node:readline";
const names = JSON.parse(process.env.CATALOG_TOOLS);
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  else if (request.method === "tools/list") reply(request.id, { tools: names.map((name) => ({ name, description: "Synthetic " + name, inputSchema: { type: "object" } })) });
  else if (request.id !== undefined) reply(request.id, { content: [{ type: "text", text: "ran " + request.params?.name }] });
});
`;

/** A stdio MCP server, as a turn's integrations take it, that lists exactly `names`. Remove `dir` when done. */
export function catalogServer(names: readonly string[]): { dir: string; server: { command: string; args: string[]; env: Record<string, string> } } {
  const dir = mkdtempSync(join(tmpdir(), "omb-catalog-mcp-"));
  const script = join(dir, "catalog.mjs");
  writeFileSync(script, CATALOG_SERVER);
  return { dir, server: { command: process.execPath, args: [script], env: { CATALOG_TOOLS: JSON.stringify(names) } } };
}
