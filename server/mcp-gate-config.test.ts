import { describe, expect, it } from "vitest";

import { gateServer } from "./mcp-gate-config.ts";

const server = { command: "example-mcp", args: ["--stdio"], env: { TOKEN: "disposable-test-token" } };
const input = { name: "notes", server, threadId: "disposable-thread", budget: 0 };

describe("MCP scope configuration", () => {
  it("preserves the legacy budget-zero escape hatch only when selection is absent", () => {
    expect(gateServer(input)).toBeNull();
    const gated = gateServer({ ...input, toolScope: { allow: [] } });
    expect(gated).not.toBeNull();
    expect(JSON.parse(gated!.env.OMB_GATE_TOOL_SCOPE)).toEqual({ allow: [] });
    expect(gated!.env.OMB_GATE_BUDGET).toBe("0");
    expect(JSON.parse(gated!.env.OMB_GATE_UPSTREAM)).toEqual(server);
    expect(gated!.args.join(" ")).not.toContain("disposable-test-token");
  });

  it("rejects malformed scopes and unmountable scoped servers instead of returning a bypass", () => {
    expect(() => gateServer({ ...input, toolScope: { allow: null } as never })).toThrow(/tool selection/i);
    expect(() => gateServer({ ...input, server: {}, toolScope: { allow: [] } })).toThrow(/MCP server/i);
  });
});
