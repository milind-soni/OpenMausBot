/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const repoUrl = "https://github.com/test/drafts";

async function fixture() {
  const t = convexTest(schema, modules);
  const sessionToken = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name: "Owner", email: "drafts@test.dev", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, userId);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Drafts" });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Drafts", repoUrl });
  await t.run(ctx => ctx.db.patch(projectId, { githubWorkspaceAccess: true }));
  const { columns } = await t.query(api.tasks.board, { sessionToken, projectId });
  const create = (columnId: string, title: string) => t.mutation(api.tasks.createTask, { sessionToken, projectId, columnId: columnId as never, title, priority: "medium", assignedToEmail: "drafts@test.dev", dueDate: "2026-12-31" });
  return { t, sessionToken, projectId, columns, create };
}

const context = async (f: Awaited<ReturnType<typeof fixture>>, taskId: string) =>
  JSON.parse(await f.t.query(internal.integrations.context, { projectId: f.projectId, taskId: taskId as never })) as { task: { draft: boolean; done: boolean } };

describe("Draft column", () => {
  test("new boards start with a Draft column flagged as draft", async () => {
    const f = await fixture();
    expect(f.columns.map(column => column.title)).toEqual(["Draft", "Todo", "In progress"]);
    expect(f.columns[0].isDraft).toBe(true);
    expect(f.columns.slice(1).some(column => column.isDraft)).toBe(false);
  });

  test("the mirror tick skips draft issues and the context says which issues are drafts", async () => {
    const f = await fixture();
    const draft = await f.create(f.columns[0]._id, "Idea");
    const todo = await f.create(f.columns[1]._id, "Planned");
    const { rows } = JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null })) as { rows: { taskId: string }[] };
    expect(rows.map(row => row.taskId)).toEqual([todo]);
    expect((await context(f, draft)).task.draft).toBe(true);
    expect((await context(f, todo)).task.draft).toBe(false);
    await f.t.mutation(api.tasks.moveTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId: draft, columnId: f.columns[1]._id });
    const after = JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null })) as { rows: { taskId: string }[] };
    expect(after.rows.map(row => row.taskId).sort()).toEqual([draft, todo].sort());
  });

  test("a GitHub issue closed while its Origin issue is in Draft does not complete it, but one closed after it leaves Draft does", async () => {
    const f = await fixture();
    const taskId = await f.create(f.columns[0]._id, "Parked");
    const link = (state: "open" | "closed", updatedAt: number) => f.t.mutation(internal.integrations.linkIssue, { projectId: f.projectId, taskId, repoUrl, number: 7, issueUrl: `${repoUrl}/issues/7`, state, updatedAt });
    await link("open", 1000);
    await link("closed", 2000);
    expect((await context(f, taskId)).task.done).toBe(false);
    await f.t.mutation(api.tasks.moveTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId, columnId: f.columns[1]._id });
    await link("open", 3000);
    expect((await context(f, taskId)).task.done).toBe(false);
    await link("closed", 4000);
    expect((await context(f, taskId)).task.done).toBe(true);
  });

  test("an issue moved back to Draft forgets its removed GitHub issue and gets a new one when it leaves", async () => {
    const f = await fixture();
    const taskId = await f.create(f.columns[1]._id, "Planned");
    await f.t.mutation(internal.integrations.linkIssue, { projectId: f.projectId, taskId, repoUrl, number: 7, issueUrl: `${repoUrl}/issues/7`, state: "open", updatedAt: 1000 });
    await f.t.mutation(internal.integrations.unlinkIssue, { projectId: f.projectId, taskId, number: 8 });
    expect(JSON.parse(await f.t.query(internal.integrations.context, { projectId: f.projectId, taskId })).task.githubIssueNumber).toBe(7);
    await f.t.mutation(internal.integrations.unlinkIssue, { projectId: f.projectId, taskId, number: 7 });
    const task = JSON.parse(await f.t.query(internal.integrations.context, { projectId: f.projectId, taskId })).task as Record<string, unknown>;
    expect(task.githubIssueNumber).toBeUndefined();
    expect(task.githubIssueUrl).toBeUndefined();
    const { rows } = JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null })) as { rows: { taskId: string }[] };
    expect(rows.map(row => row.taskId)).toEqual([taskId]);
  });

  test("the legacy GitHub issue action keeps Draft issues private", async () => {
    const f = await fixture();
    const taskId = await f.create(f.columns[0]._id, "Confidential draft");
    await expect(f.t.action(api.github.createIssueForTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId }))
      .rejects.toThrow("Draft");
  });

  test("legacy repository snapshots do not complete parked Draft issues", async () => {
    const f = await fixture();
    const taskId = await f.create(f.columns[0]._id, "Parked");
    await f.t.mutation(internal.integrations.linkIssue, { projectId: f.projectId, taskId, repoUrl, number: 7, issueUrl: `${repoUrl}/issues/7`, state: "open", updatedAt: 1000 });
    const snapshot = () => f.t.mutation(internal.github.upsertRepoSnapshot, {
      sessionToken: f.sessionToken, projectId: f.projectId, repoUrl,
      issues: [{ number: 7, title: "Parked", state: "closed", url: `${repoUrl}/issues/7`, updatedAt: 2000 }], pullRequests: [],
    });
    await snapshot();
    expect((await context(f, taskId)).task.done).toBe(false);
    await f.t.mutation(api.tasks.moveTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId, columnId: f.columns[1]._id });
    await snapshot();
    expect((await context(f, taskId)).task.done).toBe(false);
    await f.t.mutation(internal.integrations.completeMergedIssue, { projectId: f.projectId, taskId, repoUrl, issueNumber: 7, pullRequest: { number: 9, headSha: "a".repeat(40), mergeSha: "b".repeat(40), mergedAt: 3000 } });
    expect((await context(f, taskId)).task.done).toBe(true);
  });

  test("renaming a column to Draft flags it, and the flag survives a later rename", async () => {
    const f = await fixture();
    const todo = f.columns[1]._id;
    await f.t.mutation(api.tasks.updateColumn, { sessionToken: f.sessionToken, projectId: f.projectId, columnId: todo, title: "draft" });
    await f.t.mutation(api.tasks.updateColumn, { sessionToken: f.sessionToken, projectId: f.projectId, columnId: todo, title: "Ideas" });
    const { columns } = await f.t.query(api.tasks.board, { sessionToken: f.sessionToken, projectId: f.projectId });
    expect(columns.find(column => column._id === todo)).toMatchObject({ title: "Ideas", isDraft: true });
  });

  test("newly created Draft columns stay private after a rename", async () => {
    const f = await fixture();
    const columnId = await f.t.mutation(api.tasks.createColumn, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Draft" });
    const taskId = await f.create(columnId, "Unannounced idea");
    await f.t.mutation(api.tasks.updateColumn, { sessionToken: f.sessionToken, projectId: f.projectId, columnId, title: "Ideas" });

    expect((await context(f, taskId)).task.draft).toBe(true);
    const { rows } = JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null })) as { rows: { taskId: string }[] };
    expect(rows.map(row => row.taskId)).not.toContain(taskId);
  });

  test("renaming a legacy unflagged Draft column keeps its issues private", async () => {
    const f = await fixture();
    const columnId = f.columns[0]._id;
    await f.t.run(ctx => ctx.db.patch(columnId, { isDraft: undefined }));
    const taskId = await f.create(columnId, "Existing private idea");
    await f.t.mutation(api.tasks.updateColumn, { sessionToken: f.sessionToken, projectId: f.projectId, columnId, title: "Ideas" });
    expect((await context(f, taskId)).task.draft).toBe(true);
  });
});
