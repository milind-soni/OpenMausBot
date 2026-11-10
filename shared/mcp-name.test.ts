import { describe, expect, it } from "vitest";

import { slugMcpName } from "./mcp-name.ts";

describe("slugMcpName", () => {
  it("keeps the existing contract for ordinary names", () => {
    expect(slugMcpName("My Files")).toBe("my-files");
    expect(slugMcpName("123 repo")).toBe("mcp-123-repo");
    expect(slugMcpName("  ")).toBe("");
    expect(slugMcpName("a".repeat(40))).toHaveLength(32);
  });

  it("never ends in a hyphen after the length cap", () => {
    const got = slugMcpName("a".repeat(31) + "-bx");
    expect(got.endsWith("-")).toBe(false);
    expect(got.length).toBeLessThanOrEqual(32);
  });

  it("keeps the mcp- prefix branch free of a trailing hyphen too", () => {
    const got = slugMcpName("9" + "a".repeat(30) + "-bx");
    expect(got.endsWith("-")).toBe(false);
    expect(got.length).toBeLessThanOrEqual(32);
  });
});
