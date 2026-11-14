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
    expect(answerResponse({}, "Allow")).toEqual({ behavior: "answer", message: "Allow" });
    expect(answerResponse({}, "Deny")).toEqual({ behavior: "answer", message: "Deny" });
  });

  it("decides a permission card by its refusal, not by matching 'Allow'", () => {
    expect(answerResponse({ tool: "Bash" }, "Allow")).toEqual({ behavior: "allow" });
    expect(answerResponse({ tool: "Bash" }, "Deny")).toEqual({ behavior: "deny" });
    expect(answerResponse({ tool: "ask_bot" }, "Always allow")).toEqual({ behavior: "allow" });
    expect(answerResponse({ tool: "Bash" }, "Yes")).toEqual({ behavior: "allow" });
  });
});

describe("dismissResponse", () => {
  it("denies a permission but ANSWERS a question", () => {
    expect(dismissResponse({ tool: "Bash" })).toMatchObject({ behavior: "deny" });
    expect(dismissResponse({})).toMatchObject({ behavior: "answer", dismiss: true });
    expect(dismissResponse({}).message).toContain("without answering");
  });
});
