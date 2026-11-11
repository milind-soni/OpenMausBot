import { describe, expect, it } from "vitest";

import { versionAtLeast } from "./devs-report-status.ts";

describe("whether this app runs a fix's release", () => {
  it("is so at that release and after it, never before it", () => {
    expect(versionAtLeast("0.1.135", "0.1.135")).toBe(true);
    expect(versionAtLeast("0.1.136", "0.1.135")).toBe(true);
    expect(versionAtLeast("0.2.0", "0.1.135")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.9.99")).toBe(true);
    expect(versionAtLeast("v0.1.135", "0.1.135")).toBe(true);
    expect(versionAtLeast("0.1.134", "0.1.135")).toBe(false);
    expect(versionAtLeast("0.1.99", "0.1.135")).toBe(false);
    expect(versionAtLeast("0.0.999", "0.1.0")).toBe(false);
  });

  it("is never so on a guess: a pre-release of that very release, or anything that doesn't read as a version", () => {
    expect(versionAtLeast("0.1.135-beta.1", "0.1.135")).toBe(false);
    expect(versionAtLeast("0.1.136-beta.1", "0.1.135")).toBe(true);
    expect(versionAtLeast("0.1.135+build.7", "0.1.135")).toBe(true);
    expect(versionAtLeast("0.1.135", "0.1.135-beta.1")).toBe(false);
    expect(versionAtLeast("dev", "0.1.135")).toBe(false);
    expect(versionAtLeast("0.1.135", "next")).toBe(false);
    expect(versionAtLeast("", "")).toBe(false);
  });
});
