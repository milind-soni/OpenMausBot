/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function fixture() {
  const t = convexTest(schema, modules);
  const sessionToken = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name: "Owner", email: "owner@estimate.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, userId);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Estimates" });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Estimates", githubRepo: "later" });
  const scope = { sessionToken, projectId };
  const columns = (await t.query(api.tasks.board, scope)).columns;
  const taskId = await t.mutation(api.tasks.createTask, { ...scope, columnId: columns[1]!._id, title: "Sized", priority: "medium" });
  const task = async () => (await t.query(api.tasks.details, { ...scope, taskId })).task;
  return { t, scope, columns, taskId, task };
}

describe("issue estimates", () => {
  test("an estimate is set on the Fibonacci scale and removed with null", async () => {
    const f = await fixture();
    expect((await f.task()).estimate).toBeUndefined();
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: f.taskId, estimate: 5 });
    expect((await f.task()).estimate).toBe(5);
    // Other edits leave it alone.
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: f.taskId, priority: "high" });
    expect((await f.task()).estimate).toBe(5);
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: f.taskId, estimate: null });
    expect((await f.task()).estimate).toBeUndefined();
  });

  test("values off the scale are refused", async () => {
    const f = await fixture();
    for (const estimate of [0, 4, 13, 2.5, -1]) await expect(f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: f.taskId, estimate })).rejects.toThrow("Choose an estimate");
  });
});

describe("Backlog draft column", () => {
  test("new boards call the draft column Backlog; other columns created by hand are never drafts", async () => {
    const f = await fixture();
    expect(f.columns[0]).toMatchObject({ title: "Backlog", isDraft: true });
    const backlog = await f.t.mutation(api.tasks.createColumn, { ...f.scope, title: "Backlog" });
    const board = await f.t.query(api.tasks.board, f.scope);
    // A second "Backlog" a team makes by hand is an ordinary column, flagged explicitly so a title can never flip it.
    expect(board.columns.find(column => column._id === backlog)).toMatchObject({ isDraft: false });
    expect(board.columns.filter(column => column.isDraft)).toHaveLength(1);
  });
});
