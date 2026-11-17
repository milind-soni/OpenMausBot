import { describe, expect, it } from "vitest";

import { nodeOlderThan, readNodeVersion } from "./node-version.ts";

describe("nodeOlderThan", () => {
  it("compares major, then minor, then patch", () => {
    expect(nodeOlderThan("20.19.4", "24.9.0")).toBe(true);
    expect(nodeOlderThan("24.8.9", "24.9.0")).toBe(true);
    expect(nodeOlderThan("24.9.0", "24.9.0")).toBe(false);
    expect(nodeOlderThan("24.10.0", "24.9.0")).toBe(false);
    expect(nodeOlderThan("25.0.0", "24.9.0")).toBe(false);
  });
});

describe("readNodeVersion", () => {
  it("reads the version of the node on the PATH", async () => {
    expect(await readNodeVersion(process.env)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
