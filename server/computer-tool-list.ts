// Cua Driver 0.28.2 lists 57 tools on Windows and 56 on macOS: its screen tools, its own browser over CDP, and its upkeep.

/** The driver's config, recordings, updates and diagnostics, the look of its agent cursor, and the session read-backs it
 * keeps for older callers. */
const DRIVER_UPKEEP: ReadonlySet<string> = new Set([
  "get_config", "set_config",
  "get_recording_state", "start_recording", "stop_recording", "replay_trajectory",
  "check_for_update", "install_ffmpeg", "check_permissions", "health_report", "debug_window_info",
  "get_agent_cursor_state", "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_style", "set_agent_cursor_theme",
  "get_session", "list_sessions", "get_session_state", "escalate_session",
]);

function drivesItsOwnBrowser(name: string): boolean {
  return name.startsWith("browser_") || name === "get_browser_state" || name === "page";
}

/** Whether a turn's computer lists this tool to the model: never the driver's upkeep, and beside the built-in browser
 * not the driver's own browser either. */
export function listsComputerTool(name: string, besideBuiltInBrowser: boolean): boolean {
  return !DRIVER_UPKEEP.has(name) && !(besideBuiltInBrowser && drivesItsOwnBrowser(name));
}
