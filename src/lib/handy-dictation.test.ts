import { describe, expect, it } from "vitest";

import {
  EMPTY_CLIPBOARD_SENTINEL,
  SILENCE_FRAMES_TO_STOP,
  baselineText,
  extractTranscript,
  isSilentFrame,
  shouldStopRecording,
  stepSilence,
} from "./handy-dictation";
import { rmsOf } from "./voice-dictation";

describe("isSilentFrame", () => {
  it("judges by RMS — a quiet room is silent, speech is not", () => {
    expect(isSilentFrame(new Float32Array(512))).toBe(true);
    expect(isSilentFrame(new Float32Array(512).map((_, i) => (i % 2 === 0 ? 0.3 : -0.3)))).toBe(false);
  });
});

describe("silence watchdog", () => {
  it("counts consecutive silent frames and resets on voice", () => {
    let frames = 0;
    frames = stepSilence(frames, true);
    frames = stepSilence(frames, true);
    expect(shouldStopRecording(frames)).toBe(true);
    frames = stepSilence(frames, false); // speech again
    expect(frames).toBe(0);
    expect(shouldStopRecording(frames)).toBe(false);
  });

  it("does not stop before the threshold", () => {
    expect(shouldStopRecording(SILENCE_FRAMES_TO_STOP - 1)).toBe(false);
  });
});

describe("clipboard transcript detection", () => {
  it("takes the snapshot before recording; empty clipboards get the sentinel", () => {
    expect(baselineText("previous copy text")).toBe("previous copy text");
    expect(baselineText("")).toBe(EMPTY_CLIPBOARD_SENTINEL);
  });

  it("detects the transcript as a change from the baseline", () => {
    expect(extractTranscript("old", "hello world")).toBe("hello world");
    expect(extractTranscript(EMPTY_CLIPBOARD_SENTINEL, "hello world")).toBe("hello world");
  });

  it("waits while the clipboard is unchanged", () => {
    expect(extractTranscript("old", "old")).toBe("");
    expect(extractTranscript(EMPTY_CLIPBOARD_SENTINEL, "")).toBe("");
    // Handy never transcribes to empty: an empty clipboard after the
    // sentinel baseline is still "nothing yet".
    expect(extractTranscript("old", "")).toBe("");
  });
});

describe("rmsOf contract", () => {
  it("matches the voice-dictation threshold scale", () => {
    expect(rmsOf(new Float32Array(256))).toBeLessThan(0.01);
  });
});
