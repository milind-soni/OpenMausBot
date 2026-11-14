import { describe, expect, it } from "vitest";

import { keepWarmLine } from "./cache-keepwarm";

const at = (time: string) => () => time;

describe("keepWarmLine", () => {
  it("says nothing without a window", () => {
    expect(keepWarmLine(undefined)).toBeNull();
  });

  it("shows the next ping, the last readback and the window's end", () => {
    expect(keepWarmLine({ state: "warm", until: 2, nextPingAt: 1, last: { at: 0, read: 154_000, write: 30, costUsd: 0.05 } }, at("12:40")))
      .toBe("cache warm · next ping 12:40 · last ping read 154k for $0.05 · until 12:40");
    expect(keepWarmLine({ state: "warm", until: 2 }, at("15:10"))).toBe("cache warm · until 15:10");
  });

  it("says why a window stopped", () => {
    expect(keepWarmLine({ state: "stopped", stopped: "the cache was already gone", last: { at: 0, read: 0, write: 120_000, costUsd: null } }))
      .toBe("keep-warm stopped: the cache was already gone · last ping read 0");
  });
});
