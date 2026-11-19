import { describe, expect, it } from "vitest";

import {
  SELECTION_HOLD_MAX,
  TRANSCRIPT_WINDOW_MAX,
  TRANSCRIPT_WINDOW_SIZE,
  TRANSCRIPT_WINDOW_STEP,
  capWindowEnd,
  expandWindowStart,
  focusWindowRange,
  followWindowStart,
  holdRows,
  resolveTranscriptWindow,
  restoreWindow,
  tailWindowStart,
  windowAfterPrepend,
  windowEarlier,
  windowLater,
  withRestingCard,
  type TranscriptWindowBounds,
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

describe("followWindowStart", () => {
  const turn = (asked: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({ role: i === asked ? "user" : "bot" }));

  it("is the tail window when the newest message is inside it", () => {
    expect(followWindowStart(turn(250, 300), 0)).toBe(180);
  });

  it("stops at the newest message when a long turn follows it", () => {
    expect(followWindowStart(turn(100, 300), 0)).toBe(100);
  });

  it("stops at most one more window back", () => {
    expect(followWindowStart(turn(60, 300), 0)).toBe(60);
    expect(followWindowStart(turn(59, 300), 0)).toBe(180);
  });

  it("does not stop at a message that is already above the window", () => {
    expect(followWindowStart(turn(100, 300), 150)).toBe(180);
  });

  it("is the tail window when the person has not written", () => {
    expect(followWindowStart(turn(-1, 300), 0)).toBe(180);
    expect(followWindowStart([], 0)).toBe(0);
  });

  it("moves back to the tail when the thread got shorter than the boundary allows", () => {
    expect(followWindowStart(turn(450, 560), 500)).toBe(440);
    expect(followWindowStart(turn(520, 560), 500)).toBe(440);
    expect(followWindowStart(turn(-1, 20), 500)).toBe(0);
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

describe("withRestingCard", () => {
  const rows = thread(300);
  const range = resolveTranscriptWindow(rows, tailWindowStart(rows.length));

  it("puts the newest resting card back on top when the range has left it behind", () => {
    const shown = withRestingCard(rows, range.visible, range.startIndex, (row) => row === 10 || row === 40);
    expect(shown[0]).toBe(40);
    expect(shown.slice(1)).toEqual(range.visible);
  });

  it("adds nothing when the newest resting card is already in the range", () => {
    expect(withRestingCard(rows, range.visible, range.startIndex, (row) => row === 10 || row === 250)).toBe(range.visible);
  });

  it("adds nothing when no card rests on the person", () => {
    expect(withRestingCard(rows, range.visible, range.startIndex, () => false)).toBe(range.visible);
    expect(withRestingCard(rows, range.visible, range.startIndex)).toBe(range.visible);
  });
});

describe("a two-sided window", () => {
  const drawn = (total: number, window: TranscriptWindowBounds) => resolveTranscriptWindow(thread(total), window.start, TRANSCRIPT_WINDOW_SIZE, window.end);

  it("draws at most the cap however many steps up the reader takes, then as many back down", () => {
    const total = 3_000;
    const steps = Math.ceil(total / TRANSCRIPT_WINDOW_STEP);
    let window: TranscriptWindowBounds = { start: tailWindowStart(total), end: null };
    const seen = new Set<number>();
    for (let step = 0; step < steps; step++) {
      window = windowEarlier(window, total);
      const shown = drawn(total, window);
      expect(shown.visible.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
      expect(shown.hiddenCount + shown.visible.length + shown.laterCount).toBe(total);
      for (const row of shown.visible) seen.add(row);
    }
    expect(window).toEqual({ start: 0, end: TRANSCRIPT_WINDOW_MAX });
    expect(seen.size, "every row was drawn on the way up").toBe(total);

    for (let step = 0; step < steps; step++) {
      const before = window;
      window = windowLater(window, total);
      expect(drawn(total, window).visible.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
      expect((window.end ?? total) - (before.end ?? total), "a step mounts at most one step of rows").toBeLessThanOrEqual(TRANSCRIPT_WINDOW_STEP);
    }
    expect(window).toEqual({ start: total - TRANSCRIPT_WINDOW_MAX, end: null });
  });

  it("keeps the rows it had on each step, so the row under the reader stays drawn", () => {
    const total = 1_000;
    expect(TRANSCRIPT_WINDOW_STEP).toBe(30);
    const up = windowEarlier({ start: 500, end: 740 }, total);
    expect(up).toEqual({ start: 470, end: 710 });
    const down = windowLater({ start: 470, end: 710 }, total);
    expect(down).toEqual({ start: 500, end: 740 });
  });

  it("caps only a window over the cap, and marks an end at the newest row as null", () => {
    expect(capWindowEnd({ start: 100, end: null }, 300)).toEqual({ start: 100, end: null });
    expect(capWindowEnd({ start: 0, end: null }, 300)).toEqual({ start: 0, end: TRANSCRIPT_WINDOW_MAX });
    expect(capWindowEnd({ start: 200, end: 300 }, 300)).toEqual({ start: 200, end: null });
  });

  it("moves over an older page put in front: one step of it at the top, the same rows anywhere else", () => {
    expect(windowAfterPrepend({ start: 0, end: null }, 200, 400)).toEqual({ start: 170, end: null });
    expect(windowAfterPrepend({ start: 0, end: null }, 50, 100)).toEqual({ start: 50 - TRANSCRIPT_WINDOW_STEP, end: null });
    expect(windowAfterPrepend({ start: 40, end: 200 }, 200, 600)).toEqual({ start: 240, end: 400 });
  });

  it("widens a window over the rows a selection spans, up to the hold's cap", () => {
    expect(holdRows({ start: 500, end: 740 }, 3_000, { first: 400, last: 410 })).toEqual({ start: 400, end: 740 });
    expect(holdRows({ start: 500, end: 740 }, 3_000, { first: 760, last: 800 })).toEqual({ start: 500, end: 801 });
    expect(holdRows({ start: 500, end: 740 }, 3_000, { first: 600, last: 610 })).toEqual({ start: 500, end: 740 });
    expect(holdRows({ start: 2_800, end: null }, 3_000, { first: 2_700, last: 2_999 })).toEqual({ start: 2_700, end: null });
    expect(holdRows({ start: 500, end: 740 }, 3_000, { first: 740 + SELECTION_HOLD_MAX, last: 740 + SELECTION_HOLD_MAX })).toBeNull();
    expect(holdRows({ start: 1_000, end: 1_240 }, 3_000, { first: 1_240 - SELECTION_HOLD_MAX, last: 1_000 })).toEqual({ start: 1_240 - SELECTION_HOLD_MAX, end: 1_240 });
  });

  it("puts a remembered row back inside a capped window", () => {
    const window = restoreWindow(3_000, 1_000, 0);
    expect(window.start).toBeLessThanOrEqual(1_000);
    expect(window.end).not.toBeNull();
    expect(window.end! - window.start).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
    expect(window.end).toBeGreaterThan(1_000);
    expect(restoreWindow(300, 250, 200)).toEqual({ start: 180, end: null });
  });
});
