import { describe, expect, it } from "vitest";

import { REPEAT_ADVISORY_AT, REPEAT_STOP_AT, REPEAT_WINDOW, createLoopGuard } from "./loop-guard.ts";

describe("createLoopGuard", () => {
  it("lets distinct calls through", () => {
    const guard = createLoopGuard();
    expect(guard.observe("read", { path: "a" })).toBe("ok");
    expect(guard.observe("read", { path: "b" })).toBe("ok");
    expect(guard.observe("write", { path: "a" })).toBe("ok");
  });

  it("advises at the third identical call inside the window", () => {
    const guard = createLoopGuard();
    const verdicts = Array.from({ length: REPEAT_ADVISORY_AT }, () => guard.observe("read", { path: "a" }));
    expect(verdicts).toEqual(["ok", "ok", "advisory"]);
  });

  it("stops at the fifth identical call overall", () => {
    const guard = createLoopGuard();
    const verdicts = Array.from({ length: REPEAT_STOP_AT }, () => guard.observe("read", { path: "a" }));
    expect(verdicts.at(-1)).toBe("stop");
    expect(guard.repeatsOfLast()).toBe(REPEAT_STOP_AT);
  });

  it("only counts repeats inside the rolling window for the advisory", () => {
    // two identical calls, then enough different ones to roll them out
    const guard = createLoopGuard();
    guard.observe("read", { path: "a" });
    guard.observe("read", { path: "a" });
    for (let i = 0; i < REPEAT_WINDOW; i += 1) guard.observe("other", { i });
    expect(guard.observe("read", { path: "a" })).toBe("ok");
  });

  it("treats argument objects that differ only in key order as identical", () => {
    const guard = createLoopGuard();
    guard.observe("read", { path: "a", line: 1 });
    guard.observe("read", { line: 1, path: "a" });
    expect(guard.observe("read", { path: "a", line: 1 })).toBe("advisory");
  });

  it("does not confuse the same arguments to a different tool", () => {
    const guard = createLoopGuard();
    guard.observe("read", { path: "a" });
    guard.observe("write", { path: "a" });
    expect(guard.observe("read", { path: "a" })).toBe("ok");
  });

  it("handles nested and array arguments deterministically", () => {
    const guard = createLoopGuard();
    guard.observe("t", { list: [1, { z: 1, a: 2 }] });
    guard.observe("t", { list: [1, { a: 2, z: 1 }] });
    expect(guard.observe("t", { list: [1, { z: 1, a: 2 }] })).toBe("advisory");
    // order inside an array is meaningful
    expect(guard.observe("t", { list: [{ a: 2, z: 1 }, 1] })).toBe("ok");
  });
});
