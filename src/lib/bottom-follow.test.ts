import { describe, expect, it } from "vitest";

import { BOTTOM_FOLLOW_THRESHOLD, followBottomGrowth, shouldResumeBottomFollow } from "./bottom-follow";

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

describe("shouldResumeBottomFollow", () => {
  it("does not re-pin a small upward scroll inside the near-bottom zone", () => {
    expect(
      shouldResumeBottomFollow({
        following: false,
        previousScrollTop: 1_000,
        scrollTop: 992,
        distanceFromBottom: 8,
      }),
    ).toBe(false);
  });

  it("re-pins after scrolling downward to the end", () => {
    expect(
      shouldResumeBottomFollow({
        following: false,
        previousScrollTop: 992,
        scrollTop: 1_000,
        distanceFromBottom: 0,
      }),
    ).toBe(true);
  });

  it("stays detached while downward movement remains away from the end", () => {
    expect(
      shouldResumeBottomFollow({
        following: false,
        previousScrollTop: 500,
        scrollTop: 600,
        distanceFromBottom: BOTTOM_FOLLOW_THRESHOLD,
      }),
    ).toBe(false);
  });

  it("does not re-pin in the old 48px magnet zone", () => {
    expect(
      shouldResumeBottomFollow({
        following: false,
        previousScrollTop: 952,
        scrollTop: 960,
        distanceFromBottom: 40,
      }),
    ).toBe(false);
  });

  it("does nothing when bottom-follow is already active", () => {
    expect(
      shouldResumeBottomFollow({
        following: true,
        previousScrollTop: 992,
        scrollTop: 1_000,
        distanceFromBottom: 0,
      }),
    ).toBe(false);
  });
});
