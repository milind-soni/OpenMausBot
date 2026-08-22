import { describe, expect, it } from "vitest";

import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow } from "./bottom-follow";

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
