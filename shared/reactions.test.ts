import { describe, expect, it } from "vitest";

import { normalizeReaction, reactionAnswer, REACTIONS } from "./reactions.ts";

describe("reactions", () => {
  it("reads 👍 as yes and 👎 as no, and nothing else as an answer", () => {
    expect(reactionAnswer("👍")).toBe("yes");
    expect(reactionAnswer("👎")).toBe("no");
    for (const feeling of REACTIONS.filter((emoji) => emoji !== "👍" && emoji !== "👎")) expect(reactionAnswer(feeling)).toBeNull();
    expect(reactionAnswer(undefined)).toBeNull();
    expect(reactionAnswer(null)).toBeNull();
  });

  it("takes each offered emoji as itself", () => {
    for (const emoji of REACTIONS) expect(normalizeReaction(emoji)).toBe(emoji);
  });

  it("takes the same emoji however a platform spells it", () => {
    expect(normalizeReaction("👍🏽")).toBe("👍");
    expect(normalizeReaction("👎🏿")).toBe("👎");
    expect(normalizeReaction("❤")).toBe("❤️");
    expect(normalizeReaction(" 👀 ")).toBe("👀");
  });

  it("takes Slack's names, with or without colons and skin tones", () => {
    expect(normalizeReaction("+1")).toBe("👍");
    expect(normalizeReaction(":thumbsup:")).toBe("👍");
    expect(normalizeReaction("+1::skin-tone-4")).toBe("👍");
    expect(normalizeReaction("-1")).toBe("👎");
    expect(normalizeReaction("thumbsdown")).toBe("👎");
    expect(normalizeReaction("heart")).toBe("❤️");
    expect(normalizeReaction("joy")).toBe("😂");
    expect(normalizeReaction("tada")).toBe("🎉");
    expect(normalizeReaction("eyes")).toBe("👀");
  });

  it("refuses anything outside the set", () => {
    for (const raw of ["🔥", "👍👍", "yes", "white_check_mark", "", "__proto__", "constructor", "toString", 1, null, undefined, {}, "👍".repeat(40)]) {
      expect(normalizeReaction(raw), String(raw)).toBeNull();
    }
  });
});
