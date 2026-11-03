import { describe, expect, it } from "vitest";
import { FAMULOR_MCP_URL, famulorServerName, isFamulorServer } from "./famulor-integration";

describe("Famulor integration", () => {
  it("recognizes the official HTTP endpoint independently of its local name", () => {
    expect(isFamulorServer({ type: "http", url: FAMULOR_MCP_URL })).toBe(true);
    expect(isFamulorServer({ type: "http", url: `${FAMULOR_MCP_URL}/` })).toBe(true);
  });
  it("does not brand other servers, transports or modified URLs as Famulor", () => {
    for (const url of [
      "http://app.famulor.io/mcp",
      "https://app.famulor.io.evil.test/mcp",
      "https://famulor.io/mcp",
      "https://mcp.famulor.io/mcp",
      "https://www.famulor.io/mcp",
      `${FAMULOR_MCP_URL}?key=secret`,
      `${FAMULOR_MCP_URL}#hash`,
      "https://key@app.famulor.io/mcp",
      "https://app.famulor.io/docs",
      "https://app.famulor.io/mcp/extra",
      "https://app.famulor.io/MCP",
      "invalid",
    ]) {
      expect(isFamulorServer({ type: "http", url }), url).toBe(false);
    }
    expect(isFamulorServer({ type: "sse", url: FAMULOR_MCP_URL })).toBe(false);
    expect(isFamulorServer({})).toBe(false);
  });
  it("does not replace an existing server with the same name", () => {
    expect(famulorServerName([])).toBe("famulor");
    expect(famulorServerName([{ name: "famulor" }, { name: "famulor-2" }])).toBe("famulor-3");
    expect(famulorServerName([{ name: "famulor-2" }])).toBe("famulor");
  });
});
