/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import { isDraftColumn } from "./lib/columns";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const email = "draft-defaults@example.test";

async function fixture() {
  const t = convexTest(schema, modules);
  const sessionToken = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { name: "Fixture owner", email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, id);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Draft fixture" });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Draft fixture", repoUrl: "https://github.com/fixture/draft-defaults" });
  const board = () => t.query(api.tasks.board, { sessionToken, projectId });
  const columns = (await board()).columns;
  const create = (title: string, columnId?: Id<"columns">) => t.mutation(api.tasks.createTask, { sessionToken, projectId, ...(columnId ? { columnId } : {}), title, priority: "medium", assignedToEmail: email, dueDate: "2027-01-01" });
  const ensure = () => t.mutation(api.tasks.ensureDefaultColumns, { sessionToken, projectId });
  return { t, sessionToken, teamId, projectId, columns, board, create, ensure };
}

describe("Draft defaults at the task and workflow boundary", () => {
  test("an omitted task column defaults to Draft and stays out of GitHub discovery", async () => {
    const f = await fixture();
    const taskId = await f.create("Private new idea");
    const task = await f.t.run(ctx => ctx.db.get(taskId));
    expect(task?.columnId).toBe(f.columns[0]._id);
    expect(task?.done).toBe(false);
    const targets = JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null }));
    expect(targets.rows.map((row: { taskId: string }) => row.taskId)).not.toContain(taskId);
  });

  test("an explicit valid active column remains authoritative", async () => {
    const f = await fixture();
    const taskId = await f.create("Explicitly planned", f.columns[1]._id);
    expect((await f.t.run(ctx => ctx.db.get(taskId)))?.columnId).toBe(f.columns[1]._id);
  });

  test("a legacy semantic Draft cannot complete a newly created task even with a stale Done flag", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.columns[0]._id, { title: "Done", isDone: true }));
    const taskId = await f.create("Explicit private draft", f.columns[0]._id);
    expect(await f.t.run(ctx => ctx.db.get(taskId))).toMatchObject({ columnId: f.columns[0]._id, done: false });
  });

  test("repair adds Draft to a nonempty legacy board without moving its tasks", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.delete(f.columns[0]._id));
    const taskId = await f.create("Existing planned task", f.columns[1]._id);
    await f.ensure();
    const board = await f.board();
    expect(isDraftColumn(board.columns[0])).toBe(true);
    expect(board.tasks.find(task => task._id === taskId)?.columnId).toBe(f.columns[1]._id);
    const firstIds = board.columns.map(column => column._id);
    await f.ensure();
    expect((await f.board()).columns.map(column => column._id)).toEqual(firstIds);
  });

  test("a renamed semantic Draft is displayed first and remains the task default", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.columns[0]._id, { title: "Private ideas", order: 99 }));
    expect((await f.board()).columns[0]).toMatchObject({ _id: f.columns[0]._id, title: "Private ideas" });
    await f.ensure();
    const taskId = await f.create("Still private");
    const board = await f.board();
    expect(board.columns.filter(isDraftColumn)).toHaveLength(1);
    expect(board.columns[0]).toMatchObject({ _id: f.columns[0]._id, title: "Private ideas" });
    expect(board.tasks.find(task => task._id === taskId)?.columnId).toBe(f.columns[0]._id);
  });

  test("deleting the last Draft preserves its requested task destination and adds an empty Draft", async () => {
    const f = await fixture();
    const taskId = await f.create("Move only when explicitly requested", f.columns[0]._id);
    await f.t.mutation(api.tasks.deleteColumn, { sessionToken: f.sessionToken, projectId: f.projectId, columnId: f.columns[0]._id, moveToColumnId: f.columns[1]._id });
    const board = await f.board();
    expect(isDraftColumn(board.columns[0])).toBe(true);
    expect(board.columns[0]._id).not.toBe(f.columns[0]._id);
    expect(board.tasks.find(task => task._id === taskId)?.columnId).toBe(f.columns[1]._id);
    expect(board.tasks.filter(task => task.columnId === board.columns[0]._id)).toEqual([]);
  });

  test("creating Draft on an old board puts it before active columns", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.delete(f.columns[0]._id));
    const draft = await f.t.mutation(api.tasks.createColumn, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Draft" });
    expect((await f.board()).columns[0]._id).toBe(draft);
  });

  test("renaming an active column to Draft puts that semantic column first", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.delete(f.columns[0]._id));
    await f.t.mutation(api.tasks.updateColumn, { sessionToken: f.sessionToken, projectId: f.projectId, columnId: f.columns[2]._id, title: "Draft" });
    expect((await f.board()).columns[0]._id).toBe(f.columns[2]._id);
  });

  test("repair adopts legacy Idea in place but keeps existing Drafts authoritative", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.columns[0]._id, { title: "Idea", isDraft: undefined }));
    const taskId = await f.create("Existing legacy idea", f.columns[0]._id);
    await f.ensure();
    expect((await f.board()).columns[0]).toMatchObject({ _id: f.columns[0]._id, title: "Backlog", isDraft: true });
    expect((await f.t.run(ctx => ctx.db.get(taskId)))?.columnId).toBe(f.columns[0]._id);
  });

  test("repair keeps renamed and additional Drafts private without adopting a separate Idea", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.columns[0]._id, { title: "Private backlog", order: 50 }));
    const otherDraft = await f.t.mutation(api.tasks.createColumn, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Draft" });
    const idea = await f.t.mutation(api.tasks.createColumn, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Idea" });
    const taskId = await f.create("Additional private task", otherDraft);
    await f.ensure();
    const board = await f.board();
    expect(board.columns.filter(isDraftColumn)).toHaveLength(2);
    expect(board.columns.find(column => column._id === idea)).toMatchObject({ title: "Idea" });
    expect(board.tasks.find(task => task._id === taskId)?.columnId).toBe(otherDraft);
    const targets = JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null }));
    expect(targets.rows.map((row: { taskId: string }) => row.taskId)).not.toContain(taskId);
  });

  test("explicit false Draft flags and explicit active task choices survive repair", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.columns[0]._id, { title: "Draft", isDraft: false }));
    const taskId = await f.create("Explicit active Draft name", f.columns[0]._id);
    const board = await f.board();
    expect(board.columns[0]._id).not.toBe(f.columns[0]._id);
    expect(isDraftColumn(board.columns[0])).toBe(true);
    expect(board.columns.find(column => column._id === f.columns[0]._id)?.isDraft).toBe(false);
    expect(board.tasks.find(task => task._id === taskId)?.columnId).toBe(f.columns[0]._id);
    expect((await f.t.query(api.tasks.details, { sessionToken: f.sessionToken, projectId: f.projectId, taskId })).columns[0]._id).toBe(board.columns[0]._id);
  });

  test("invalid explicit columns reject instead of falling back or repairing another board", async () => {
    const f = await fixture();
    const otherId = await f.t.mutation(api.projects.create, { sessionToken: f.sessionToken, teamId: f.teamId, name: "Other project", repoUrl: "https://github.com/fixture/other" });
    const otherColumn = (await f.t.query(api.tasks.board, { sessionToken: f.sessionToken, projectId: otherId })).columns[0]._id;
    await f.t.run(ctx => ctx.db.delete(f.columns[0]._id));
    const before = await f.board();
    await expect(f.create("Wrong board", otherColumn)).rejects.toThrow("Column not found");
    await expect(f.create("Deleted column", f.columns[0]._id)).rejects.toThrow("Column not found");
    expect(await f.board()).toEqual(before);
  });

  test("workspace viewers cannot create defaults or repair a board through task or import APIs", async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      await ctx.db.delete(f.columns[0]._id);
      const member = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", f.teamId).eq("email", email)).unique();
      await ctx.db.patch(member!._id, { role: "viewer" });
    });
    await expect(f.create("Forbidden default")).rejects.toThrow("You have view-only access");
    await expect(f.ensure()).rejects.toThrow("You have view-only access");
    await f.t.mutation(api.projects.importRepos, { sessionToken: f.sessionToken, repos: [{ name: "Draft fixture", repoUrl: "https://github.com/fixture/draft-defaults" }] });
    expect((await f.board()).columns.some(isDraftColumn)).toBe(false);
  });

  test("connector task creation defaults to Draft and preserves explicit lanes and idempotency", async () => {
    const f = await fixture();
    const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.sessionToken, teamId: f.teamId, name: "Fixture connector", write: true });
    const change = { kind: "create_issue" as const, projectId: f.projectId, title: "Connector private idea", priority: "medium" as const, assignedToEmail: email, dueDate: "2027-01-01" };
    const first = await f.t.mutation(api.connectors.write, { token: grant.token, requestId: "default-draft-1", change });
    expect(await f.t.mutation(api.connectors.write, { token: grant.token, requestId: "default-draft-1", change })).toBe(first);
    const taskId = JSON.parse(first).id as Id<"tasks">;
    expect((await f.t.run(ctx => ctx.db.get(taskId)))?.columnId).toBe(f.columns[0]._id);
    const explicit = JSON.parse(await f.t.mutation(api.connectors.write, { token: grant.token, requestId: "explicit-todo-1", change: { ...change, columnId: f.columns[1]._id } })).id as Id<"tasks">;
    expect((await f.t.run(ctx => ctx.db.get(explicit)))?.columnId).toBe(f.columns[1]._id);
    expect((await f.board()).tasks).toHaveLength(2);
  });

  test("feedback conversion defaults to Draft and keeps an explicit lane and existing linkage", async () => {
    const f = await fixture();
    await f.t.mutation(api.feedback.configure, { sessionToken: f.sessionToken, teamId: f.teamId, projectId: f.projectId, title: "Fixture feedback", description: "", enabled: true });
    const portal = (await f.t.query(api.feedback.portals, { sessionToken: f.sessionToken, teamId: f.teamId }))[0];
    for (const title of ["Private feedback", "Explicit feedback"]) await f.t.mutation(internal.feedback.submit, { slug: portal.slug, title, body: "Synthetic feedback only", kind: "idea" });
    const entries = await f.t.query(api.feedback.list, { sessionToken: f.sessionToken, teamId: f.teamId, portalId: portal._id });
    const scope = { sessionToken: f.sessionToken, teamId: f.teamId, assignedToEmail: email, dueDate: "2027-01-01" };
    const taskId = await f.t.mutation(api.feedback.convert, { ...scope, entryId: entries[0]._id });
    expect((await f.t.run(ctx => ctx.db.get(taskId)))?.columnId).toBe(f.columns[0]._id);
    expect(await f.t.mutation(api.feedback.convert, { ...scope, entryId: entries[0]._id, columnId: f.columns[1]._id })).toBe(taskId);
    const explicit = await f.t.mutation(api.feedback.convert, { ...scope, entryId: entries[1]._id, columnId: f.columns[1]._id, priority: "low" });
    expect((await f.t.run(ctx => ctx.db.get(explicit)))?.columnId).toBe(f.columns[1]._id);
    // Priority follows the composer chip when sent, else the kind (an idea is medium).
    expect((await f.t.run(ctx => ctx.db.get(taskId)))?.priority).toBe("medium");
    expect((await f.t.run(ctx => ctx.db.get(explicit)))?.priority).toBe("low");
  });

  test("pending legacy Idea tasks stay out of mirror discovery and publish context before repair", async () => {
    const f = await fixture();
    const taskId = await f.t.run(async ctx => {
      await ctx.db.patch(f.columns[0]._id, { title: "Idea", isDraft: undefined });
      return ctx.db.insert("tasks", { teamId: f.teamId, projectId: f.projectId, columnId: f.columns[0]._id, title: "Legacy private idea", done: false, priority: "medium", order: 0, createdAt: 1, updatedAt: 1 });
    });
    const context = JSON.parse(await f.t.query(internal.integrations.context, { projectId: f.projectId, taskId }));
    expect(context.task.draft).toBe(true);
    const targets = JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null }));
    expect(targets.rows.map((row: { taskId: string }) => row.taskId)).not.toContain(taskId);
  });

  test.each(["existing Draft", "explicit false"])("ordinary Idea remains publishable with %s", async control => {
    const f = await fixture();
    const taskId = await f.t.run(async ctx => {
      const columnId = control === "existing Draft"
        ? await ctx.db.insert("columns", { projectId: f.projectId, title: "Idea", order: 4, createdAt: 1, updatedAt: 1 })
        : f.columns[0]._id;
      if (control === "explicit false") await ctx.db.patch(columnId, { title: "Idea", isDraft: false });
      return ctx.db.insert("tasks", { teamId: f.teamId, projectId: f.projectId, columnId, title: "Explicit active idea", done: false, priority: "medium", order: 0, createdAt: 1, updatedAt: 1 });
    });
    expect(JSON.parse(await f.t.query(internal.integrations.context, { projectId: f.projectId, taskId })).task.draft).toBe(false);
    expect(JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null })).rows.map((row: { taskId: string }) => row.taskId)).toContain(taskId);
  });

  test("runtime repair refuses an ambiguous large legacy board instead of duplicating a deep Draft", async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      await ctx.db.patch(f.columns[0]._id, { order: 999, isDraft: undefined });
      for (let order = 3; order < 106; order++) await ctx.db.insert("columns", { projectId: f.projectId, title: `Legacy active ${order}`, order, createdAt: 1, updatedAt: 1 });
    });
    const before = await f.board();
    await expect(f.create("Wait for ordered repair")).rejects.toThrow("Workflow repair required");
    await expect(f.ensure()).rejects.toThrow("Workflow repair required");
    expect(await f.board()).toEqual(before);
  });

  test("public task, repair and connector APIs cannot set the trusted complete-scan flag", async () => {
    const f = await fixture();
    const taskArgs = { sessionToken: f.sessionToken, projectId: f.projectId, title: "Untrusted scan claim", priority: "medium" as const, assignedToEmail: email, dueDate: "2027-01-01", completeLegacyScan: true };
    await expect(f.t.mutation(api.tasks.createTask, taskArgs)).rejects.toThrow("completeLegacyScan");
    const repairArgs = { sessionToken: f.sessionToken, projectId: f.projectId, completeLegacyScan: true };
    await expect(f.t.mutation(api.tasks.ensureDefaultColumns, repairArgs)).rejects.toThrow("completeLegacyScan");
    const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.sessionToken, teamId: f.teamId, name: "Untrusted connector", write: true });
    const change = { kind: "create_issue" as const, projectId: f.projectId, title: "Connector scan claim", priority: "medium" as const, assignedToEmail: email, dueDate: "2027-01-01", completeLegacyScan: true };
    await expect(f.t.mutation(api.connectors.write, { token: grant.token, requestId: "untrusted-scan-1", change })).rejects.toThrow("completeLegacyScan");
    expect((await f.board()).tasks).toEqual([]);
  });
});
