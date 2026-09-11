import { describe, expect, it } from "vitest";

import { t } from "@/lib/i18n";
import {
  TASK_PICKER_DISMISS_MS,
  filterTasks,
  groupThreadTasks,
  taskPickerPointerIntent,
} from "./TaskPicker";

describe("taskPickerPointerIntent", () => {
  it("treats a single click as switch, not rename", () => {
    expect(taskPickerPointerIntent("click", 1)).toBe("select");
    expect(taskPickerPointerIntent("click")).toBe("select");
  });

  it("does not let the click that accompanies a double-click close the row", () => {
    // HTML fires click (detail=1), click (detail=2), then dblclick. Closing
    // on the first of those unmounts the menu before rename can start.
    expect(taskPickerPointerIntent("click", 2)).toBe("ignore");
    expect(taskPickerPointerIntent("dblclick", 2)).toBe("rename");
  });

  it("starts a rename from right-click", () => {
    expect(taskPickerPointerIntent("contextmenu")).toBe("rename");
  });

  it("ignores unrelated events", () => {
    expect(taskPickerPointerIntent("mousedown")).toBe("ignore");
  });
});

describe("project thread grouping", () => {
  const projects = [{ id: "work", name: "Research" }, { id: "personal", name: "Home" }];
  const tasks = [
    { threadId: "1", title: "Draft report", createdAt: 4, projectId: "work" },
    { threadId: "2", title: "Plan trip", createdAt: 3, projectId: "personal" },
    { threadId: "3", title: "Report sources", createdAt: 2, projectId: "work" },
    { threadId: "4", title: "Quick question", createdAt: 1 },
    { threadId: "5", title: "Old project thread", createdAt: 0, projectId: "deleted" },
  ];
  it("groups existing folders and keeps legacy/orphaned threads under No folder", () => {
    expect(groupThreadTasks(tasks, projects, "").map((group) => [group.project.name, group.tasks.map((task) => task.threadId)]))
      .toEqual([["Research", ["1", "3"]], ["Home", ["2"]], ["No folder", ["4", "5"]]]);
  });
  it("searches project names as well as thread titles without hiding matching older threads", () => {
    expect(groupThreadTasks(tasks, projects, "RESEARCH").flatMap((group) => group.tasks.map((task) => task.threadId))).toEqual(["1", "3"]);
    expect(groupThreadTasks(tasks, projects, "report").flatMap((group) => group.tasks.map((task) => task.threadId))).toEqual(["3", "1"]);
    expect(groupThreadTasks(tasks, projects, "missing")).toEqual([]);
  });
  it("retains persisted folder order and icons without changing thread membership", () => {
    const reversed = [{ ...projects[1]!, emoji: "🏠" }, projects[0]!];
    const grouped = groupThreadTasks(tasks, reversed, "");
    expect(grouped.map((group) => group.project.id)).toEqual(["personal", "work", ""]);
    expect(grouped[0]?.project.emoji).toBe("🏠");
    expect(grouped[0]?.tasks.map((task) => task.threadId)).toEqual(["2"]);
  });
});

describe("task picker copy", () => {
  it("advertises both gestures the row actually handles", () => {
    // the hint moved into the catalog with the rest of the picker's copy
    expect(t("task.renameHint")).toContain("double-click");
    expect(t("task.renameHint")).toContain("right-click");
    expect(TASK_PICKER_DISMISS_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("filterTasks", () => {
  const tasks = [
    { title: "Clean up" },
    { title: "OpenMausBot Update" },
    { title: "Investment report" },
    { title: "Report drafts" },
  ];

  it("returns the original order when the query is empty", () => {
    expect(filterTasks(tasks, "").map((task) => task.title)).toEqual(tasks.map((task) => task.title));
    expect(filterTasks(tasks, "   ").map((task) => task.title)).toEqual(tasks.map((task) => task.title));
  });

  it("matches titles case-insensitively", () => {
    expect(filterTasks(tasks, "openmaus").map((task) => task.title)).toEqual(["OpenMausBot Update"]);
  });

  it("ranks prefix hits ahead of substring hits, keeping input order in each tier", () => {
    expect(filterTasks(tasks, "report").map((task) => task.title)).toEqual([
      "Report drafts",
      "Investment report",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterTasks(tasks, "zzzz")).toEqual([]);
  });
});
