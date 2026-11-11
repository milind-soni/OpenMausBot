/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { isDraftColumn } from "./lib/columns";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

test("legacy imports add a first Draft while preserving imported active and completed task mappings", async () => {
  vi.stubEnv("ORIGIN_LEGACY_OWNER_EMAIL", "legacy-draft@example.test");
  vi.stubEnv("ORIGIN_LEGACY_WORKSPACE_SLUG", "legacy-draft-fixture");
  vi.resetModules();
  const t = convexTest(schema, modules);
  await t.run(ctx => ctx.db.insert("users", { name: "Fixture recovery owner", email: "legacy-draft@example.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 }));
  const teamId = await t.mutation(internal.legacyImport.prepareWorkspace, {});
  const input = {
    teamId, source: "draft-fixture", order: 0,
    project: { sourceId: "project", name: "Imported project", status: "active" as const, accent: "#123456", createdAt: 1, updatedAt: 1 },
    columns: [{ sourceId: "todo", title: "Todo", order: 0 }, { sourceId: "progress", title: "In progress", order: 1 }, { sourceId: "done", title: "Done", order: 2, isDone: true }],
    tasks: [
      { sourceId: "active", columnSourceId: "progress", title: "Imported active", priority: "medium" as const, done: false, order: 0, createdAt: 1, updatedAt: 1 },
      { sourceId: "complete", columnSourceId: "done", title: "Imported complete", priority: "low" as const, done: true, order: 1, createdAt: 1, updatedAt: 1 },
    ],
  };
  const first = await t.mutation(internal.legacyImport.importProject, input);
  expect(first).toMatchObject({ created: true, imported: 2, skipped: 0, total: 2 });
  const snapshot = () => t.run(async ctx => ({
    columns: await ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", first.projectId)).collect(),
    tasks: await ctx.db.query("tasks").withIndex("by_project", q => q.eq("projectId", first.projectId)).collect(),
  }));
  const before = await snapshot();
  expect(isDraftColumn(before.columns[0])).toBe(true);
  for (const task of before.tasks) {
    const column = before.columns.find(column => column._id === task.columnId)!;
    expect(isDraftColumn(column)).toBe(false);
    expect(column.title).toBe(task.done ? "Todo" : "In progress");
  }
  expect(await t.mutation(internal.legacyImport.importProject, input)).toMatchObject({ projectId: first.projectId, created: false, imported: 0, skipped: 2, total: 2 });
  expect(await snapshot()).toEqual(before);
});

test("repository imports persist semantic Draft and repair a matched old board without moving tasks", async () => {
  const t = convexTest(schema, modules);
  const sessionToken = await t.run(async ctx => {
    const { createSession } = await import("./lib/auth");
    const id = await ctx.db.insert("users", { name: "Fixture import owner", email: "repo-draft@example.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, id);
  });
  const args = { sessionToken, repos: [{ name: "Repo import", repoUrl: "https://github.com/fixture/draft-import" }] };
  const [first] = await t.mutation(api.projects.importRepos, args);
  const board = await t.query(api.tasks.board, { sessionToken, projectId: first.projectId });
  expect(board.columns[0]).toMatchObject({ title: "Backlog", isDraft: true });
  await t.run(async ctx => {
    await ctx.db.delete(board.columns[0]._id);
    await ctx.db.insert("tasks", { projectId: first.projectId, columnId: board.columns[1]._id, title: "Existing active", done: false, priority: "medium", order: 0, createdAt: 1, updatedAt: 1 });
  });
  const tasks = (await t.query(api.tasks.board, { sessionToken, projectId: first.projectId })).tasks;
  expect(await t.mutation(api.projects.importRepos, args)).toMatchObject([{ projectId: first.projectId, created: false }]);
  const repaired = await t.query(api.tasks.board, { sessionToken, projectId: first.projectId });
  expect(isDraftColumn(repaired.columns[0])).toBe(true);
  expect(repaired.tasks).toEqual(tasks);
});
