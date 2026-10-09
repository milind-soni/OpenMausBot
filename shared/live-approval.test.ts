import { describe, expect, it } from "vitest";

import { LIVE_COPY, liveCardKind, liveStepLabel, liveDecisionRefusal, spokenApprovalPrompt, spokenQuestionPrompt, spokenReviewPrompt, toolPhrase } from "./live-approval.ts";
import type { OptionCardData } from "./wire.ts";

const card = (extra: Partial<OptionCardData>): OptionCardData => ({ title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], ...extra });

describe("liveCardKind", () => {
  it("classifies open provider approvals, harness reviews and questions", () => {
    expect(liveCardKind(card({ requestId: "r1", tool: "Bash" }))).toBe("approval");
    expect(liveCardKind(card({ requestId: "r1", tool: "stage_skill", skillRequest: { action: "create" } as OptionCardData["skillRequest"] }))).toBe("review");
    expect(liveCardKind(card({ requestId: "r1", tool: "schedule_routine", routineRequest: {} as OptionCardData["routineRequest"] }))).toBe("review");
    expect(liveCardKind(card({ requestId: "r1" }))).toBe("question");
  });
  it("sends a default-model proposal to the screen, though it names a tool", () => {
    // propose_model cards carry update_model; a spoken yes must never reach
    // them as an approval
    expect(liveCardKind(card({ requestId: "r1", tool: "update_model", modelRequest: {} as OptionCardData["modelRequest"] }))).toBe("review");
    expect(liveDecisionRefusal(card({ requestId: "r1", tool: "update_model", modelRequest: {} as OptionCardData["modelRequest"] })))
      .toBe("This request is reviewed on screen.");
  });
  it("ignores settled cards and cards without a request", () => {
    expect(liveCardKind(card({ requestId: "r1", tool: "Bash", answered: "allow" }))).toBeNull();
    expect(liveCardKind(card({ requestId: "r1", tool: "Bash", dismissed: true }))).toBeNull();
    expect(liveCardKind(card({ requestId: "r1", tool: "update_model", modelRequest: {} as OptionCardData["modelRequest"], expired: true }))).toBeNull();
    expect(liveCardKind(card({}))).toBeNull();
    expect(liveCardKind(undefined)).toBeNull();
  });
});

describe("liveDecisionRefusal", () => {
  it("delivers a decision to an open approval or question", () => {
    expect(liveDecisionRefusal(card({ requestId: "r1", tool: "Bash" }))).toBeNull();
    expect(liveDecisionRefusal(card({ requestId: "r1" }))).toBeNull();
  });
  it("refuses a card settled on screen a moment earlier, and a harness review", () => {
    expect(liveDecisionRefusal(card({ requestId: "r1", tool: "Bash", answered: "allow" }))).toBe("The request is no longer open.");
    expect(liveDecisionRefusal(card({ requestId: "r1", dismissed: true }))).toBe("The request is no longer open.");
    expect(liveDecisionRefusal(card({ requestId: "r1", tool: "Bash", expired: true }))).toBe("The request is no longer open.");
    expect(liveDecisionRefusal(card({ requestId: "r1", tool: "stage_skill", skillRequest: { action: "create" } as OptionCardData["skillRequest"] })))
      .toBe("This request is reviewed on screen.");
  });
  it("leaves a card that is not on the thread to the normal answer path", () => {
    expect(liveDecisionRefusal(undefined)).toBeNull();
  });
});

describe("spoken prompts", () => {
  it("names the tool as a verb phrase, never the raw tool id", () => {
    expect(toolPhrase("Bash")).toBe("run a command");
    expect(toolPhrase("mcp__ogb__computer_batch")).toBe("computer batch");
    expect(toolPhrase(undefined)).toBe("take an action");
    expect(spokenApprovalPrompt(card({ requestId: "r1", tool: "Bash" }))).toBe("I want to run a command. rm -rf build. May I?");
  });
  it("keeps a long detail short enough to read aloud", () => {
    const prompt = spokenApprovalPrompt(card({ requestId: "r1", tool: "Bash", subtitle: "x ".repeat(800) }));
    expect(prompt.length).toBeLessThan(520);
  });
  it("sends reviews to the chat and reads questions with their options", () => {
    expect(spokenReviewPrompt(card({ requestId: "r1", title: "Enable the invoice skill" }))).toBe(
      "Tell the user, in your own words, that you need their decision in the chat: Enable the invoice skill. They review it on screen and choose there; it cannot be decided by voice.",
    );
    expect(spokenQuestionPrompt(card({ requestId: "r1", subtitle: "Which account?", options: ["Main", "Savings"] }))).toBe(
      "Ask the user, in your own words: Which account? The options are Main, Savings. Then delegate their answer.",
    );
  });
  it("never doubles the question mark of a question that ends in one", () => {
    expect(spokenQuestionPrompt(card({ requestId: "r1", subtitle: "Which one??", options: [] }))).toBe(
      "Ask the user, in your own words: Which one? Then delegate their answer.",
    );
  });
  it("has fixed copy for the call", () => {
    expect(LIVE_COPY.granted).toBe("Thanks, I'll go ahead.");
    expect(LIVE_COPY.denied).toBe("Okay, I won't do it.");
    expect(LIVE_COPY.noAnswer).toBe("I'm done. The result, or what went wrong, is in the chat.");
    expect(LIVE_COPY.deniedMessage).toBe("Denied by the user, on a live call.");
  });
});

describe("liveStepLabel", () => {
  it("prefers the tool's spoken label, then its name, and never its arguments", () => {
    expect(liveStepLabel({ name: "mcp__agents__list_bots", spoken: "Checking the team" })).toBe("Checking the team");
    expect(liveStepLabel({ name: "mcp__team-notes__query_database" })).toBe("team notes: query database");
    expect(liveStepLabel({ name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL" })).toBe("composio: COMPOSIO MULTI EXECUTE TOOL");
    expect(liveStepLabel({ name: "Bash" })).toBe("run a command");
    expect(liveStepLabel({ name: `mcp__x__${"y".repeat(200)}` }).length).toBeLessThanOrEqual(81);
  });
  it("words a status note with the time, the steps and the last step", () => {
    expect(LIVE_COPY.status(250_000, 12, "team notes: query database", 40_000)).toBe(
      "Status note, do not announce it: you are still working on it (4 minutes so far, 12 steps; last step: team notes: query database, 40 seconds ago).",
    );
    expect(LIVE_COPY.status(1_000, 1, null, 0)).toBe("Status note, do not announce it: you are still working on it (1 second so far, 1 step).");
  });
});
