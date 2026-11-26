import { describe, expect, it } from "vitest";

import { parseSemVer, parseVersionTriple, semVerAtLeast, versionAtLeast, versionFromProbe } from "./version-probe.ts";

describe("versionFromProbe", () => {
  it("prefers stdout", () => {
    expect(versionFromProbe("codex-cli 0.154.0\n", "warning: noise")).toBe("codex-cli 0.154.0");
  });

  it("falls back to the first stderr line when stdout is empty (Hermes prints its banner there)", () => {
    const banner = "Hermes Agent v0.19.1 (2026.7.30) · upstream 0b48ae8d\nInstall directory: /Users/x/.hermes/hermes-agent\n";
    expect(versionFromProbe("", banner)).toBe("Hermes Agent v0.19.1 (2026.7.30) · upstream 0b48ae8d");
  });

  it("takes only the first line whatever the line ending", () => {
    expect(versionFromProbe("", "v1.2.3\r\nInstall directory: /x\r\n")).toBe("v1.2.3");
    expect(versionFromProbe("", "v1.2.3\rInstall directory: /x")).toBe("v1.2.3");
  });

  it("is null when both streams are empty", () => {
    expect(versionFromProbe("", "")).toBeNull();
    expect(versionFromProbe(undefined, undefined)).toBeNull();
    expect(versionFromProbe("  \n", "\n")).toBeNull();
  });
});

describe("parseVersionTriple", () => {
  it("takes the first dotted triple wherever it appears", () => {
    expect(parseVersionTriple("2.1.232 (Claude Code)")).toEqual([2, 1, 232]);
    expect(parseVersionTriple("banner\n1.0.60 (Claude Code)")).toEqual([1, 0, 60]);
    expect(parseVersionTriple("codex-cli 0.153.1")).toEqual([0, 153, 1]);
  });

  it("is null when no triple parses", () => {
    expect(parseVersionTriple("")).toBeNull();
    expect(parseVersionTriple("no numbers here")).toBeNull();
  });
});

describe("versionAtLeast", () => {
  it("compares componentwise, equal counts as current", () => {
    expect(versionAtLeast([2, 1, 232], [2, 1, 232])).toBe(true);
    expect(versionAtLeast([2, 1, 122], [2, 1, 121])).toBe(true);
    expect(versionAtLeast([2, 1, 121], [2, 1, 122])).toBe(false);
    expect(versionAtLeast([3, 0, 0], [2, 1, 232])).toBe(true);
    expect(versionAtLeast([1, 0, 122], [2, 1, 232])).toBe(false);
  });
});

describe("semVerAtLeast", () => {
  it.each([
    ["0.2.2-rc.1", "0.2.2-rc.2"],
    ["0.2.2-rc.2", "0.2.2-rc.10"],
    ["0.2.2-alpha.9", "0.2.2-rc.1"],
    ["0.2.2-1", "0.2.2-alpha"],
    ["0.2.2-alpha", "0.2.2-alpha.1"],
    ["0.2.2-rc.10", "0.2.2"],
    ["0.2.2", "0.2.3-alpha.2"],
    ["0.2.9", "0.2.10"],
  ])("orders %s before %s", (lower, higher) => {
    expect(semVerAtLeast(lower, higher)).toBe(false);
    expect(semVerAtLeast(higher, lower)).toBe(true);
  });

  it("accepts an equal version and ignores build metadata", () => {
    expect(semVerAtLeast("0.2.2-rc.2", "0.2.2-rc.2")).toBe(true);
    expect(semVerAtLeast("0.2.2-rc.2+linux.01\n", "0.2.2-rc.2+build.2")).toBe(true);
  });

  it.each(["", "unknown", "0.2", "0.2.2-", "0.2.2-rc..2", "0.02.2", "0.2.2-rc.02"])(
    "treats %j as an unreadable version", (value) => {
      expect(parseSemVer(value)).toBeNull();
      expect(semVerAtLeast(value, "0.2.2-rc.2")).toBe(false);
    },
  );
});
