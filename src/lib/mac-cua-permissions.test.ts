import { describe, expect, it } from "vitest";
import { macCuaPermissionMessage, macOSRequirement, missingMacCuaPermissions } from "./mac-cua-permissions";

describe("macOS CUA permission recovery", () => {
  it("names only the grants the host reported missing", () => {
    expect(missingMacCuaPermissions("embedded host failed: Screen Recording required; restart OpenMausBot")).toEqual(["screen"]);
    expect(missingMacCuaPermissions("Accessibility and Screen Recording required")).toEqual(["screen", "accessibility"]);
    expect(macCuaPermissionMessage(["accessibility"])).toContain("Accessibility is required for MausBot");
    expect(macCuaPermissionMessage(["screen"])).toContain("relaunch MausBot");
  });

  it("does not diagnose missing or malformed status as a grant failure", () => {
    expect(missingMacCuaPermissions(null)).toEqual([]);
    expect(missingMacCuaPermissions({ reason: "Screen Recording required" })).toEqual([]);
    expect(missingMacCuaPermissions("Screen Recording available")).toEqual([]);
    expect(missingMacCuaPermissions("Screen Recording granted; Accessibility required")).toEqual(["accessibility"]);
    expect(macCuaPermissionMessage([])).toBeNull();
  });

  it("reads the needed macOS version only from the startCua gate reason", () => {
    expect(macOSRequirement("computer use needs macOS 15 or later")).toBe(15);
    expect(macOSRequirement("computer use needs macOS 12.3 or later")).toBe(12.3);
    expect(macOSRequirement("embedded host failed: computer use needs macOS 15 or later")).toBe(15);
    expect(macOSRequirement("Accessibility required; grant access in System Settings")).toBeNull();
    expect(macOSRequirement(undefined)).toBeNull();
    expect(macOSRequirement(`computer use needs macOS 15 or later ${"x".repeat(2_000)}`)).toBeNull();
  });
});
