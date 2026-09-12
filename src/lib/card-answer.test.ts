import { describe, expect, it } from "vitest";

import { answerResponse, dismissResponse } from "./card-answer";

describe("answerResponse", () => {
  it("answers a question with the chosen text", () => {
    expect(answerResponse({}, "Software Engineer")).toEqual({
      behavior: "answer",
      message: "Software Engineer",
    });
  });

  it("answers a question whose option is literally 'Allow' with the TEXT, not an allow", () => {
    // the case the old label-matching rule got wrong: the broker refuses an
    // allow on a question, the card closes unreachable, and the bot waits
    // out its whole timeout
    expect(answerResponse({}, "Allow")).toEqual({ behavior: "answer", message: "Allow" });
    expect(answerResponse({}, "Deny")).toEqual({ behavior: "answer", message: "Deny" });
  });

  it("decides a permission card by its refusal, not by matching 'Allow'", () => {
    expect(answerResponse({ tool: "Bash" }, "Allow")).toEqual({ behavior: "allow" });
    expect(answerResponse({ tool: "Bash" }, "Deny")).toEqual({ behavior: "deny" });
    // peer-approval cards offer this third option; the grant is written
    // separately, so this one action is simply allowed
    expect(answerResponse({ tool: "ask_bot" }, "Always allow")).toEqual({ behavior: "allow" });
    // a card that says "Yes" rather than "Allow" still lets the action run
    expect(answerResponse({ tool: "Bash" }, "Yes")).toEqual({ behavior: "allow" });
  });
});

describe("dismissResponse", () => {
  it("denies a permission but ANSWERS a question", () => {
    expect(dismissResponse({ tool: "Bash" })).toMatchObject({ behavior: "deny" });
    // a deny on a question is refused by the broker, so closing the card
    // used to leave the bot waiting on a card that was already gone
    expect(dismissResponse({})).toMatchObject({ behavior: "answer" });
    expect(dismissResponse({}).message).toContain("without answering");
  });
});
