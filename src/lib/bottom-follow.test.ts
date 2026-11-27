import { describe, expect, it } from "vitest";

import { followBottomGrowth } from "./bottom-follow";

describe("followBottomGrowth", () => {
  it("scrolls resized content to its new bottom while following", () => {
    const calls: ScrollToOptions[] = [];
    const scroller = {
      scrollHeight: 1_240,
      scrollTo: (options: ScrollToOptions) => calls.push(options),
    };

    expect(followBottomGrowth(scroller, true)).toBe(true);
    expect(calls).toEqual([{ top: 1_240 }]);
  });

  it("glides to the bottom while a reply streams in", () => {
    const calls: ScrollToOptions[] = [];
    const scroller = {
      scrollHeight: 1_240,
      scrollTo: (options: ScrollToOptions) => calls.push(options),
    };

    expect(followBottomGrowth(scroller, true, true)).toBe(true);
    expect(calls).toEqual([{ top: 1_240, behavior: "smooth" }]);
  });

  it("preserves scrollback when bottom-follow is detached", () => {
    const calls: ScrollToOptions[] = [];
    const scroller = {
      scrollHeight: 1_240,
      scrollTo: (options: ScrollToOptions) => calls.push(options),
    };

    expect(followBottomGrowth(scroller, false)).toBe(false);
    expect(calls).toEqual([]);
  });
});
