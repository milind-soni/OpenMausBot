import { describe, expect, it } from "vitest";

import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { AGENTS_MCP_ENV } from "./agents-mcp-env.ts";

describe("the agents server's settings", () => {
  it("carry every switch the catalog reads, so a turn reaching the server over HTTP is listed the same tools", () => {
    const read = new Set<string>();
    catalogProfileFromEnv(new Proxy({}, { get: (_target, key) => { if (typeof key === "string") read.add(key); return undefined; } }));
    expect(read.size).toBeGreaterThan(10);
    for (const key of read) expect(AGENTS_MCP_ENV, key).toContain(key);
  });
});
