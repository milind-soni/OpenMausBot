import { expect, it } from "vitest";
import { HANDOFF_BROWSER_STOPPED, handoffSurface, stoppedHandoffResult } from "./handoff-browser.ts";

it("lets a hand-off ask only for the built-in browser, auto included", () => {
  expect(handoffSurface("browser")).toBe("browser");
  expect(handoffSurface("auto")).toBe("browser");
  for (const asked of ["cloud", "vm", "local", undefined, 3]) expect(handoffSurface(asked)).toBeNull();
});

it("reports a hand-off that never continued in the browser as not done, and keeps a real failure", () => {
  expect(stoppedHandoffResult({ ok: true, text: "Moving to the browser." })).toEqual({ ok: false, text: HANDOFF_BROWSER_STOPPED });
  expect(stoppedHandoffResult({ ok: false, text: "engine failed" })).toEqual({ ok: false, text: "engine failed" });
});
