import { describe, expect, it } from "vitest";
import {
  MEMBER_BROWSER_READ_URL,
  MEMBER_BROWSER_TOOLS,
  MEMBER_BROWSER_UNKNOWN_TOOL,
  MEMBER_BROWSER_WEB_ONLY,
  memberBrowserAddress,
  memberBrowserCall,
  memberBrowserToolList,
} from "./member-browser-policy.ts";

const call = (name: string, args: Record<string, unknown> = {}) => memberBrowserCall({ name, arguments: args });

describe("a member workspace's browser tools", () => {
  it("open web addresses only", () => {
    for (const url of ["https://example.com/", "http://example.com:8080/a?b=1", "about:blank", " https://example.com "]) {
      expect(memberBrowserAddress(url), url).toBe(true);
      expect(call("agent_browser_open", { url }), url).toEqual({ params: { name: "agent_browser_open", arguments: { url } } });
    }
    for (const url of [
      "file:///etc/passwd", "FILE:///home/nation/.openmausbot/config.json", "chrome://settings", "view-source:file:///etc/hostname",
      "javascript:alert(1)", "data:text/html,<p>x</p>", "chrome-extension://abc/page.html", "https://user:pass@example.com/", "not a url", "",
    ]) {
      expect(call("agent_browser_open", { url }), url).toEqual({ error: MEMBER_BROWSER_WEB_ONLY });
      expect(call("agent_browser_tab_new", { url }), url).toEqual({ error: MEMBER_BROWSER_WEB_ONLY });
    }
    expect(call("agent_browser_open", { url: 42 })).toEqual({ error: MEMBER_BROWSER_WEB_ONLY });
    expect(call("agent_browser_tab_new")).toEqual({ params: { name: "agent_browser_tab_new", arguments: {} } });
  });

  it("read the page that is open, never a url the engine would fetch itself", () => {
    expect(call("agent_browser_read", { url: "http://127.0.0.1:8799/api/config" })).toEqual({ error: MEMBER_BROWSER_READ_URL });
    expect(call("agent_browser_read", { url: "https://example.com/" })).toEqual({ error: MEMBER_BROWSER_READ_URL });
    expect(call("agent_browser_read", { outline: true })).toEqual({ params: { name: "agent_browser_read", arguments: { outline: true } } });
  });

  it("never write files or change how the browser runs", () => {
    expect(call("agent_browser_screenshot", { path: "/home/nation/.openmausbot/config.json", screenshotDir: "/etc", fullPage: true }))
      .toEqual({ params: { name: "agent_browser_screenshot", arguments: { fullPage: true } } });
    expect(call("agent_browser_open", { url: "https://example.com/", headed: true, webmcp: true }))
      .toEqual({ params: { name: "agent_browser_open", arguments: { url: "https://example.com/" } } });
  });

  it("refuse tools outside the reviewed list", () => {
    for (const name of ["agent_browser_upload", "agent_browser_state_load", "agent_browser_state_save", "agent_browser_download", "agent_browser_profiles", "agent_browser_pdf", "shell"]) {
      expect(call(name, { path: "/etc/passwd" }), name).toEqual({ error: MEMBER_BROWSER_UNKNOWN_TOOL });
    }
    expect(memberBrowserCall(null)).toEqual({ error: MEMBER_BROWSER_UNKNOWN_TOOL });
    expect(memberBrowserCall({ arguments: {} })).toEqual({ error: MEMBER_BROWSER_UNKNOWN_TOOL });
  });

  it("advertise only the reviewed tools, without the refused arguments", () => {
    const schema = (properties: string[], required: string[] = []) => ({ type: "object", properties: Object.fromEntries(properties.map((name) => [name, { type: "string" }])), required });
    const listed = memberBrowserToolList({
      tools: [
        { name: "agent_browser_open", inputSchema: schema(["url", "headed", "webmcp"], ["url"]) },
        { name: "agent_browser_read", inputSchema: schema(["url", "outline"], ["url"]) },
        { name: "agent_browser_screenshot", inputSchema: schema(["path", "screenshotDir", "fullPage"]) },
        { name: "agent_browser_upload", inputSchema: schema(["selector", "files"]) },
      ],
      nextCursor: undefined,
    }) as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(["agent_browser_open", "agent_browser_read", "agent_browser_screenshot"]);
    expect(Object.keys(listed.tools[0]!.inputSchema.properties)).toEqual(["url"]);
    expect(listed.tools[0]!.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(listed.tools[1]!.inputSchema.properties)).toEqual(["outline"]);
    expect(listed.tools[1]!.inputSchema.required).toEqual([]);
    expect(Object.keys(listed.tools[2]!.inputSchema.properties)).toEqual(["fullPage"]);
    expect(memberBrowserToolList("not a list")).toBe("not a list");
  });

  it("cover exactly the core tools agent-browser 0.37.0 advertises", () => {
    expect(MEMBER_BROWSER_TOOLS.size).toBe(29);
    for (const name of MEMBER_BROWSER_TOOLS) expect(name).toMatch(/^agent_browser_[a-z_]+$/);
  });
});
