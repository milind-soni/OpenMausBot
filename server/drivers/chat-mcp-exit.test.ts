import { describe, expect, it } from "vitest";

import { mcpExitMessage } from "./chat-mcp-tools.ts";

describe("mcpExitMessage", () => {
  it("says how the MCP server ended", () => {
    expect(mcpExitMessage(null, "SIGKILL")).toBe("MCP server exited before the session closed (SIGKILL)");
    expect(mcpExitMessage(7, null)).toBe("MCP server exited before the session closed (code 7)");
    expect(mcpExitMessage(0, null)).toBe("MCP server exited before the session closed (code 0)");
    expect(mcpExitMessage(null, null)).toBe("MCP server exited before the session closed (no exit status)");
  });
});
