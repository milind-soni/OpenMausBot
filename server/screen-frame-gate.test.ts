// The two gates between a completed turn and a screenshot in the chat. Both
// are pure, so every spelling a driver can hand the poke site — and every
// tool that must NOT count — is pinned down here.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { screenFrameHash, screenSurfaceForTool, screenTouchingTool, settledFrameIsNews } from "./screen-frame-gate.ts";

describe("screenTouchingTool", () => {
  it("strips the Claude driver's mcp__<server>__ prefix", () => {
    expect(screenTouchingTool("mcp__computer__click")).toBe(true);
    expect(screenTouchingTool("mcp__computer__screenshot")).toBe(true);
    expect(screenTouchingTool("mcp__browser__browser_navigate")).toBe(true);
  });

  it("counts agent-browser's tools, which the engine swap left out", () => {
    // The Electron surface's names were kept and agent-browser's were never
    // added, so every browser turn silently stopped earning a picture.
    expect(screenTouchingTool("mcp__browser__agent_browser_open")).toBe(true);
    expect(screenTouchingTool("agent_browser_click")).toBe(true);
    expect(screenTouchingTool("agent_browser_fill")).toBe(true);
    expect(screenTouchingTool("agent_browser_type")).toBe(true);
    expect(screenTouchingTool("agent_browser_press")).toBe(true);
    expect(screenTouchingTool("agent_browser_select")).toBe(true);
    expect(screenTouchingTool("agent_browser_check")).toBe(true);
    expect(screenTouchingTool("agent_browser_screenshot")).toBe(true);
  });

  it("still leaves agent-browser's read-only tools and waits out", () => {
    expect(screenTouchingTool("agent_browser_snapshot")).toBe(false);
    expect(screenTouchingTool("agent_browser_read")).toBe(false);
    expect(screenTouchingTool("agent_browser_get_text")).toBe(false);
    expect(screenTouchingTool("agent_browser_wait_for_text")).toBe(false);
    expect(screenTouchingTool("agent_browser_wait_for_load")).toBe(false);
  });

  it("takes the server__tool spelling the desktop's own cards use", () => {
    // The approval card for a browser turn reads `browser__agent_browser_open`
    // — the server segment without Claude's `mcp` in front. Stripping only
    // `mcp__<server>__` left this unmatched, so a browser turn still settled
    // with no picture even after agent-browser's tool names were added.
    expect(screenTouchingTool("browser__agent_browser_open")).toBe(true);
    expect(screenTouchingTool("browser__agent_browser_screenshot")).toBe(true);
    expect(screenSurfaceForTool("browser__agent_browser_open")).toBe("browser");
    // Not only the browser: the computer server's own tools carry the same
    // spelling and were missed the same way.
    expect(screenTouchingTool("computer__screenshot")).toBe(true);
    expect(screenSurfaceForTool("computer__screenshot")).toBe("computer");
  });

  it("keeps read-only tools out whatever prefix they arrive with", () => {
    expect(screenTouchingTool("browser__agent_browser_snapshot")).toBe(false);
    expect(screenTouchingTool("browser__agent_browser_read")).toBe(false);
    expect(screenTouchingTool("computer__computer_status")).toBe(false);
  });

  it.each(["local_vm", "computer-use", "vm2", `v${"m".repeat(31)}`])(
    "accepts the valid %s namespace in both mounted spellings",
    (namespace) => {
      for (const prefix of [`mcp__${namespace}__`, `${namespace}__`]) {
        expect(screenTouchingTool(`${prefix}screenshot`)).toBe(true);
        expect(screenSurfaceForTool(`${prefix}screenshot`)).toBe("computer");
        expect(screenTouchingTool(`${prefix}agent_browser_open`)).toBe(true);
        expect(screenSurfaceForTool(`${prefix}agent_browser_open`)).toBe("browser");
        for (const tool of ["computer_exec", "computer_status", "agent_browser_snapshot", "wait_for"])
          expect(screenTouchingTool(`${prefix}${tool}`)).toBe(false);
      }
    },
  );

  it("preserves legacy MCP names without accepting invalid desktop namespaces", () => {
    expect(screenTouchingTool("mcp__legacy.server__screenshot")).toBe(true);
    expect(screenTouchingTool("MCP__LOCAL_VM__SCREENSHOT")).toBe(true);
    expect(screenTouchingTool("legacy.server__screenshot")).toBe(false);
    expect(screenTouchingTool(`${"v".repeat(33)}__screenshot`)).toBe(false);
    expect(screenTouchingTool("2vm__screenshot")).toBe(false);
  });

  it("takes Codex's bare names and pi's server_tool names", () => {
    expect(screenTouchingTool("click")).toBe(true);
    expect(screenTouchingTool("hotkey")).toBe(true);
    expect(screenTouchingTool("computer_click")).toBe(true);
    expect(screenTouchingTool("computer_zoom")).toBe(true);
    expect(screenTouchingTool("computer_computer_batch")).toBe(true);
    expect(screenTouchingTool("browser_browser_navigate")).toBe(true);
    // the box's own Chrome tools live on the computer server
    expect(screenTouchingTool("computer_browser_fill")).toBe(true);
  });

  const acting = [
    "screenshot", "click", "type_text", "press_key", "scroll", "computer_batch", "open_url", "browser_click", "browser_fill",
    "browser_navigate", "browser_type", "browser_press", "browser_scroll", "browser_hover", "browser_drag",
    "browser_select_option", "browser_back", "browser_forward", "browser_screenshot",
    "double_click", "right_click", "drag", "hotkey", "move_cursor", "launch_app", "bring_to_front", "zoom",
  ];
  for (const tool of acting) {
    it(`counts: ${tool}`, () => expect(screenTouchingTool(tool)).toBe(true));
  }

  const bystanders = [
    // the bug: every tool on the computer server is "mcp__computer__…", and
    // a shell command there leaves the desktop exactly as it was
    "mcp__computer__computer_exec",
    "computer_exec",
    "computer_computer_exec",
    // read-only text tools
    "computer_status", "browser_state", "browser_snapshot", "browser_read", "observation_metrics",
    "mcp__browser__browser_snapshot", "browser_browser_read",
    "start_session", "get_window_state", "get_desktop_state", "get_accessibility_tree",
    "list_windows", "list_apps", "check_permissions", "get_screen_size",
    // waits change nothing; the action before them already counted
    "wait_for", "mcp__computer__wait_for", "wait_for_navigation", "browser_wait_for",
    // the person's hands, not the bot's
    "computer_request_help", "browser_request_takeover",
    // not computer tools at all
    "Bash", "Read", "mcp__agents__ask_bot", "mcp__composio__GMAIL_SEND_EMAIL", "screenshot_helper",
  ];
  for (const tool of bystanders) {
    it(`ignores: ${tool}`, () => expect(screenTouchingTool(tool)).toBe(false));
  }
});

describe("settledFrameIsNews", () => {
  const frame = "iVBORw0KGgo-frame-a";

  it("fails open when no frame has been shown yet", () => {
    expect(settledFrameIsNews(undefined, frame)).toBe(true);
  });

  it("is not news when the end frame is byte-identical to the shown one", () => {
    expect(settledFrameIsNews(screenFrameHash(frame), frame)).toBe(false);
  });

  it("is news once a single byte differs", () => {
    expect(settledFrameIsNews(screenFrameHash(frame), "iVBORw0KGgo-frame-b")).toBe(true);
  });

  it("fingerprints with sha256 over the base64, like the observation dedupe", () => {
    expect(screenFrameHash(frame)).toBe(createHash("sha256").update(frame).digest("hex"));
  });
});

describe("screenSurfaceForTool", () => {
  it("sends browser tools to the browser, whichever surface names them", () => {
    expect(screenSurfaceForTool("agent_browser_open")).toBe("browser");
    expect(screenSurfaceForTool("mcp__browser__agent_browser_click")).toBe("browser");
    expect(screenSurfaceForTool("browser_navigate")).toBe("browser");
  });

  it("sends everything else to the computer", () => {
    expect(screenSurfaceForTool("click")).toBe("computer");
    expect(screenSurfaceForTool("mcp__computer__screenshot")).toBe("computer");
    expect(screenSurfaceForTool("computer_batch")).toBe("computer");
  });

  it.each(["browser_click", "browser_fill"])("keeps desktop %s on the computer across drivers", (tool) => {
    expect(screenSurfaceForTool(`mcp__computer__${tool}`)).toBe("computer");
    expect(screenSurfaceForTool(`computer_${tool}`)).toBe("computer");
    expect(screenSurfaceForTool(`computer__${tool}`)).toBe("computer");
    expect(screenSurfaceForTool(tool)).toBe("computer");
    expect(screenSurfaceForTool(`mcp__browser__${tool}`)).toBe("browser");
    expect(screenSurfaceForTool(`browser__${tool}`)).toBe("browser");
    expect(screenSurfaceForTool(`browser_agent_${tool}`)).toBe("browser");
  });

  it("keeps a browsed page from being illustrated with an idle desktop", () => {
    // The case that made this necessary: a bot holding both surfaces, whose
    // turn was entirely web work, settled with a picture of its Local VM.
    expect(screenSurfaceForTool("agent_browser_open")).not.toBe(screenSurfaceForTool("launch_app"));
  });
});
