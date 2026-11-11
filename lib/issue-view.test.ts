import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW, NO_LABEL, UNASSIGNED, activeFilterCount, groupIssues, matchesFilters, readIssueView, sortIssues, toggleFilter, type ViewTask } from "./issue-view";

const task = (id: string, extra: Partial<ViewTask & { status: string }> = {}): ViewTask & { status: string } => ({ _id: id, title: id, priority: "medium", createdAt: 1, updatedAt: 1, order: 0, status: "todo", ...extra });
const tasks = [
  task("a", { priority: "high", labels: ["Bug"], assignedToEmail: "ada@x.test", status: "todo", order: 2, dueDate: "2026-11-20" }),
  task("b", { priority: "low", labels: ["Feature", "bug"], status: "doing", order: 1, createdAt: 5 }),
  task("c", { priority: "medium", status: "todo", order: 0, title: "Alpha", dueDate: "2026-11-12" }),
];
const statusOf = (item: ViewTask) => (item as ViewTask & { status: string }).status;

describe("issue filters", () => {
  it("filters by label case-insensitively, including issues without labels", () => {
    const only = (labels: string[]) => tasks.filter(item => matchesFilters(item, { ...DEFAULT_VIEW.filters, labels }, statusOf(item))).map(item => item._id);
    expect(only(["bug"])).toEqual(["a", "b"]);
    expect(only(["feature"])).toEqual(["b"]);
    expect(only([NO_LABEL])).toEqual(["c"]);
    expect(only(["feature", NO_LABEL])).toEqual(["b", "c"]);
  });
  it("combines status, priority and assignee filters", () => {
    const filters = { ...DEFAULT_VIEW.filters, statuses: ["todo"], priorities: ["high" as const, "medium" as const], assignees: [UNASSIGNED] };
    expect(tasks.filter(item => matchesFilters(item, filters, statusOf(item))).map(item => item._id)).toEqual(["c"]);
    expect(activeFilterCount(filters)).toBe(4);
  });
  it("toggles filter values", () => {
    const on = toggleFilter(DEFAULT_VIEW.filters, "labels", "bug");
    expect(on.labels).toEqual(["bug"]);
    expect(toggleFilter(on, "labels", "bug").labels).toEqual([]);
  });
});

describe("issue ordering and grouping", () => {
  it("orders by priority, due date, created and title with manual order for ties", () => {
    expect(sortIssues(tasks, "manual").map(item => item._id)).toEqual(["c", "b", "a"]);
    expect(sortIssues(tasks, "priority").map(item => item._id)).toEqual(["a", "c", "b"]);
    expect(sortIssues(tasks, "dueDate").map(item => item._id)).toEqual(["c", "a", "b"]);
    expect(sortIssues(tasks, "created").map(item => item._id)[0]).toBe("b");
    expect(sortIssues(tasks, "title").map(item => item._id)).toEqual(["a", "c", "b"]);
  });
  it("groups by status in lane order and hides empty groups unless asked", () => {
    const context = { statuses: [{ id: "todo", title: "Todo" }, { id: "doing", title: "In Progress" }, { id: "review", title: "Review" }], statusOf, people: [], labels: [] };
    expect(groupIssues(tasks, "status", context, false).map(group => [group.title, group.tasks.length])).toEqual([["Todo", 2], ["In Progress", 1]]);
    expect(groupIssues(tasks, "status", context, true).map(group => group.title)).toEqual(["Todo", "In Progress", "Review"]);
  });
  it("lists an issue under each of its labels and keeps unlabeled issues last", () => {
    const groups = groupIssues(tasks, "label", { statuses: [], statusOf, people: [], labels: ["Bug", "Feature", "Improvement"] }, false);
    expect(groups.map(group => [group.title, group.tasks.map(item => item._id)])).toEqual([["Bug", ["a", "b"]], ["Feature", ["b"]], ["No labels", ["c"]]]);
  });
  it("groups by assignee with unassigned last", () => {
    const groups = groupIssues(tasks, "assignee", { statuses: [], statusOf, people: [{ email: "ada@x.test", name: "Ada" }], labels: [] }, false);
    expect(groups.map(group => group.title)).toEqual(["Ada", "No assignee"]);
  });
});

describe("stored view state", () => {
  it("falls back to defaults for anything malformed and keeps the old layout preference", () => {
    expect(readIssueView(null)).toEqual(DEFAULT_VIEW);
    expect(readIssueView(null, "list").layout).toBe("list");
    const view = readIssueView({ layout: "list", grouping: "nope", ordering: "priority", properties: ["id", "bogus"], filters: { labels: ["Bug", 3], priorities: ["urgent", "high"] } });
    expect(view).toMatchObject({ layout: "list", grouping: "status", ordering: "priority", properties: ["id"], filters: { labels: ["bug"], priorities: ["high"] } });
  });
});
