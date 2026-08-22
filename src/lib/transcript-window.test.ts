import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
} from "./transcript-window";

const thread = (total: number): number[] => Array.from({ length: total }, (_, i) => i);

describe("tailWindowStart", () => {
  it("shows everything when the thread is shorter than the window", () => {
    expect(tailWindowStart(10)).toBe(0);
  });

  it("shows everything when the thread is exactly one window", () => {
    expect(tailWindowStart(TRANSCRIPT_WINDOW_SIZE)).toBe(0);
  });

  it("starts one window back from the tail of a long thread", () => {
    expect(tailWindowStart(300)).toBe(180);
  });

  it("is zero for an empty thread", () => {
    expect(tailWindowStart(0)).toBe(0);
  });
});

describe("expandWindowStart", () => {
  it("pulls the boundary back by one window per click", () => {
    expect(expandWindowStart(300)).toBe(180);
  });

  it("clamps an expansion past the start of the thread to zero", () => {
    expect(expandWindowStart(60)).toBe(0);
  });

  it("stays at zero once fully expanded", () => {
    expect(expandWindowStart(0)).toBe(0);
  });
});

describe("resolveTranscriptWindow", () => {
  it("keeps a short thread fully visible with nothing hidden", () => {
    const result = resolveTranscriptWindow(thread(10), tailWindowStart(10));
    expect(result.visible).toHaveLength(10);
    expect(result.hiddenCount).toBe(0);
    expect(result.startIndex).toBe(0);
    expect(result.laterCount).toBe(0);
  });

  it("windows a long thread to its tail", () => {
    const result = resolveTranscriptWindow(thread(300), tailWindowStart(300));
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.visible[0]).toBe(180);
    expect(result.visible.at(-1)).toBe(299);
    expect(result.hiddenCount).toBe(180);
  });

  it("grows the window when messages append past an anchored boundary", () => {
    const start = tailWindowStart(300);
    const result = resolveTranscriptWindow(thread(310), start);
    // the boundary must not slide forward: rows on screen stay on screen
    expect(result.startIndex).toBe(start);
    expect(result.visible).toHaveLength(130);
    expect(result.visible.at(-1)).toBe(309);
  });

  it("expands by one window per step until the start of the thread", () => {
    const messages = thread(300);
    const once = resolveTranscriptWindow(messages, expandWindowStart(180));
    expect(once.visible).toHaveLength(240);
    expect(once.hiddenCount).toBe(60);
    const twice = resolveTranscriptWindow(messages, expandWindowStart(once.startIndex));
    expect(twice.visible).toHaveLength(300);
    expect(twice.hiddenCount).toBe(0);
  });

  it("falls back to a tail window when the thread shrinks under the boundary", () => {
    // branch switch / edit rewound the thread below the stored boundary
    const result = resolveTranscriptWindow(thread(150), 180);
    expect(result.startIndex).toBe(30);
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.hiddenCount).toBe(30);
  });

  it("resets a boundary sitting exactly at the end of the thread", () => {
    const result = resolveTranscriptWindow(thread(100), 100);
    expect(result.startIndex).toBe(0);
    expect(result.visible).toHaveLength(100);
  });

  it("resolves an empty thread to an empty window", () => {
    const result = resolveTranscriptWindow([], 0);
    expect(result.visible).toHaveLength(0);
    expect(result.hiddenCount).toBe(0);
  });

  it("respects a custom window size", () => {
    const result = resolveTranscriptWindow(thread(10), tailWindowStart(10, 4), 4);
    expect(result.visible).toHaveLength(4);
    expect(result.hiddenCount).toBe(6);
  });

  it("keeps a finite search-focus window instead of mounting through the tail", () => {
    const result = resolveTranscriptWindow(thread(1_000), 440, TRANSCRIPT_WINDOW_SIZE, 560);
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.visible[0]).toBe(440);
    expect(result.visible.at(-1)).toBe(559);
    expect(result.hiddenCount).toBe(440);
    expect(result.laterCount).toBe(440);
    expect(result.endIndex).toBe(560);
  });

  it("falls back to the tail if a finite window becomes invalid after a rewind", () => {
    const result = resolveTranscriptWindow(thread(100), 440, TRANSCRIPT_WINDOW_SIZE, 560);
    expect(result.visible[0]).toBe(0);
    expect(result.visible.at(-1)).toBe(99);
    expect(result.laterCount).toBe(0);
  });
});

describe("focusWindowRange", () => {
  it.each([10, 500, 990])("contains target %i in a bounded window", (target) => {
    const range = focusWindowRange(1_000, target);
    expect(target).toBeGreaterThanOrEqual(range.start);
    expect(target).toBeLessThan(range.end);
    expect(range.end - range.start).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_SIZE);
  });

  it("uses the full short transcript", () => {
    expect(focusWindowRange(20, 10)).toEqual({ start: 0, end: 20 });
  });
});
