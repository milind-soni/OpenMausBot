import { describe, expect, it } from "vitest";

import { loopbackNavigationHint, normalizeBuiltInBrowserArgs } from "./chat-mcp-tools.ts";

describe("normalizeBuiltInBrowserArgs", () => {
  it("keeps one screenshot target when the model names several", () => {
    const both = { ref: "e193", selector: "main figure img", tab: "t2" };
    normalizeBuiltInBrowserArgs("agent_browser_screenshot", both);
    expect(both).toEqual({ ref: "e193", tab: "t2" });

    const point = { selector: "main", x: 120, y: 40 };
    normalizeBuiltInBrowserArgs("agent_browser_screenshot", point);
    expect(point).toEqual({ selector: "main" });

    const onlyPoint = { x: 120, y: 40 };
    normalizeBuiltInBrowserArgs("agent_browser_screenshot", onlyPoint);
    expect(onlyPoint).toEqual({ x: 120, y: 40 });
  });

  it("reads a blank target as not given", () => {
    const args: Record<string, unknown> = { ref: "  ", selector: "main", tab: "t1" };
    normalizeBuiltInBrowserArgs("agent_browser_screenshot", args);
    expect(args).toEqual({ selector: "main", tab: "t1" });
  });

  it("leaves the fields other browser tools mean literally", () => {
    const fill = { ref: "e1", text: "" };
    normalizeBuiltInBrowserArgs("agent_browser_fill", fill);
    expect(fill).toEqual({ ref: "e1", text: "" });
  });
});

describe("loopbackNavigationHint", () => {
  it("names the loopback address on a failed navigation", () => {
    const hint = loopbackNavigationHint("agent_browser_open", { url: "http://127.0.0.1:8188/" },
      'Navigation to http://127.0.0.1:8188/ failed: ERR_SOCKS_CONNECTION_FAILED');
    expect(hint).toMatch(/loopback of the machine running this browser/);
    expect(hint).toMatch(/192\.168\.1\.20:8188/);
  });

  it("stays quiet for a reachable address or a successful load", () => {
    expect(loopbackNavigationHint("agent_browser_open", { url: "http://192.168.3.50:8188/" }, "ERR_CONNECTION_REFUSED")).toBe("");
    expect(loopbackNavigationHint("agent_browser_open", { url: "http://localhost:3000/" }, "Opened http://localhost:3000/ in t1.")).toBe("");
    expect(loopbackNavigationHint("agent_browser_read", { url: "http://127.0.0.1/" }, "failed")).toBe("");
  });
});
