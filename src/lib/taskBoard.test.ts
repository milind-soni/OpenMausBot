import { describe, expect, it } from "vitest";
import {
  EMPTY_TASK_FILTERS,
  TASK_STARTER_PRESETS,
  activeTaskFilterCount,
  filterBoardTasks,
  positionForDrop,
  secondaryTaskFilterCount,
  type TaskRecord,
} from "./taskBoard";

const task = (patch: Partial<TaskRecord>): TaskRecord => ({
  id: "one",
  mention: "fix-agent-claim",
  title: "Fix agent claim",
  description: "Prevent races",
  acceptanceCriteria: ["One winner"],
  status: "todo",
  type: "bug",
  priority: "urgent",
  tags: ["agents"],
  dueAt: 10,
  projectId: "p1",
  assigneeBotId: null,
  position: 1024,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  createdBy: { kind: "user" },
  updatedBy: { kind: "user" },
  activity: [],
  project: { id: "p1", name: "Studio", mention: "studio", available: true },
  assignee: null,
  ...patch,
});

describe("task board helpers", () => {
  it("composes all visible filters", () => {
    const match = task({});
    const other = task({ id: "two", title: "Write docs", projectId: null, project: null, type: "documentation", tags: [] });
    const filters = {
      ...EMPTY_TASK_FILTERS,
      text: "studio winner",
      projectId: "p1",
      assigneeBotId: "unassigned",
      status: "todo",
      type: "bug",
      priority: "urgent",
      tag: "agents",
      overdue: true,
    };
    expect(filterBoardTasks([other, match], filters, 20)).toEqual([match]);
    expect(activeTaskFilterCount(filters)).toBe(8);
  });

  it("counts only popover filters in secondaryTaskFilterCount and provides starter presets", () => {
    expect(secondaryTaskFilterCount(EMPTY_TASK_FILTERS)).toBe(0);
    expect(secondaryTaskFilterCount({ ...EMPTY_TASK_FILTERS, projectId: "p1", assigneeBotId: "b1", status: "todo" })).toBe(0);
    expect(secondaryTaskFilterCount({ ...EMPTY_TASK_FILTERS, type: "bug", priority: "high", tag: "ux", overdue: true })).toBe(4);
    expect(TASK_STARTER_PRESETS.map((preset) => preset.type)).toEqual(["feature", "research", "documentation"]);
  });

  it("calculates stable positions for column drops", () => {
    const first = task({ id: "first", position: 100 });
    const second = task({ id: "second", position: 200 });
    expect(positionForDrop([first, second], "todo", "moving", "first")).toBe(-924);
    expect(positionForDrop([first, second], "todo", "moving", "second")).toBe(150);
    expect(positionForDrop([first, second], "todo", "first", null)).toBe(1224);
  });
});
