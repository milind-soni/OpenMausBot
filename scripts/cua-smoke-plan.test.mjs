import { expect, test } from "vitest";

import { resolveCuaSmokePlan } from "./cua-smoke-plan.mjs";

test("Windows CUA smoke uses the Windows staging and smoke scripts", () => {
  expect(resolveCuaSmokePlan("win32")).toEqual({
    prepareScript: "scripts/prepare-cua-win.mjs",
    smokeScript: "scripts/smoke-cua-win.mjs",
  });
});

test("macOS CUA smoke preserves the existing staging and smoke scripts", () => {
  expect(resolveCuaSmokePlan("darwin")).toEqual({
    prepareScript: "scripts/prepare-cua.mjs",
    smokeScript: "scripts/smoke-cua.mjs",
  });
});

test("unsupported platforms fail explicitly", () => {
  expect(() => resolveCuaSmokePlan("freebsd")).toThrow(/unsupported CUA smoke platform/i);
});
