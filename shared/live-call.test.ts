import { describe, expect, it } from "vitest";

import { clampAppend, commentaryChunks, formatCallDuration, FULL_ANSWER_IN_CHAT, joinFragments, LiveTranscript, liveCallRowText } from "./live-call.ts";

describe("LiveTranscript", () => {
  it("rebuilds each delegated request from the words spoken since the previous one", () => {
    const transcript = new LiveTranscript();
    transcript.addInput("Can you check", 100, 600);
    transcript.addInput(" the open pull", 600, 1_100);
    transcript.addInput(" requests?", 1_100, 1_500);
    expect(transcript.takeRequest(1_500)).toBe("Can you check the open pull requests?");

    transcript.addInput("And merge the green", 9_000, 9_600);
    transcript.addInput(" ones.", 9_600, 9_900);
    expect(transcript.takeRequest(9_700)).toBe("And merge the green ones.");
    expect(transcript.takeRequest(12_000)).toBe("");
  });

  it("includes the tail of a sentence that finished just after the delegation", () => {
    const transcript = new LiveTranscript();
    transcript.addInput("Rename the file", 0, 800);
    transcript.addInput(" to notes.md", 900, 1_600);
    transcript.addInput(" later remark", 5_000, 5_500);
    expect(transcript.takeRequest(800)).toBe("Rename the file to notes.md");
    expect(transcript.pending()).toBe("later remark");
  });

  it("can mark everything heard as handled without building a request", () => {
    const transcript = new LiveTranscript();
    transcript.addInput("yes", 0, 300);
    expect(transcript.pending()).toBe("yes");
    transcript.consumeAll();
    expect(transcript.pending()).toBe("");
    expect(transcript.takeRequest(10_000)).toBe("");
  });

  // The voice's own words, picked up again by the microphone (a phone on
  // speaker), arrive as input. For a spoken yes or no they must not count.
  it("can leave out what was heard while the voice itself was speaking", () => {
    const transcript = new LiveTranscript();
    transcript.addOutput(900, 1_400);
    transcript.addOutput(1_400, 2_000);
    transcript.addInput("Okay, I need your permission", 1_000, 1_900);
    transcript.addInput(" no", 3_000, 3_200);
    expect(transcript.pending({ skipEcho: true })).toBe("no");
    expect(transcript.pending()).toBe("Okay, I need your permission no");
    expect(transcript.takeRequestParts(3_200)).toEqual({ text: "Okay, I need your permission no", withoutEcho: "no" });
    // both are consumed either way
    expect(transcript.pending()).toBe("");
  });

  it("keeps input that only touches the voice's speech, and ignores spans without timing", () => {
    const transcript = new LiveTranscript();
    transcript.addOutput(Number.NaN, Number.NaN);
    transcript.addOutput(500, 1_000);
    transcript.addInput("yes", 1_000, 1_300);
    expect(transcript.pending({ skipEcho: true })).toBe("yes");
  });

  it("glues fragments as delivered and normalizes whitespace", () => {
    expect(joinFragments(["hel", "lo ", " world\n"])).toBe("hello world");
  });
});

describe("commentaryChunks", () => {
  it("keeps a short answer as one append", () => {
    expect(commentaryChunks(["The tests pass.", "Two files changed."])).toEqual(["The tests pass. Two files changed."]);
  });

  it("stays within the per-append limit and points to the chat when it cuts", () => {
    const sentence = "This sentence is about seventy characters long, give or take a word. ";
    const utterances = Array.from({ length: 200 }, () => sentence.trim());
    const chunks = commentaryChunks(utterances);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(500);
    expect(chunks.at(-1)?.endsWith(FULL_ANSWER_IN_CHAT)).toBe(true);
    expect(chunks.slice(0, -1).some((chunk) => chunk.includes(FULL_ANSWER_IN_CHAT))).toBe(false);
  });

  it("splits a single overlong utterance instead of dropping it", () => {
    const long = "word ".repeat(600).trim();
    const chunks = commentaryChunks([long]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  it("returns nothing for an empty answer", () => {
    expect(commentaryChunks(["", "  "])).toEqual([]);
  });

  it("keeps multilingual chunks inside a conservative 500-byte token bound", () => {
    const chunks = commentaryChunks(["😀漢字".repeat(400)]);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(500);
    expect(chunks.at(-1)?.endsWith(FULL_ANSWER_IN_CHAT)).toBe(true);
  });
});

describe("clampAppend", () => {
  it("leaves short content alone and trims long content at a word", () => {
    expect(clampAppend("  hello   there ")).toBe("hello there");
    const clamped = clampAppend("alpha ".repeat(400));
    expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(500);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("bounds appends containing multibyte text without splitting a code point", () => {
    const clamped = clampAppend("😀漢字".repeat(100));
    expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(500);
    expect(clamped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("a call's length", () => {
  it("reads m:ss under an hour and h:mm:ss from an hour on", () => {
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(7)).toBe("0:07");
    expect(formatCallDuration(102)).toBe("1:42");
    expect(formatCallDuration(3_599)).toBe("59:59");
    expect(formatCallDuration(3_600)).toBe("1:00:00");
    expect(formatCallDuration(3_725)).toBe("1:02:05");
  });

  it("reads anything that is not a length as 0:00, and drops part-seconds", () => {
    expect(formatCallDuration(-5)).toBe("0:00");
    expect(formatCallDuration(Number.NaN)).toBe("0:00");
    expect(formatCallDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatCallDuration(61.9)).toBe("1:01");
  });

  it("writes the call row's line for clients that do not know the row", () => {
    expect(liveCallRowText("Ada", 102)).toBe("Call with Ada · 1:42");
    expect(liveCallRowText("Ada", 3_725)).toBe("Call with Ada · 1:02:05");
  });
});
