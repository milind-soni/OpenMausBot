import { afterEach, describe, expect, it } from "vitest";

import {
  FOLLOWING,
  forgetTranscriptPositions,
  initialTranscriptFollow,
  readTranscriptPosition,
  rememberTranscriptPosition,
  transitionTranscriptFollow,
  wantsJumpToLatest,
  type TranscriptFollow,
  type TranscriptFollowEvent,
} from "./transcript-follow";

const run = (from: TranscriptFollow, ...events: TranscriptFollowEvent["type"][]) =>
  events.reduce((state, type) => transitionTranscriptFollow(state, { type } as TranscriptFollowEvent), from);

afterEach(() => forgetTranscriptPositions());

describe("following a transcript's end", () => {
  it("opens following, or released when the reader left the conversation away from its end", () => {
    expect(initialTranscriptFollow(true)).toBe(FOLLOWING);
    expect(initialTranscriptFollow(false)).toEqual({ mode: "released", atEnd: false });
  });

  it("lets go when the reader navigates, and comes back only after leaving the end and returning", () => {
    const released = run(FOLLOWING, "navigated");
    expect(released).toEqual({ mode: "released", atEnd: true });
    expect(run(released, "reachedEnd"), "a scroll key at the end cannot re-arm").toBe(released);
    expect(run(released, "leftEnd")).toEqual({ mode: "released", atEnd: false });
    expect(run(released, "leftEnd", "reachedEnd")).toBe(FOLLOWING);
  });

  it("ignores the end band flickering while it follows a growing reply", () => {
    expect(run(FOLLOWING, "leftEnd", "reachedEnd", "leftEnd")).toBe(FOLLOWING);
  });

  it("follows again whenever the person asks for the end: a sent message or the latest button", () => {
    expect(run(FOLLOWING, "navigated", "leftEnd", "followEnd")).toBe(FOLLOWING);
  });

  it("offers the way down only once the reader is released away from the end", () => {
    expect(wantsJumpToLatest(FOLLOWING)).toBe(false);
    expect(wantsJumpToLatest(run(FOLLOWING, "navigated"))).toBe(false);
    expect(wantsJumpToLatest(run(FOLLOWING, "navigated", "leftEnd"))).toBe(true);
  });
});

describe("remembered positions", () => {
  it("keeps each conversation's own, the newest hundred", () => {
    rememberTranscriptPosition("a", { atEnd: false, rowId: "m3", offsetWithinRow: 12 });
    rememberTranscriptPosition("b", { atEnd: true });
    expect(readTranscriptPosition("a")).toEqual({ atEnd: false, rowId: "m3", offsetWithinRow: 12 });
    expect(readTranscriptPosition("b")).toEqual({ atEnd: true });
    for (let index = 0; index < 100; index++) rememberTranscriptPosition(`k${index}`, { atEnd: true });
    expect(readTranscriptPosition("a")).toBeUndefined();
    expect(readTranscriptPosition("k99")).toEqual({ atEnd: true });
  });
});
