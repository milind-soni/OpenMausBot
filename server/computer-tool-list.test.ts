import { describe, expect, it } from "vitest";
import { LENT_SCREEN_TOOLS } from "../electron/lent-screen-tools.mjs";
import { listsComputerTool } from "./computer-tool-list.ts";
import { CUA_DRIVER_WINDOWS_TOOLS } from "./testing/cua-driver-tools.ts";

const SCREEN_WORK = [
  "list_apps", "list_windows", "get_window_state", "get_accessibility_tree", "get_desktop_state", "get_screen_size",
  "get_cursor_position", "launch_app", "kill_app", "bring_to_front", "set_window_frame", "click", "double_click", "right_click",
  "drag", "type_text", "press_key", "hotkey", "set_value", "scroll", "move_cursor", "zoom", "clipboard_read", "clipboard_write",
  "start_session", "end_session", "verify_state", "invoke_menu",
];
const DRIVER_BROWSER = ["page", "get_browser_state", "browser_prepare", "browser_navigate", "browser_click", "browser_type",
  "browser_dialog", "browser_set_input_files", "browser_download", "browser_pointer"];

describe("a turn's computer", () => {
  it("lists the screen work of Windows' 57 driver tools beside the built-in browser, and none of the driver's upkeep", () => {
    expect(CUA_DRIVER_WINDOWS_TOOLS).toHaveLength(57);
    expect(CUA_DRIVER_WINDOWS_TOOLS.filter((name) => listsComputerTool(name, true))).toEqual(SCREEN_WORK);
  });

  it("keeps the driver's own browser only when no built-in browser is mounted", () => {
    expect(CUA_DRIVER_WINDOWS_TOOLS.filter((name) => listsComputerTool(name, false)).sort()).toEqual([...SCREEN_WORK, ...DRIVER_BROWSER].sort());
  });

  it("keeps every screen tool a lent screen lends, but not the cursor looks or the session read-backs it carries", () => {
    const lent = [...LENT_SCREEN_TOOLS].filter((name) => !DRIVER_BROWSER.includes(name));
    expect(lent.filter((name) => !listsComputerTool(name, true)).sort()).toEqual([
      "escalate_session", "get_agent_cursor_state", "get_session_state", "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_style",
    ]);
  });
});
