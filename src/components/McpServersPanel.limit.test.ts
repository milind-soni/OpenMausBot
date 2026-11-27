import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.stubGlobal("window", {});
const { connectedLabel } = await import("./McpServersPanel");
const tools = (count: number) => Array.from({ length: Math.min(count, 100) }, (_, index) => ({ name: `tool_${index}` }));

beforeEach(() => setLocale("en"));

describe("a passing MCP server test", () => {
  it("says only Connected for a server that fits beside others", () => {
    expect(connectedLabel({ tools: tools(26) })).toBe("Connected: 26 tools");
  });

  it("says when the server alone takes half or more of what some AIs take at once", () => {
    expect(connectedLabel({ tools: tools(64) })).toBe("Connected: 64 tools. That's 64 of the 128 tools some AIs take at once, so there other MCP servers may be found through tool search instead.");
  });

  it("says when the server alone has more tools than some AIs take at once", () => {
    expect(connectedLabel({ tools: tools(100), total: 425 })).toBe("Connected: 425 tools. Some AIs take at most 128 tools at once, so there its tools are found through tool search.");
  });
});
