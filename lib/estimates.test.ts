import { expect, test } from "vitest";
import { estimateLabel, isEstimate, totalEstimate } from "./estimates";
import { readIssueView, sortIssues } from "./issue-view";

test("estimates are points on the Fibonacci scale and add up per lane", () => {
  expect([1, 2, 3, 5, 8].every(isEstimate)).toBe(true);
  expect([0, 4, 13, "3", null].some(isEstimate)).toBe(false);
  expect(estimateLabel(1)).toBe("1 point");
  expect(estimateLabel(5)).toBe("5 points");
  expect(totalEstimate([{ estimate: 3 }, {}, { estimate: 5 }, { estimate: 4 }])).toBe(8);
});

test("ordering by estimate puts the largest first and unestimated issues last", () => {
  const base = { priority: "medium" as const, createdAt: 1, updatedAt: 1 };
  const tasks = [{ ...base, _id: "a", title: "a", order: 0 }, { ...base, _id: "b", title: "b", order: 1, estimate: 2 }, { ...base, _id: "c", title: "c", order: 2, estimate: 8 }];
  expect(sortIssues(tasks, "estimate").map(task => task._id)).toEqual(["c", "b", "a"]);
});

test("a view saved before estimates existed shows them; a current view keeps its choice", () => {
  expect(readIssueView({ properties: ["id", "labels"] }).properties).toEqual(["id", "labels", "estimate"]);
  expect(readIssueView({ version: 2, properties: ["id", "labels"] }).properties).toEqual(["id", "labels"]);
});
