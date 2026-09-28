import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_RESULT_BUDGET, HARNESS_OWNED_BROWSER_PARAMS, shapeBrowserToolResult, slimBrowserToolList, stripHarnessOwnedArguments } from "./browser-tool-shape.ts";

const snapshotTool = {
  name: "agent_browser_snapshot",
  description: "Return an accessibility-tree snapshot with stable element refs.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      interactive: { type: "boolean", default: true }, compact: { type: "boolean", default: false }, depth: { type: "integer" }, selector: { type: "string" },
      session: { type: "string" }, namespace: { type: "string" }, extraArgs: { type: "array" }, caCert: { type: "string" }, clearCaCert: { type: "boolean" },
      allowedDomains: { type: "array" }, idleTimeout: { type: "string" }, timeoutMs: { type: "integer" }, restore: { type: "boolean" },
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
});
