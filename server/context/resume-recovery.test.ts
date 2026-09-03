// Whether a turn may be sent twice.
import { describe, expect, it } from "vitest";

import {
  classifyResumeFailure,
  mayReplay,
  recoveryPromptFor,
  type ResumeAttemptState,
} from "./resume-recovery.ts";
import type { TurnContextPlan } from "./types.ts";

const state = (over: Partial<ResumeAttemptState> = {}): ResumeAttemptState => ({
  attempted: true,
  rejected: true,
  promptSubmitted: false,
  producedOutput: false,
  ...over,
});

const plan = (replayPrompt: string): TurnContextPlan => ({
  ownership: "vendor-session",
  mode: "replay-required",
  currentPrompt: "what now?",
  replayPrompt,
  messages: [],
  budget: { contextWindow: 200_000, historyTokens: 100_000, limitsSource: "pattern" },
  diagnostics: { sourceItems: 0, sentItems: 0, estimatedInputTokens: 0, compacted: false, clipped: false },
});

describe("classifyResumeFailure", () => {
  it("is before-accept when a resume was rejected and nothing was sent", () => {
    expect(classifyResumeFailure(state())).toBe("before-accept");
    expect(mayReplay("before-accept")).toBe(true);
  });

  it("is after-accept once the prompt was submitted", () => {
    expect(classifyResumeFailure(state({ promptSubmitted: true }))).toBe("after-accept");
    expect(mayReplay("after-accept")).toBe(false);
  });

  it("is after-accept once ANYTHING streamed, whatever the bookkeeping says", () => {
    // output is the strongest evidence available: if the model spoke, the
    // prompt landed, and the tools it called have already run
    expect(classifyResumeFailure(state({ promptSubmitted: false, producedOutput: true }))).toBe("after-accept");
  });

  it("is unknown when no resume was attempted, or none was rejected", () => {
    expect(classifyResumeFailure(state({ attempted: false }))).toBe("unknown");
    expect(classifyResumeFailure(state({ rejected: false }))).toBe("unknown");
  });

  it("never permits a replay on an unproven boundary", () => {
    // an unproven guess is not a licence to repeat side effects
    expect(mayReplay("unknown")).toBe(false);
  });

  it("classifies from state alone — no error text is consulted", () => {
    // the whole input surface is booleans; there is nowhere for a provider's
    // prose to change the outcome
    for (const value of Object.values(state())) expect(typeof value).toBe("boolean");
  });
});

describe("recoveryPromptFor", () => {
  const replay = "[You are joining this conversation mid-thread…]\n\nUser: my dog is Biscuit\n\nwhat now?";

  it("rebuilds history for a safe failure", () => {
    const out = recoveryPromptFor({ plan: plan(replay), currentText: "what now?", failure: "before-accept" });
    expect(out).toEqual({ text: replay, replayed: true });
  });

  it("sends the turn UNCHANGED after acceptance, never a second copy", () => {
    for (const failure of ["after-accept", "unknown"] as const) {
      expect(recoveryPromptFor({ plan: plan(replay), currentText: "what now?", failure }))
        .toEqual({ text: "what now?", replayed: false });
    }
  });

  it("falls back to the current text when dispatch supplied no plan", () => {
    expect(recoveryPromptFor({ plan: undefined, currentText: "what now?", failure: "before-accept" }))
      .toEqual({ text: "what now?", replayed: false });
  });

  it("does not replay a thread whose only history is the message being sent", () => {
    // renderReplayPrompt returns the bare prompt when there is nothing to
    // replay; treating that as a rebuild would report a recovery that added
    // nothing
    expect(recoveryPromptFor({ plan: plan("what now?"), currentText: "what now?", failure: "before-accept" }))
      .toEqual({ text: "what now?", replayed: false });
  });

  it("carries the current message exactly once", () => {
    const out = recoveryPromptFor({ plan: plan(replay), currentText: "what now?", failure: "before-accept" });
    expect(out.text.match(/what now\?/g)).toHaveLength(1);
  });
});
