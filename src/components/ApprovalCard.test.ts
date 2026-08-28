import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "./ApprovalCard";
import { spokenApprovalPrompt, type Pending } from "./PendingApproval";
import type { Message } from "@/state/store";

const routineRequest = {
  version: 1 as const,
  requestId: "routine-request",
  botId: "bot-1",
  threadId: "thread-1",
  createdAt: 1,
};

const createRoutineOperation = {
  action: "create" as const,
  routine: {
    name: "Backlog review",
    instructions: "Review every item in the backlog.",
    schedule: { type: "daily" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    runOn: "maus" as const,
    durationMinutes: 30,
  },
};

describe("ApprovalCard routine proposals", () => {
  it("describes a chat-created routine as scheduling rather than a raw tool call", () => {
    const message: Message = {
      id: "routine-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Confirm routine",
        subtitle: "Weekdays at 09:00",
        options: ["Confirm", "Cancel"],
        requestId: "routine-request",
        tool: "schedule_routine",
        routineRequest: { ...routineRequest, operation: createRoutineOperation },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("Wants to schedule a routine");
    expect(markup).toContain("Weekdays at 09:00");
  });

  it("records the exact routine action after confirmation", () => {
    const message: Message = {
      id: "routine-delete-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Delete “Daily inbox”?",
        subtitle: "Delete “Daily inbox”?\nWhen: Weekdays at 09:00",
        options: ["Confirm", "Cancel"],
        answered: "allow",
        requestId: "routine-request",
        tool: "manage_routine",
        routineRequest: {
          ...routineRequest,
          operation: { action: "delete", routineId: "routine-1", expectedUpdatedAt: 1 },
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("Delete “Daily inbox”?");
    expect(markup).toContain("Routine deleted");
  });

  it("does not imply a run-now request has already started", () => {
    const message: Message = {
      id: "routine-run-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Run now “Daily inbox”?",
        subtitle: "Action: Run routine now\nName: Daily inbox",
        options: ["Confirm", "Cancel"],
        answered: "allow",
        requestId: "routine-request",
        tool: "manage_routine",
        routineRequest: {
          ...routineRequest,
          operation: { action: "run_now", routineId: "routine-1", expectedUpdatedAt: 1 },
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("Routine run queued");
    expect(markup).not.toContain("Routine started");
  });

  it("speaks a routine's concise title instead of narrating all instructions", () => {
    const instructions = "Review every item in the backlog. ".repeat(500);
    const message: Message = {
      id: "routine-voice-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Schedule routine “Backlog review”?",
        subtitle: `Action: Create routine\n\nInstructions:\n${instructions}`,
        options: ["Confirm", "Cancel"],
        requestId: "routine-request",
        tool: "schedule_routine",
        routineRequest: { ...routineRequest, operation: createRoutineOperation },
      },
    };
    const pending: Pending = {
      message,
      requestId: "routine-request",
      tool: "schedule_routine",
      detail: message.card!.subtitle,
    };

    const spoken = spokenApprovalPrompt(pending, "Mochi");
    expect(spoken).toContain("Schedule routine “Backlog review”?");
    expect(spoken).toContain("Review the schedule and instructions on screen");
    expect(spoken).not.toContain("Review every item in the backlog");
    expect(spoken.length).toBeLessThan(200);
  });
});
