import { describe, expect, it } from "vitest";
import { insertTaskMention, taskMentionMatches, taskMentionQueryAt } from "./taskMentions";
import type { TaskRecord } from "./taskBoard";

function task(patch: Partial<TaskRecord>): TaskRecord {
  return {
    id: "id",
    mention: "task",
    title: "Task",
    description: "",
    acceptanceCriteria: [],
    status: "todo",
    type: "feature",
    priority: "normal",
    tags: [],
    dueAt: null,
    projectId: null,
    assigneeBotId: null,
    position: 1024,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: { kind: "user" },
    updatedBy: { kind: "user" },
    activity: [],
    project: null,
    assignee: null,
    ...patch,
  };
}

const tasks: TaskRecord[] = [
  task({ id: "one", mention: "fix-qt6-styling", title: "Fix Qt6 styling" }),
  task({ id: "two", mention: "ship-login", title: "Ship login" }),
];

describe("taskMentionQueryAt", () => {
  it("finds a handle query at the caret", () => {
    expect(taskMentionQueryAt("Work on %fix", 12)).toEqual({ start: 8, query: "fix" });
    expect(taskMentionQueryAt("(%ship-", 7)).toEqual({ start: 1, query: "ship-" });
  });

  it("ignores embedded and completed percent signs", () => {
    expect(taskMentionQueryAt("50%fix", 6)).toBeNull();
    expect(taskMentionQueryAt("Use %fix-qt6-styling now", 24)).toBeNull();
  });

  it("inserts the canonical handle without dropping trailing text", () => {
    expect(insertTaskMention("Use %fi today", 7, { start: 4, query: "fi" }, "fix-qt6-styling")).toEqual({
      text: "Use %fix-qt6-styling today",
      caret: 21,
    });
  });
});

describe("taskMentionMatches", () => {
  it("matches known handles case-insensitively and deduplicates references", () => {
    const text = "Check %Fix-Qt6-Styling, then %ship-login and %fix-qt6-styling.";
    expect(taskMentionMatches(text, tasks).map((match) => match.task.id)).toEqual(["one", "two", "one"]);
  });

  it("leaves unknown mentions and embedded percent signs alone", () => {
    expect(taskMentionMatches("Keep %general and 50%fix-qt6-styling plain", tasks)).toEqual([]);
  });
});
