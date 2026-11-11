/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import { cleanLabels, colorForLabel, labelKey, missingDefaultLabels } from "./lib/labels";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function fixture() {
  const t = convexTest(schema, modules);
  const sessionToken = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name: "Owner", email: "owner@labels.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, userId);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Labels" });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Labels", githubRepo: "later" });
  const columnId = (await t.query(api.tasks.board, { sessionToken, projectId })).columns[1]!._id;
  const issue = (title: string) => t.mutation(api.tasks.createTask, { sessionToken, projectId, columnId, title, priority: "medium" });
  const stored = () => t.run(ctx => ctx.db.query("issueLabels").withIndex("by_teamId_and_key", q => q.eq("teamId", teamId)).collect());
  return { t, sessionToken, teamId, projectId, issue, stored };
}

describe("label helpers", () => {
  test("cleaning trims, dedupes case-insensitively and prefers the known spelling", () => {
    expect(cleanLabels([" bug ", "Bug", "front  end"], ["Bug"])).toEqual(["Bug", "front end"]);
    expect(() => cleanLabels(["x".repeat(33)])).toThrow();
  });
  test("defaults are only missing when no label of that name exists, in any case", () => {
    expect(missingDefaultLabels([]).map(label => label.name)).toEqual(["Feature", "Bug", "Improvement", "Needs spec"]);
    expect(missingDefaultLabels(["bug", "FEATURE", "needs SPEC"]).map(label => label.name)).toEqual(["Improvement"]);
    expect(colorForLabel("bug")).toBe("#eb5757");
    expect(colorForLabel("Backend")).toBe(colorForLabel("backend"));
    expect(labelKey("  Front   End ")).toBe("front end");
  });
});

describe("workspace label registry", () => {
  test("lists Feature, Bug, Improvement and Needs spec before anything is stored", async () => {
    const f = await fixture();
    const { labels } = await f.t.query(api.labels.list, { sessionToken: f.sessionToken, teamId: f.teamId });
    expect(labels.map(label => [label.name, label.color, label._id])).toEqual([["Bug", "#eb5757", null], ["Feature", "#bb87fc", null], ["Improvement", "#4ea7fc", null], ["Needs spec", "#d4a72c", null]]);
    expect(labels.find(label => label.name === "Needs spec")?.description).toContain("acceptance criteria");
  });

  test("seeding defaults is idempotent and respects existing labels in any case", async () => {
    const f = await fixture();
    await f.t.mutation(api.labels.create, { sessionToken: f.sessionToken, teamId: f.teamId, name: "bug", color: "#4cb782" });
    expect(await f.t.mutation(api.labels.ensureDefaults, { sessionToken: f.sessionToken, teamId: f.teamId })).toBe(3);
    expect(await f.t.mutation(api.labels.ensureDefaults, { sessionToken: f.sessionToken, teamId: f.teamId })).toBe(0);
    await f.t.mutation(internal.labels.backfillDefaults, {});
    const rows = await f.stored();
    expect(rows.map(row => row.name).sort()).toEqual(["Feature", "Improvement", "Needs spec", "bug"]);
    expect(rows.find(row => row.key === "bug")?.color).toBe("#4cb782");
  });

  test("creating a duplicate name is refused; an archived one is restored", async () => {
    const f = await fixture();
    const id = await f.t.mutation(api.labels.create, { sessionToken: f.sessionToken, teamId: f.teamId, name: "Design", color: "#26b5ce" });
    await expect(f.t.mutation(api.labels.create, { sessionToken: f.sessionToken, teamId: f.teamId, name: "design" })).rejects.toThrow("already exists");
    await f.t.mutation(api.labels.update, { sessionToken: f.sessionToken, teamId: f.teamId, labelId: id, currentName: "Design", archived: true });
    expect(await f.t.mutation(api.labels.create, { sessionToken: f.sessionToken, teamId: f.teamId, name: "DESIGN", color: "#f2c94c" })).toBe(id);
    expect((await f.stored()).find(row => row._id === id)).toMatchObject({ name: "DESIGN", color: "#f2c94c", archived: false });
    await expect(f.t.mutation(api.labels.create, { sessionToken: f.sessionToken, teamId: f.teamId, name: "Bad", color: "red" })).rejects.toThrow("Choose a label color");
  });

  test("applying labels writes canonical names on the issue and registers new ones", async () => {
    const f = await fixture();
    const taskId = await f.issue("Crash on save");
    await f.t.mutation(api.issueRelations.labels, { sessionToken: f.sessionToken, taskId, labels: ["bug", "Backend"] });
    expect((await f.t.query(api.issueRelations.list, { sessionToken: f.sessionToken, taskId })).labels).toEqual(["bug", "Backend"]);
    // The registry now has both names, so a later spelling follows it.
    const other = await f.issue("Another crash");
    await f.t.mutation(api.issueRelations.labels, { sessionToken: f.sessionToken, taskId: other, labels: ["BACKEND"] });
    expect((await f.t.query(api.issueRelations.list, { sessionToken: f.sessionToken, taskId: other })).labels).toEqual(["Backend"]);
    expect((await f.stored()).map(row => row.name).sort()).toEqual(["Backend", "bug"]);
    const usage = await f.t.query(api.labels.usage, { sessionToken: f.sessionToken, teamId: f.teamId });
    expect(Object.fromEntries(usage.map(row => [row.key, row.count]))).toEqual({ bug: 1, backend: 2 });
  });

  test("renaming a label renames it on every issue", async () => {
    const f = await fixture();
    const taskId = await f.issue("Polish");
    await f.t.mutation(api.issueRelations.labels, { sessionToken: f.sessionToken, taskId, labels: ["Improvement", "ui"] });
    await f.t.mutation(api.labels.update, { sessionToken: f.sessionToken, teamId: f.teamId, labelId: null, currentName: "ui", name: "Design", color: "#26b5ce" });
    expect((await f.t.query(api.issueRelations.list, { sessionToken: f.sessionToken, taskId })).labels).toEqual(["Improvement", "Design"]);
    const { labels } = await f.t.query(api.labels.list, { sessionToken: f.sessionToken, teamId: f.teamId, projectId: f.projectId });
    expect(labels.find(label => label.name === "Design")).toMatchObject({ color: "#26b5ce" });
    expect(labels.some(label => label.name === "ui")).toBe(false);
  });

  test("groups hold labels and archiving a group ungroups them", async () => {
    const f = await fixture();
    const groupId = await f.t.mutation(api.labels.createGroup, { sessionToken: f.sessionToken, teamId: f.teamId, name: "Area" });
    const labelId = await f.t.mutation(api.labels.create, { sessionToken: f.sessionToken, teamId: f.teamId, name: "Frontend", groupId });
    expect((await f.t.query(api.labels.list, { sessionToken: f.sessionToken, teamId: f.teamId })).groups).toEqual([{ _id: groupId, name: "Area" }]);
    await f.t.mutation(api.labels.updateGroup, { sessionToken: f.sessionToken, teamId: f.teamId, groupId, archived: true });
    expect((await f.stored()).find(row => row._id === labelId)?.groupId).toBeUndefined();
  });
});

describe("issue routes", () => {
  test("a key resolves to its issue, an exact id wins, and collisions are reported", async () => {
    const f = await fixture();
    const taskId = await f.issue("Routed");
    const key = `ORI-${taskId.slice(-4).toUpperCase()}`;
    expect(await f.t.query(api.issueRoutes.resolve, { sessionToken: f.sessionToken, teamId: f.teamId, key })).toEqual({ status: "found", projectId: f.projectId, taskId });
    expect(await f.t.query(api.issueRoutes.resolve, { sessionToken: f.sessionToken, teamId: f.teamId, key: "ORI-ZZZZ", taskId })).toEqual({ status: "found", projectId: f.projectId, taskId });
    expect(await f.t.query(api.issueRoutes.resolve, { sessionToken: f.sessionToken, teamId: f.teamId, key: "ORI-ZZZZ" })).toEqual({ status: "missing" });
    expect(await f.t.query(api.issueRoutes.resolve, { sessionToken: f.sessionToken, teamId: f.teamId, key, taskId: "not-an-id" })).toEqual({ status: "found", projectId: f.projectId, taskId });
    // Keys are four id characters, so issues collide; a key-only link then lists every match.
    const ids = [taskId];
    while (ids.filter(id => id.slice(-4) === taskId.slice(-4)).length < 2 && ids.length < 400) ids.push(await f.issue(`Issue ${ids.length}`));
    const twins = ids.filter(id => id.slice(-4) === taskId.slice(-4));
    if (twins.length < 2) return;
    const result = await f.t.query(api.issueRoutes.resolve, { sessionToken: f.sessionToken, teamId: f.teamId, key });
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.matches.map(match => match.taskId).sort()).toEqual([...twins].sort());
    expect(await f.t.query(api.issueRoutes.resolve, { sessionToken: f.sessionToken, teamId: f.teamId, key, taskId: twins[1] })).toEqual({ status: "found", projectId: f.projectId, taskId: twins[1] });
  });

  test("sub-issues are created in the parent's project and listed under it", async () => {
    const f = await fixture();
    const parent = await f.issue("Parent");
    const child = await f.t.mutation(api.issueRoutes.createSubIssue, { sessionToken: f.sessionToken, parentTaskId: parent, title: "Child" });
    const rows = await f.t.query(api.issueRoutes.subIssues, { sessionToken: f.sessionToken, taskId: parent });
    expect(rows.map(row => [row._id, row.title, row.done])).toEqual([[child, "Child", false]]);
    expect(await f.t.query(api.issueRoutes.projectParents, { sessionToken: f.sessionToken, projectId: f.projectId })).toEqual([{ taskId: child, parentId: parent }]);
  });
});
