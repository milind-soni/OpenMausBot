// Cua Driver 0.41.3 lists 62 tools on macOS and 66 on Linux (0.28.2 listed 57 on Windows): its screen tools, its own
// browser over CDP, its upkeep, and batch runners.

/** The driver's config, recordings, updates, extensions, guide and diagnostics, the look of its agent cursor, and the
 * session read-backs it keeps for older callers. */
const DRIVER_UPKEEP: ReadonlySet<string> = new Set([
  "get_config", "set_config",
  "get_recording_state", "start_recording", "stop_recording", "replay_trajectory",
  "check_for_update", "install_ffmpeg", "install_extension", "check_permissions", "health_report", "debug_window_info",
  "get_guide", "parse_visual_regions",
  "get_agent_cursor_state", "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_style", "set_agent_cursor_theme",
  "get_session", "list_sessions", "get_session_state", "escalate_session",
]);

/** Run many actions, or a script of them, in one call (0.41). Every screen action stays its own call, so each one gets
 * its own approval, guidance and result handling. */
const BATCH_RUNNERS: ReadonlySet<string> = new Set(["run_steps", "run_script"]);

function drivesItsOwnBrowser(name: string): boolean {
  return name.startsWith("browser_") || name === "get_browser_state" || name === "page";
}

/** Whether a turn's computer lists this tool to the model: never the driver's upkeep, and beside the built-in browser
 * not the driver's own browser either. */
export function listsComputerTool(name: string, besideBuiltInBrowser: boolean): boolean {
  return !DRIVER_UPKEEP.has(name) && !BATCH_RUNNERS.has(name) && !(besideBuiltInBrowser && drivesItsOwnBrowser(name));
}
