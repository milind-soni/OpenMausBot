import { describe, expect, it } from "vitest";
import { BUILT_IN_BROWSER_SYSTEM_PROMPT } from "./browser-engine.ts";
import { DEFAULT_BROWSER_RESULT_BUDGET, HARNESS_OWNED_BROWSER_PARAMS, shapeBrowserToolResult, slimBrowserToolList, stripHarnessOwnedArguments } from "./browser-tool-shape.ts";

const snapshotTool = {
  name: "agent_browser_snapshot",
  description: "Return an accessibility-tree snapshot with stable element refs.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      interactive: { type: "boolean", default: true }, compact: { type: "boolean", default: false }, depth: { type: "integer" }, selector: { type: "string" },
      session: { type: "string" }, namespace: { type: "string" }, extraArgs: { type: "array" }, caCert: { type: "string" }, clearCaCert: { type: "boolean" },
      allowedDomains: { type: "array" }, headed: { type: "boolean" }, idleTimeout: { type: "string" }, timeoutMs: { type: "integer" }, restore: { type: "boolean" },
      restoreCheckFn: { type: "string" }, restoreCheckText: { type: "string" }, restoreCheckUrl: { type: "string" }, restoreSave: { type: "string" },
    },
    required: ["session", "interactive"],
  },
};

describe("browser tool shaping", () => {
  it("removes every harness-owned parameter from advertised schemas and keeps the tool's own", () => {
    const slim = slimBrowserToolList({ tools: [snapshotTool, { name: "agent_browser_close" }], nextCursor: "x" }) as { tools: Array<typeof snapshotTool>; nextCursor: string };
    expect(slim.nextCursor).toBe("x");
    expect(Object.keys(slim.tools[0].inputSchema.properties).sort()).toEqual(["compact", "depth", "interactive", "selector"]);
    expect(slim.tools[0].inputSchema.required).toEqual(["interactive"]);
    expect(slim.tools[0].inputSchema.additionalProperties).toBe(false);
    expect(slim.tools[1]).toEqual({ name: "agent_browser_close" });
    // the fixture covers the whole set, so a new owned parameter cannot slip past this test
    for (const name of HARNESS_OWNED_BROWSER_PARAMS) expect(snapshotTool.inputSchema.properties).toHaveProperty(name);
    expect(snapshotTool.inputSchema.properties).toHaveProperty("session"); // input untouched
  });

  it("drops harness-owned arguments from a call and leaves ordinary calls identical", () => {
    const ordinary = { name: "agent_browser_click", arguments: { ref: "@e3" } };
    expect(stripHarnessOwnedArguments(ordinary)).toBe(ordinary);
    expect(stripHarnessOwnedArguments({ name: "agent_browser_open", arguments: { url: "https://example.com", session: "other-bot", extraArgs: ["--remote-debugging-port=9222"], caCert: "/tmp/x.pem" } }))
      .toEqual({ name: "agent_browser_open", arguments: { url: "https://example.com" } });
    // headed is harness-owned too: a call must not pin the daemon to a launch
    // mode the host cannot satisfy (#1383)
    expect(stripHarnessOwnedArguments({ name: "agent_browser_open", arguments: { url: "https://example.com", headed: true } }))
      .toEqual({ name: "agent_browser_open", arguments: { url: "https://example.com" } });
    expect(stripHarnessOwnedArguments({ name: "agent_browser_close" })).toEqual({ name: "agent_browser_close" });
  });

  it("keeps text, drops the structured duplicate, and leaves images and small results alone", () => {
    const small = { content: [{ type: "text", text: "- button \"Buy\" [ref=e1]" }, { type: "image", data: "AAAA", mimeType: "image/png" }], structuredContent: { refs: { e1: {} } }, isError: false };
    const shaped = shapeBrowserToolResult(small) as Record<string, unknown>;
    expect(shaped).not.toHaveProperty("structuredContent");
    expect(shaped.content).toEqual(small.content);
    expect(shaped.isError).toBe(false);
    // an image-only result has no text form to fall back to, so its structured payload stays
    const imageOnly = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], structuredContent: { ok: true } };
    expect(shapeBrowserToolResult(imageOnly)).toEqual(imageOnly);
    expect(shapeBrowserToolResult({ error: "x" })).toEqual({ error: "x" });
  });

  it("cuts oversized text to the budget and says how to narrow the next call", () => {
    const text = "line of accessibility tree\n".repeat(4_000);
    const shaped = shapeBrowserToolResult({ content: [{ type: "text", text }], structuredContent: {} }, { toolName: "agent_browser_snapshot" }) as { content: Array<{ text: string }> };
    expect(shaped.content[0].text.length).toBeLessThan(DEFAULT_BROWSER_RESULT_BUDGET + 600);
    expect(shaped.content[0].text).toContain("trimmed this tool result");
    expect(shaped.content[0].text).toContain("agent_browser_get_text");
    const custom = shapeBrowserToolResult({ content: [{ type: "text", text }] }, { budget: 1_000 }) as { content: Array<{ text: string }> };
    expect(custom.content[0].text.length).toBeLessThan(1_600);
  });

  it("names only tools the pinned engine advertises", () => {
    // `agent-browser mcp --tools core` on the pinned 0.37.0, plus the
    // harness's own restart tool. A name the engine does not list costs the
    // bot a failed call, so guidance must never point at one.
    const advertised = new Set([
      "agent_browser_tools_profiles", "agent_browser_open", "agent_browser_read", "agent_browser_snapshot", "agent_browser_click",
      "agent_browser_fill", "agent_browser_type", "agent_browser_press", "agent_browser_check", "agent_browser_uncheck",
      "agent_browser_select", "agent_browser_scroll", "agent_browser_wait_ms", "agent_browser_wait_for_selector",
      "agent_browser_wait_for_text", "agent_browser_wait_for_load", "agent_browser_screenshot", "agent_browser_get_text",
      "agent_browser_get_url", "agent_browser_get_title", "agent_browser_eval", "agent_browser_close", "agent_browser_back",
      "agent_browser_forward", "agent_browser_reload", "agent_browser_tab_new", "agent_browser_tab_list", "agent_browser_tab_switch",
      "agent_browser_tab_close",
    ]);
    const hint = (shapeBrowserToolResult({ content: [{ type: "text", text: "x\n".repeat(40_000) }] }, { toolName: "agent_browser_snapshot" }) as { content: Array<{ text: string }> }).content[0].text;
    for (const text of [BUILT_IN_BROWSER_SYSTEM_PROMPT, hint]) {
      const names = text.match(/agent_browser_[a-z_]+/g) ?? [];
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        // "agent_browser_tab_*" names a family by its prefix.
        const known = name.endsWith("_") ? [...advertised].some((tool) => tool.startsWith(name)) : advertised.has(name);
        expect(known, name).toBe(true);
      }
    }
  });

  it("tells the bot that opening a page already returns its refs", () => {
    expect(BUILT_IN_BROWSER_SYSTEM_PROMPT).toContain("agent_browser_open already returns the loaded page's snapshot with current refs");
    expect(BUILT_IN_BROWSER_SYSTEM_PROMPT).not.toContain("Take a fresh snapshot after navigation");
  });
});
