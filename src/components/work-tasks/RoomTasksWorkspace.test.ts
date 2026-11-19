// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { computeRoomTaskOverview, type AgentTask } from "../../../shared/work-tasks";
import { TasksBoard } from "./TasksBoard";
import { TasksOverviewBar } from "./TasksOverviewBar";

const members: Bot[] = [
  {
    id: "coord",
    threadId: "t-coord",
    name: "Coordinator",
    title: "Lead",
    description: "",
    color: "blue",
    notifications: true,
    unread: false,
    busy: false,
    messages: [],
    modelSelection: { instanceId: "test", model: "m" },
  },
  {
    id: "be",
    threadId: "t-be",
    name: "Backend-Agent",
    title: "Backend Engineer",
    description: "",
    color: "green",
    notifications: true,
    unread: false,
    busy: true,
    messages: [],
    modelSelection: { instanceId: "test", model: "m" },
  },
];

const tasks: AgentTask[] = [
  {
    id: "task-1",
    key: "LOOMA-101",
    roomId: "room-1",
    type: "task",
    title: "Implement Auth API",
    status: "in-progress",
    priority: "high",
    coordinatorBotId: "coord",
    assigneeBotId: "be",
    assigneeName: "Backend-Agent",
    assigneeRole: "Backend Engineer",
    reporterType: "user",
    threadId: "t-be",
    dependencies: ["task-0"],
    evidence: [{ id: "e1", type: "test", label: "vitest", value: "passed", createdAt: 1 }],
    jiraSync: { issueKey: "PROJ-11" },
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "task-2",
    key: "LOOMA-102",
    roomId: "room-1",
    type: "bug",
    title: "Fix contract mismatch",
    status: "blocked",
    priority: "highest",
    assigneeBotId: "be",
    assigneeName: "Backend-Agent",
    assigneeRole: "Backend Engineer",
    reporterType: "agent",
    needsUserAction: true,
    needsUserReason: "Waiting on API contract",
    createdAt: 1,
    updatedAt: 3,
  },
];

describe("Agent Work Management UI components", () => {
  it("renders all 6 Kanban columns, cards, agent roles, Jira key, and overview counts", () => {
    const overview = computeRoomTaskOverview(
      tasks,
      members.map((m) => ({ id: m.id, name: m.name, title: m.title, busy: m.busy })),
    );
    expect(overview.total).toBe(2);
    expect(overview.inProgress).toBe(1);
    expect(overview.blocked).toBe(1);

    const overviewHtml = renderToStaticMarkup(
      createElement(TasksOverviewBar, {
        overview,
        members,
        activeFilter: {},
        onSelectFilter: vi.fn(),
      }),
    );
    expect(overviewHtml).toContain("Backend-Agent");
    expect(overviewHtml).toContain("Backend Engineer");

    const boardHtml = renderToStaticMarkup(
      createElement(TasksBoard, {
        tasks,
        members,
        filters: { q: "", assigneeBotId: "", role: "", status: "", type: "", priority: "", overdueOnly: false },
        jiraConfig: { enabled: true, baseUrl: "", email: "", hasApiToken: false, projectKey: "PROJ", issueType: "Task", statusMap: {}, autoSync: true },
        onChangeFilters: vi.fn(),
        onResetFilters: vi.fn(),
        onOpenNewTask: vi.fn(),
        onOpenJiraSettings: vi.fn(),
        onSelectTask: vi.fn(),
        onMoveTask: vi.fn(),
        onOpenThread: vi.fn(),
        boardError: null,
        onDismissError: vi.fn(),
      }),
    );
    for (const col of ["backlog", "todo", "in-progress", "blocked", "in-review", "done"]) {
      expect(boardHtml).toContain(`data-board-column="${col}"`);
    }
    expect(boardHtml).toContain("LOOMA-101");
    expect(boardHtml).toContain("PROJ-11");
    expect(boardHtml).toContain("Waiting on API contract");
  });
});

