import { describe, expect, it } from "vitest";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "./mac-cua-permissions";
import { APP_NAME, PRODUCT_NAME } from "../../shared/product.ts";

describe("macOS CUA permission recovery", () => {
  it("names only the grants the host reported missing", () => {
    expect(missingMacCuaPermissions(`embedded host failed: Screen Recording required; restart ${APP_NAME}`)).toEqual(["screen"]);
    expect(missingMacCuaPermissions("Accessibility and Screen Recording required")).toEqual(["screen", "accessibility"]);
    expect(macCuaPermissionMessage(["accessibility"])).toContain(`Accessibility is required for ${PRODUCT_NAME}`);
    expect(macCuaPermissionMessage(["screen"])).toContain(`relaunch ${PRODUCT_NAME}`);
  });

  it("does not diagnose missing or malformed status as a grant failure", () => {
    expect(missingMacCuaPermissions(null)).toEqual([]);
    expect(missingMacCuaPermissions({ reason: "Screen Recording required" })).toEqual([]);
    expect(missingMacCuaPermissions("Screen Recording available")).toEqual([]);
    expect(missingMacCuaPermissions("Screen Recording granted; Accessibility required")).toEqual(["accessibility"]);
    expect(macCuaPermissionMessage([])).toBeNull();
  });
});
