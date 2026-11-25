import { expect, it } from "vitest";
import { HANDOFF_BROWSER_STOPPED, handoffSurface, StoppedHandoffs, stoppedHandoffResult } from "./handoff-browser.ts";

it("lets a hand-off ask only for the built-in browser, auto included", () => {
  expect(handoffSurface("browser")).toBe("browser");
  expect(handoffSurface("auto")).toBe("browser");
  for (const asked of ["cloud", "vm", "local", undefined, 3]) expect(handoffSurface(asked)).toBeNull();
});

it("reports a hand-off that never continued in the browser as not done, and keeps a real failure", () => {
  expect(stoppedHandoffResult({ ok: true, text: "Moving to the browser." })).toEqual({ ok: false, text: HANDOFF_BROWSER_STOPPED });
  expect(stoppedHandoffResult({ ok: false, text: "engine failed" })).toEqual({ ok: false, text: "engine failed" });
});

it("reports a hand-off given up before its outcome arrived as stopped, once, and leaves others alone", () => {
  const stopped = new StoppedHandoffs(2);
  stopped.stop("g1");
  expect(stopped.settle("g1", { ok: true, text: "Moving to the browser." })).toEqual({ ok: false, text: HANDOFF_BROWSER_STOPPED });
  expect(stopped.settle("g1", { ok: true, text: "later" })).toEqual({ ok: true, text: "later" });
  expect(stopped.settle("g2", { ok: true, text: "done" })).toEqual({ ok: true, text: "done" });
  stopped.stop("a"); stopped.stop("b"); stopped.stop("c");
  expect(stopped.settle("a", { ok: true, text: "x" })).toEqual({ ok: true, text: "x" });
  expect(stopped.settle("c", { ok: false, text: "engine failed" })).toEqual({ ok: false, text: "engine failed" });
});
