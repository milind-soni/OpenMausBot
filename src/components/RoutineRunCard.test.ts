import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RoutineRunCardData } from "../../shared/routine-run";
import type { Message } from "@/state/store";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";

function message(
  status: RoutineRunCardData["status"],
  patch: Partial<RoutineRunCardData> = {},
): Message {
  return {
    id: "routine-run-card",
    role: "bot",
    kind: "routine.run",
    at: 1,
    text: "Morning brief routine update",
    routineRun: {
      runId: "run-1",
      routineId: "routine-1",
      routineName: "Morning brief",
      status,
      executionThreadId: "execution-thread",
      ...patch,
    },
  };
}

describe("RoutineRunCard", () => {
  it("dates the receipt by its scheduled occurrence, with a legacy message-time fallback", () => {
    const at = Date.UTC(2026, 8, 9, 9);
    const dated = renderToStaticMarkup(createElement(RoutineRunCard, { message: message("completed", { scheduledFor: at }) }));
    expect(dated).toContain(`dateTime="${new Date(at).toISOString()}"`);
    const legacy = renderToStaticMarkup(createElement(RoutineRunCard, { message: message("completed") }));
    expect(legacy).toContain('dateTime="1970-01-01T00:00:00.001Z"');
  });
  it("shows a compact completion receipt and a path to the isolated run", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("completed", { summary: "The brief is ready with three follow-ups." }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Completed");
    expect(markup).toContain("The brief is ready with three follow-ups.");
    expect(markup).toContain("Open run");
    expect(markup).toContain('aria-label="Morning brief routine run: Completed"');
  });

  it("keeps a long dated report available behind a collapsed disclosure", () => {
    const summary = `The brief is ready. ${"Detailed result. ".repeat(25)}\nFinal follow-up.`;
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("completed", { summary }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Show report");
    expect(markup).toContain(summary);
    expect(markup).toContain("<details ");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain('aria-label="Open run for Morning brief"');
  });

  it("keeps a terminal team-goal outcome distinct from scheduler completion", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("completed", { goalStatus: "blocked", summary: "The team needs a missing credential." }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Blocked");
    expect(markup).not.toContain(">Completed<");
    expect(markup).toContain("The team needs a missing credential.");
  });

  it("does not describe delegated work as a question or approval", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("waiting", { summary: "Waiting for delegated work to finish." }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Waiting for delegated work to finish.");
    expect(markup).toContain("Open run");
    expect(markup).not.toContain("Needs your input");
    expect(markup).not.toContain("Review");
  });

  it("keeps an explicit team-goal input request actionable", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("waiting", { goalStatus: "needs-input", summary: "Which region should I use?" }),
      onOpen: vi.fn(),
    }));
    expect(markup).toContain("Needs your input");
    expect(markup).toContain('aria-label="Review for Morning brief"');
  });

  it("shows a concise error without dumping a verbose run log into chat", () => {
    const verbose = `Provider failed ${"trace-line ".repeat(100)}`;
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("failed", { error: verbose }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Failed");
    expect(markup).toContain("Provider failed");
    expect(markup).toContain("…");
    expect(markup).not.toContain(verbose);
  });

  it("keeps a concise text fallback visible for an incomplete or newer payload", () => {
    const legacy: Message = {
      id: "legacy-run",
      role: "bot",
      kind: "routine.run",
      at: 1,
      text: "Morning brief completed.",
    };

    const markup = renderToStaticMarkup(createElement(RoutineRunCard, { message: legacy }));
    expect(markup).toContain("Morning brief completed.");
  });

  it("does not offer a dead navigation action when the execution task is unavailable", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunCard, {
      message: message("missed", { executionThreadId: undefined, error: "Computer was offline." }),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("Missed");
    expect(markup).not.toContain("Open run");
  });

  it("recognizes only an execution thread still present in the owning bot's tasks", () => {
    const tasks = [{ threadId: "source-thread" }, { threadId: "execution-thread" }];

    expect(hasRoutineExecutionTask(tasks, "execution-thread")).toBe(true);
    expect(hasRoutineExecutionTask(tasks, "deleted-thread")).toBe(false);
    expect(hasRoutineExecutionTask(undefined, "execution-thread")).toBe(false);
  });
});
