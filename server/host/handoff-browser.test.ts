import { expect, it } from "vitest";
import { handoffSurface } from "./handoff-browser.ts";

it("lets a hand-off ask only for the built-in browser, auto included", () => {
  expect(handoffSurface("browser")).toBe("browser");
  expect(handoffSurface("auto")).toBe("browser");
  for (const asked of ["cloud", "vm", "local", undefined, 3]) expect(handoffSurface(asked)).toBeNull();
});
