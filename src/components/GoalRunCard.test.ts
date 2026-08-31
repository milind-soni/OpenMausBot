import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GroupGoalRunCardData } from "../../shared/group-goal-run";
import type { Message } from "@/state/store";
import { GoalRunCard } from "./GoalRunCard";

function message(status: GroupGoalRunCardData["status"], detail?: string): Message {
  return {
    id: "goal-run-card",
    role: "bot",
    kind: "goal.run",
    at: 1,
    goalRun: {
      runId: "run-1",
      goal: "Write and polish the launch announcement",
      status,
      coordinatorBotId: "bot-1",
      coordinatorName: "Sprout",
      turnCount: status === "working" ? 2 : 5,
      maxTurns: 12,
      detail,
      startedAt: 1,
    },
  };
}

describe("GoalRunCard", () => {
  it("shows live goal progress without expanding into a run log", () => {
    const markup = renderToStaticMarkup(createElement(GoalRunCard, {
      message: message("working", "Luna is reviewing the second draft."),
    }));

    expect(markup).toContain("Write and polish the launch announcement");
    expect(markup).toContain("Working");
    expect(markup).toContain("Luna is reviewing the second draft.");
    expect(markup).toContain("Sprout coordinating · Turn 3 of 12");
    expect(markup).toContain('aria-label="Goal run: Working"');
  });

  it.each([
    ["completed", "Completed"],
    ["needs-input", "Needs your input"],
    ["blocked", "Blocked"],
    ["limit-reached", "Turn limit reached"],
    ["stopped", "Stopped"],
    ["failed", "Failed"],
  ] as const)("renders the %s terminal status", (status, label) => {
    const markup = renderToStaticMarkup(createElement(GoalRunCard, { message: message(status) }));
    expect(markup).toContain(label);
    expect(markup).toContain("Sprout coordinating · 5 turns");
  });

  it("keeps an incomplete payload readable", () => {
    const legacy: Message = {
      id: "goal-run-fallback",
      role: "bot",
      kind: "goal.run",
      at: 1,
      text: "The channel goal is complete.",
    };
    expect(renderToStaticMarkup(createElement(GoalRunCard, { message: legacy })))
      .toContain("The channel goal is complete.");
  });
});
