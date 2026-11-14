import { describe, expect, it } from "vitest";

import type { BoardSnapshot, BoardTask } from "../../shared/board";
import {
  boardTree, canEditMilestone, canEditProject, canEditTask, childTasks, filterBoard, milestoneCounts,
  phaseDistribution, taskCounts, taskFits, taskMatches, unclassifiedConversations, projectOfTask, EMPTY_FILTER,
  type TaskMatchContext,
} from "./project-board";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 9, minute)).toISOString();

function task(overrides: Partial<BoardTask> & Pick<BoardTask, "threadId">): BoardTask {
  return {
    botId: "bot-1",
    phase: "build",
    status: "in_progress",
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

const board: BoardSnapshot = {
  version: 3,
  projects: [
    { id: "p1", name: "Creative board", createdAt: at(0), updatedAt: at(0) },
    { id: "p2", name: "Website", createdAt: at(1), updatedAt: at(1) },
  ],
  subprojects: [
    { id: "sp1", projectId: "p1", name: "Tax", createdAt: at(0), updatedAt: at(0) },
    { id: "sp2", projectId: "p1", name: "Summon", createdAt: at(0), updatedAt: at(0) },
  ],
  milestones: [
    { id: "m1", projectId: "p1", subprojectId: "sp1", title: "Front-end ready", status: "in_progress", createdAt: at(0), updatedAt: at(0) },
    { id: "m2", projectId: "p1", subprojectId: "sp2", title: "Live", status: "accepted", verdict: "Checked", evidence: "https://example.test", createdAt: at(0), updatedAt: at(0) },
    { id: "m3", projectId: "p1", title: "Project gate", status: "planned", createdAt: at(0), updatedAt: at(0) },
  ],
  tasks: [
    task({ threadId: "main", projectId: "p1", subprojectId: "sp1", owner: "Pixel", acceptance: "Cards render", updatedAt: at(5) }),
    task({ threadId: "child-a", projectId: "p1", subprojectId: "sp1", parentThreadId: "main", status: "done", owner: "Lin", updatedAt: at(6) }),
    task({ threadId: "child-b", projectId: "p1", subprojectId: "sp1", parentThreadId: "main", status: "review", updatedAt: at(7) }),
    task({ threadId: "second", projectId: "p1", subprojectId: "sp2", status: "todo", updatedAt: at(2) }),
    task({ threadId: "web", projectId: "p2", phase: "design", status: "todo", updatedAt: at(1) }),
    task({ threadId: "waiting", status: "todo", updatedAt: at(3) }),
    task({ threadId: "ghost", projectId: "p-missing", updatedAt: at(4) }),
  ],
  capabilities: { manage: true },
  updatedAt: at(9),
};

const context = (value: BoardTask): TaskMatchContext => ({
  title: value.threadId === "main" ? "Tax card front end" : value.threadId,
  botName: value.botId,
  projectName: "",
  subprojectName: "",
});

describe("the board tree", () => {
  it("puts subprojects and tasks under their project and keeps the unplaceable ones", () => {
    const tree = boardTree(board);
    expect(tree.projects.map((node) => node.project.id)).toEqual(["p1", "p2"]);
    const creative = tree.projects[0]!;
    expect(creative.subprojects.map((node) => node.subproject.name)).toEqual(["Summon", "Tax"]);
    expect(creative.subprojects[1]!.tasks.map((value) => value.threadId)).toEqual(["main"]);
    expect(creative.milestones.map((milestone) => milestone.id)).toEqual(["m3"]);
    expect(tree.unclassified.map((value) => value.threadId)).toEqual(["waiting"]);
    expect(tree.loose.map((value) => value.threadId)).toEqual(["ghost"]);
  });

  it("orders children newest first and knows a top-level task from a child", () => {
    expect(childTasks(board.tasks[0]!, board.tasks).map((value) => value.threadId)).toEqual(["child-b", "child-a"]);
    expect(childTasks(board.tasks[1]!, board.tasks)).toEqual([]);
  });

  it("counts main tasks once and their children separately", () => {
    const counts = taskCounts(board.tasks.filter((value) => value.projectId === "p1"));
    expect(counts).toEqual({ main: 2, mainDone: 0, subtasks: 2, subtasksAccepted: 1 });
    expect(taskCounts(board.tasks.filter((value) => value.projectId === "p2"))).toEqual({ main: 1, mainDone: 0, subtasks: 0, subtasksAccepted: 0 });
  });
});

describe("counts shown beside a project", () => {
  it("counts milestones by acceptance", () => {
    expect(milestoneCounts(board.milestones)).toEqual({ accepted: 1, total: 3 });
  });

  it("spreads top-level task phases without counting subtasks twice", () => {
    expect(phaseDistribution(board.tasks.filter((value) => value.projectId === "p1"))).toEqual([
      { phase: "build", count: 2 },
    ]);
  });
});

describe("filters", () => {
  it("keeps a matching child's project, subproject and parent row", () => {
    const tree = boardTree(board);
    const filtered = filterBoard(tree, { ...EMPTY_FILTER, query: "child-b" }, context);
    expect(filtered.projects).toHaveLength(1);
    expect(filtered.projects[0]!.subprojects[0]!.tasks.map((value) => value.threadId)).toEqual(["main"]);
    expect([...filtered.visible].sort()).toEqual(["child-b", "main"]);
    expect(filtered.shown).toBe(1);
  });

  it("matches a conversation's title from the bot snapshot", () => {
    const filtered = filterBoard(boardTree(board), { ...EMPTY_FILTER, query: "tax card" }, context);
    expect(filtered.projects[0]!.subprojects[0]!.tasks.map((value) => value.threadId)).toEqual(["main"]);
  });

  it("applies status and owner alongside the text", () => {
    expect(taskFits(board.tasks[0]!, { ...EMPTY_FILTER, status: "review" })).toBe(false);
    expect(taskFits(board.tasks[2]!, { ...EMPTY_FILTER, owner: "pixel" })).toBe(false);
    expect(taskMatches(board.tasks[0]!, { ...EMPTY_FILTER, owner: "Pixel" }, context(board.tasks[0]!))).toBe(true);
    const filtered = filterBoard(boardTree(board), { ...EMPTY_FILTER, query: "Creative board", status: "review" }, context);
    expect([...filtered.visible].sort()).toEqual(["child-b", "main"]);
    expect(filtered.shown).toBe(1);
  });

  it("shows nothing when a status matches no task and reports it", () => {
    const filtered = filterBoard(boardTree(board), { ...EMPTY_FILTER, status: "review", query: "nothing here" }, context);
    expect(filtered.projects).toEqual([]);
    expect(filtered.shown).toBe(0);
  });

  it("marks blocked and paused tasks only when asked", () => {
    const blocked = task({ threadId: "stuck", projectId: "p1", subprojectId: "sp1", blocked: true });
    const paused = task({ threadId: "holding", projectId: "p1", subprojectId: "sp1", paused: true });
    const tree = boardTree({ ...board, tasks: [...board.tasks, blocked, paused] });
    expect(filterBoard(tree, { ...EMPTY_FILTER, flag: "blocked" }, context).shown).toBe(1);
    expect(filterBoard(tree, { ...EMPTY_FILTER, flag: "paused" }, context).shown).toBe(1);
    expect(filterBoard(tree, { ...EMPTY_FILTER, flag: "review" }, context).shown).toBe(1);
  });
});

describe("waiting to be classified", () => {
  it("lists every conversation without a board row, newest first, and skips hidden bots", () => {
    const bots = [
      { id: "bot-1", name: "Pixel", tasks: [
        { threadId: "main", title: "Already on the board" },
        { threadId: "fresh", title: "Fresh", updatedAt: 10 },
        { threadId: "older", title: "Older", updatedAt: 2 },
      ] },
      { id: "bot-2", name: "Hidden", hidden: true, tasks: [{ threadId: "hidden", title: "Hidden", updatedAt: 99 }] },
    ];
    expect(unclassifiedConversations(bots, board).map((value) => value.threadId)).toEqual(["fresh", "older"]);
  });

  it("names the project and subproject of a task", () => {
    expect(projectOfTask(board, board.tasks[0]!)).toEqual({ projectName: "Creative board", subprojectName: "Tax" });
    expect(projectOfTask(board, board.tasks[5]!)).toBeNull();
  });
});

describe("what a member may change", () => {
  const member: BoardSnapshot = {
    ...board,
    capabilities: { manage: false },
    permissions: { projects: { p1: true, p2: false }, tasks: { main: false, second: true }, milestones: { m1: true, m2: false, m3: false } },
  };

  it("trusts the server's per-object permissions, not only the admin flag", () => {
    expect(canEditProject(member, "p1")).toBe(true);
    expect(canEditProject(member, "p2")).toBe(false);
    expect(canEditTask(member, "second")).toBe(true);
    expect(canEditTask(member, "main")).toBe(false);
    expect(canEditMilestone(member, "m1")).toBe(true);
    expect(canEditMilestone(member, "m3")).toBe(false);
  });

  it("gives an admin every object even when no permission map is sent", () => {
    expect(canEditProject(board, "p2")).toBe(true);
    expect(canEditTask(board, "anything")).toBe(true);
  });
});

describe("unclassified conversations", () => {
  it("leaves routine runs out: a schedule is not work waiting for a project", () => {
    const bots = [{ id: "bot-1", name: "MausBot", tasks: [
      { threadId: "waiting-2", title: "Waiting", updatedAt: 3 },
      { threadId: "run", title: "Nightly check", updatedAt: 4, routineRunId: "run-1" },
    ] }];
    expect(unclassifiedConversations(bots, board).map((ref) => ref.threadId)).toEqual(["waiting-2"]);
  });
});
