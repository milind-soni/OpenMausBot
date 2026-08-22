import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete process.env.OMB_SOURCE_SHA;
  vi.resetModules();
});

describe("runtime source identity", () => {
  it("memoizes the first resolved source SHA", async () => {
    const first = "a".repeat(40);
    process.env.OMB_SOURCE_SHA = first;
    vi.resetModules();
    const { runtimeSourceSha } = await import("./release.ts");
    expect(runtimeSourceSha()).toBe(first);

    process.env.OMB_SOURCE_SHA = "b".repeat(40);
    expect(runtimeSourceSha()).toBe(first);
  });
});
