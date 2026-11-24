import { describe, expect, it } from "vitest";
import { BOT_BUBBLE_FINISH, joinedCorners, plainBotBubble, SIMPLE_BOT_BUBBLE, SIMPLE_STACKED, SIMPLE_USER_BUBBLE } from "./chat-bubble";

describe("a run of one sender's bubbles", () => {
  it("gives each bubble in the run a 6px tail at its bottom corner on its own side, and keeps the top corners round", () => {
    for (const join of [{ above: false, below: true }, { above: true, below: true }, { above: true, below: false }]) {
      expect(joinedCorners("start", join)).toBe("rounded-es-[6px]");
      expect(joinedCorners("end", join)).toBe("rounded-ee-[6px]");
    }
  });

  it("leaves a lone bubble round all over", () => {
    expect(joinedCorners("start", { above: false, below: false })).toBe("");
    expect(joinedCorners("end", { above: false, below: false })).toBe("");
  });

  it("pulls a bubble in the same run up from the 16px between senders to 4px", () => {
    expect(SIMPLE_STACKED).toBe("-mt-3");
  });
});

describe("a bot's bubble finish", () => {
  it("finishes every bot bubble recipe, in both modes, and never the person's own", () => {
    expect(BOT_BUBBLE_FINISH).toBe("bubble-finish");
    expect(SIMPLE_BOT_BUBBLE.split(" ")).toEqual(expect.arrayContaining(["bg-card", BOT_BUBBLE_FINISH]));
    expect(plainBotBubble(true).split(" ")).toContain(BOT_BUBBLE_FINISH);
    expect(plainBotBubble(false).split(" ")).toEqual(expect.arrayContaining(["bg-card", BOT_BUBBLE_FINISH]));
    expect(SIMPLE_USER_BUBBLE.split(" ")).not.toContain(BOT_BUBBLE_FINISH);
  });
});
