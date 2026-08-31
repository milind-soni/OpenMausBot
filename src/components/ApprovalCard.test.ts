import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "./ApprovalCard";
import { spokenApprovalPrompt, type Pending } from "./PendingApproval";
import type { Message } from "@/state/store";
import { skillRequestBehavior } from "../../shared/skill-request";

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

describe("ApprovalCard learned skills", () => {
  it("maps create and update choices to approval while keeping refusals denied", () => {
    expect(skillRequestBehavior("Enable")).toBe("allow");
    expect(skillRequestBehavior("Update")).toBe("allow");
    expect(skillRequestBehavior("Apply")).toBe("allow");
    expect(skillRequestBehavior("Deny")).toBe("deny");
    expect(skillRequestBehavior("Dismiss")).toBe("deny");
    expect(skillRequestBehavior("unexpected")).toBe("deny");
  });

  it("describes a staged skill as enablement rather than a raw tool call", () => {
    const message: Message = {
      id: "skill-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: 'Enable skill "file-expense"?',
        subtitle: "Files an expense in the company portal.",
        options: ["Enable", "Deny"],
        requestId: "skill-request",
        tool: "stage_skill",
        skillRequest: {
          version: 1,
          requestId: "skill-request",
          botId: "bot-1",
          threadId: "thread-1",
          stagedId: "staged-1",
          action: "create",
          name: "file-expense",
          gist: "Files an expense in the company portal.",
          source: "learn:conversation",
          preview: "---\nname: file-expense\ndescription: Files an expense.\n---\n\n# File expense\n",
          sha256: "abcdef0123456789".repeat(4),
          warnings: [],
          createdAt: 1,
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("enable a learned skill");
    expect(markup).toContain("Files an expense in the company portal.");
    expect(markup).toContain("Review the complete SKILL.md before enabling");
    expect(markup).toContain("Source: learn:conversation");
    expect(markup).toContain("name: file-expense");
    expect(markup).toContain("sha256 abcdef01");

    const spoken = spokenApprovalPrompt(
      { message, requestId: "skill-request", tool: "stage_skill", detail: message.card!.subtitle },
      "Mochi",
    );
    expect(spoken).toContain('Enable skill "file-expense"?');
    expect(spoken).toContain("Should I enable it?");
  });

  it("labels a reviewed skill replacement as an update", () => {
    const message: Message = {
      id: "skill-update",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: 'Update skill "verify-app"?',
        subtitle: "Refreshes the verified workflows.",
        options: ["Update", "Deny"],
        requestId: "skill-update-request",
        tool: "stage_skill",
        skillRequest: {
          version: 1,
          requestId: "skill-update-request",
          botId: "bot-1",
          threadId: "thread-1",
          stagedId: "staged-update",
          action: "update",
          name: "verify-app",
          gist: "Refreshes the verified workflows.",
          source: "learn:maintenance",
          preview: "---\nname: verify-app\ndescription: Verifies the app.\n---\n",
          sha256: "abcdef0123456789".repeat(4),
          warnings: [],
          createdAt: 1,
        },
      },
    };

    expect(renderToStaticMarkup(createElement(ApprovalCard, { message }))).toContain("update a learned skill");
    expect(renderToStaticMarkup(createElement(ApprovalCard, { message }))).toContain("replacing the current version");
    const spoken = spokenApprovalPrompt(
      { message, requestId: "skill-update-request", tool: "stage_skill", detail: message.card!.subtitle },
      "Mochi",
    );
    expect(spoken).toContain("Should I update it?");

    message.card!.answered = "allow";
    expect(renderToStaticMarkup(createElement(ApprovalCard, { message }))).toContain("Skill updated");
  });

  it("keeps an old persisted skill card readable but deny-only", () => {
    const message: Message = {
      id: "legacy-skill-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Enable old skill?",
        subtitle: "This card predates reviewed hashes.",
        options: ["Enable", "Dismiss"],
        requestId: "legacy-request",
        tool: "stage_skill",
        skillRequest: {
          version: 1,
          requestId: "legacy-request",
          botId: "bot-1",
          threadId: "thread-1",
          stagedId: "staged-1",
          action: "create",
          name: "old-skill",
          gist: "Old skill",
          warnings: [],
          createdAt: 1,
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("created by an older build");
    expect(markup).toContain("cannot be safely applied");
    expect(markup).toContain("create the skill again");

    message.card!.skillRequest!.action = "update";
    expect(renderToStaticMarkup(createElement(ApprovalCard, { message })))
      .toContain("propose the update again");
  });
});
