import { describe, expect, it } from "vitest";
import { createCuaMcpTransformer } from "./cua-mcp-proxy.mjs";

describe("CUA MCP bind compaction", () => {
  it("advertises and applies a bind-only tab URL prefix", () => {
    const proxy = createCuaMcpTransformer();
    const listed = proxy.fromDriver({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "get_browser_state", description: "Read browser state", inputSchema: { type: "object", properties: {} } }] },
    });
    expect(listed.result.tools[0].inputSchema.properties.tab_url_prefix.type).toBe("string");

    const outbound = proxy.toDriver({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_browser_state",
        arguments: { pid: 10, window_id: 20, session: "s", tab_url_prefix: "chrome://extensions" },
      },
    });
    expect(outbound.params.arguments).toEqual({ pid: 10, window_id: 20, session: "s" });

    const inbound = proxy.fromDriver({
      jsonrpc: "2.0",
      id: 2,
      result: {
        structuredContent: {
          status: "ok",
          mode: "bind",
          target_id: "target-1",
          tabs: [
            { tab_id: "private", title: "Private", url: "https://mail.example.test/inbox", active: null },
            { tab_id: "safe", title: "Extensions", url: "chrome://extensions/", active: null },
          ],
        },
        content: [{
          type: "text",
          text: "get_browser_state: exact bind with 2 tabs",
        }],
      },
    });
    const compact = JSON.parse(inbound.result.content[0].text);
    expect(compact).toEqual({
      status: "ok",
      mode: "bind",
      target_id: "target-1",
      tab_id: "safe",
      tabs: [{ tab_id: "safe", url: "chrome://extensions/", active: false }],
      total_tab_count: 2,
      tab_url_prefix: "chrome://extensions",
    });
    expect(inbound.result.structuredContent).toEqual(compact);
  });

  it("does not alter snapshot calls or unrelated tool results", () => {
    const proxy = createCuaMcpTransformer();
    const snapshot = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_browser_state", arguments: { target_id: "target", tab_id: "tab" } },
    };
    expect(proxy.toDriver(snapshot)).toBe(snapshot);
    const result = { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "snapshot" }] } };
    expect(proxy.fromDriver(result)).toBe(result);
  });
});
