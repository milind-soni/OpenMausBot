/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import { ensureDraftColumn, isDraftColumn } from "./lib/columns";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

test("three bounded repair phases preserve old tasks and renamed Drafts across pages and retries", async () => {
  const t = convexTest(schema, modules);
  const data = await t.run(async ctx => {
    const email = "draft-migration@example.test";
    const userId = await ctx.db.insert("users", { name: "Migration fixture", email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    const sessionToken = await createSession(ctx, userId);
    const projects = [];
    for (let i = 0; i < 28; i++) {
      const projectId = await ctx.db.insert("projects", { name: `Old project ${i}`, ownerEmail: email, accent: "#123456", status: "active", createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("members", { projectId, userId, email, name: "Owner", role: "owner", status: "active", createdAt: 1, updatedAt: 1 });
      projects.push(projectId);
    }
    const rows: Array<{ projectId: Id<"projects">; columnId: Id<"columns">; taskId: Id<"tasks"> }> = [];
    for (const [index, projectId] of projects.entries()) {
      const columns = [];
      const total = index < 2 ? 125 : 1;
      for (let order = 0; order < total; order++) {
        const title = order === 124 ? index === 0 ? " d-r_a f t " : "Idea" : `Active ${order}`;
        columns.push(await ctx.db.insert("columns", { projectId, title, order, isDone: false, createdAt: 1, updatedAt: 1 }));
      }
      if (index === 0) await ctx.db.insert("columns", { projectId, title: "Idea", order: -1, createdAt: 1, updatedAt: 1 });
      if (index === 2) await ctx.db.patch(columns[0], { title: "Renamed private ideas", isDraft: true, order: 999 });
      if (index === 3) await ctx.db.patch(columns[0], { title: "Draft", isDraft: false });
      const columnId = columns[columns.length - 1];
      const taskId = await ctx.db.insert("tasks", { projectId, columnId, title: `Existing ${index}`, done: index % 2 === 0, priority: "medium", order: 0, createdAt: 1, updatedAt: 1 });
      rows.push({ projectId, columnId, taskId });
    }
    return { sessionToken, rows };
  });
  const snapshot = () => t.run(async ctx => Promise.all(data.rows.map(row => ctx.db.get(row.taskId))));
  const beforeTasks = await snapshot();
  const run = async () => {
    const receipts = [];
    for (const [reference, bound] of [[internal.tasks.flagDraftColumns, 100], [internal.tasks.selectLegacyDraftCandidates, 100], [internal.tasks.repairProjectDrafts, 25]] as const) {
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const receipt: { phase: "columns" | "legacyIdeas" | "projects"; scanned: number; changed: number; created: number; cursor: string; isDone: boolean } = await t.mutation(reference, { cursor });
        expect(receipt.scanned).toBeLessThanOrEqual(bound);
        receipts.push(receipt);
        if (receipt.isDone) break;
        cursor = receipt.cursor;
        if (page === 19) throw new Error("Fixture repair did not terminate");
      }
    }
    return receipts;
  };
  const first = await run();
  expect(first.filter(receipt => receipt.phase === "columns").length).toBeGreaterThan(1);
  expect(first.filter(receipt => receipt.phase === "projects")).toHaveLength(2);
  expect(await snapshot()).toEqual(beforeTasks);
  const columns = [];
  for (const row of data.rows) {
    const board = await t.query(api.tasks.board, { sessionToken: data.sessionToken, projectId: row.projectId });
    expect(isDraftColumn(board.columns[0])).toBe(true);
    expect(isDraftColumn((await t.run(ctx => ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", row.projectId)).first()))!)).toBe(true);
    columns.push(board.columns);
  }
  expect(columns[0].filter(isDraftColumn)).toHaveLength(1);
  expect(columns[0].find(column => column.title === "Idea")?.isDraft).toBeUndefined();
  expect(columns[1][0]).toMatchObject({ _id: data.rows[1].columnId, title: "Draft", isDraft: true });
  expect(columns[2][0]).toMatchObject({ _id: data.rows[2].columnId, title: "Renamed private ideas", isDraft: true });
  expect(columns[3].find(column => column._id === data.rows[3].columnId)?.isDraft).toBe(false);
  const second = await run();
  expect(second.every(receipt => receipt.changed === 0 && receipt.created === 0)).toBe(true);
  expect(await snapshot()).toEqual(beforeTasks);
  for (const [index, row] of data.rows.entries()) expect((await t.query(api.tasks.board, { sessionToken: data.sessionToken, projectId: row.projectId })).columns).toEqual(columns[index]);
});

test.each([true, false])("large legacy Idea lookup fails closed until repair resolves semantic Draft (deep existing Draft: %s)", async deepDraft => {
  const t = convexTest(schema, modules);
  const data = await t.run(async ctx => {
    const projectId = await ctx.db.insert("projects", { name: "Large old board", ownerEmail: "draft-lookup@example.test", accent: "#123456", status: "active", repoUrl: "https://github.com/fixture/large-draft", githubWorkspaceAccess: true, createdAt: 1, updatedAt: 1 });
    let ideaId: Id<"columns"> | undefined;
    let deepId: Id<"columns"> | undefined;
    for (let order = 0; order < 105; order++) {
      const id = await ctx.db.insert("columns", { projectId, title: order === 0 ? "Idea" : order === 104 && deepDraft ? "Draft" : `Active ${order}`, order, createdAt: 1, updatedAt: 1 });
      if (order === 0) ideaId = id;
      if (order === 104) deepId = id;
    }
    const ideaTask = await ctx.db.insert("tasks", { projectId, columnId: ideaId!, title: "Old Idea task", done: false, priority: "medium", order: 0, createdAt: 1, updatedAt: 1 });
    const deepTask = await ctx.db.insert("tasks", { projectId, columnId: deepId!, title: "Deep old task", done: false, priority: "medium", order: 0, createdAt: 1, updatedAt: 1 });
    const linkedTask = await ctx.db.insert("tasks", { projectId, columnId: ideaId!, title: "Existing linked task", done: false, priority: "medium", order: 1, githubIssueNumber: 37, githubIssueUrl: "https://github.com/fixture/large-draft/issues/37", githubIssueState: "open", createdAt: 1, updatedAt: 1 });
    return { projectId, ideaTask, deepTask, linkedTask };
  });
  const context = () => t.query(internal.integrations.context, { projectId: data.projectId, taskId: data.ideaTask });
  const targets = async () => JSON.parse(await t.query(internal.integrations.unlinkedTasks, { cursor: null })).rows.map((row: { taskId: string }) => row.taskId);
  const snapshot = () => t.run(async ctx => Promise.all([data.ideaTask, data.deepTask, data.linkedTask].map(id => ctx.db.get(id))));
  const before = await snapshot();
  await expect(context()).rejects.toThrow("Workflow repair required");
  expect(await targets()).not.toContain(data.ideaTask);
  if (deepDraft) expect(await targets()).not.toContain(data.deepTask);
  let cursor: string | null = null;
  do {
    const receipt: { cursor: string; isDone: boolean } = await t.mutation(internal.tasks.flagDraftColumns, { cursor });
    cursor = receipt.isDone ? null : receipt.cursor;
  } while (cursor);
  if (deepDraft) expect(JSON.parse(await context()).task.draft).toBe(false);
  else await expect(context()).rejects.toThrow("Workflow repair required");
  do {
    const receipt: { cursor: string; isDone: boolean } = await t.mutation(internal.tasks.selectLegacyDraftCandidates, { cursor });
    cursor = receipt.isDone ? null : receipt.cursor;
  } while (cursor);
  if (!deepDraft) await expect(context()).rejects.toThrow("Workflow repair required");
  await t.mutation(internal.tasks.repairProjectDrafts, { cursor: null });
  expect(JSON.parse(await context()).task.draft).toBe(!deepDraft);
  expect((await targets()).includes(data.ideaTask)).toBe(deepDraft);
  if (deepDraft) expect(await targets()).not.toContain(data.deepTask);
  expect(await snapshot()).toEqual(before);
});

test("paged candidate selection adopts the earliest board-order Idea rather than the first inserted one", async () => {
  const t = convexTest(schema, modules);
  const data = await t.run(async ctx => {
    const projectId = await ctx.db.insert("projects", { name: "Out of order legacy board", ownerEmail: "draft-order@example.test", accent: "#123456", status: "active", createdAt: 1, updatedAt: 1 });
    for (let order = 0; order < 101; order++) await ctx.db.insert("columns", { projectId, title: `Active ${order}`, order, createdAt: 1, updatedAt: 1 });
    const late = await ctx.db.insert("columns", { projectId, title: "Idea", order: 400, createdAt: 1, updatedAt: 1 });
    for (let order = 101; order < 202; order++) await ctx.db.insert("columns", { projectId, title: `Active ${order}`, order, createdAt: 1, updatedAt: 1 });
    const early = await ctx.db.insert("columns", { projectId, title: "Idea", order: 300, createdAt: 1, updatedAt: 1 });
    const tied = await ctx.db.insert("columns", { projectId, title: "Idea", order: 300, createdAt: 1, updatedAt: 1 });
    for (const columnId of [late, early, tied]) await ctx.db.insert("tasks", { projectId, columnId, title: "Existing Idea", done: false, priority: "medium", order: 0, createdAt: 1, updatedAt: 1 });
    return { projectId, late, early, tied };
  });
  const snapshot = () => t.run(ctx => ctx.db.query("tasks").withIndex("by_project", q => q.eq("projectId", data.projectId)).collect());
  const before = await snapshot();
  for (const reference of [internal.tasks.flagDraftColumns, internal.tasks.selectLegacyDraftCandidates] as const) {
    let cursor: string | null = null;
    do {
      const receipt: { cursor: string; isDone: boolean } = await t.mutation(reference, { cursor });
      cursor = receipt.isDone ? null : receipt.cursor;
    } while (cursor);
  }
  const result = await t.mutation(internal.tasks.repairProjectDrafts, { cursor: null });
  expect(result.adopted).toBe(1);
  const columns = await t.run(ctx => ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", data.projectId)).collect());
  expect(columns.filter(isDraftColumn).map(column => column._id)).toEqual([data.early]);
  expect(columns[0]._id).toBe(data.early);
  expect((await t.run(ctx => ctx.db.get(data.projectId)))?.draftIdeaCandidateId).toBeUndefined();
  expect(await snapshot()).toEqual(before);
});

test.each(["different project", "renamed", "explicit false", "existing Draft", "deleted"])("stale %s candidate cannot override the workflow during repair", async scenario => {
  const t = convexTest(schema, modules);
  const data = await t.run(async ctx => {
    const fields = { name: "Candidate fixture", ownerEmail: "draft-candidate@example.test", accent: "#123456", status: "active" as const, createdAt: 1, updatedAt: 1 };
    const projectId = await ctx.db.insert("projects", fields);
    const otherId = await ctx.db.insert("projects", { ...fields, name: "Other project" });
    const candidate = await ctx.db.insert("columns", { projectId: scenario === "different project" ? otherId : projectId, title: scenario === "renamed" ? "Active" : "Idea", ...(scenario === "explicit false" ? { isDraft: false } : {}), order: 0, createdAt: 1, updatedAt: 1 });
    const existing = scenario === "existing Draft" ? await ctx.db.insert("columns", { projectId, title: "Private backlog", isDraft: true, order: 5, createdAt: 1, updatedAt: 1 }) : undefined;
    await ctx.db.patch(projectId, { draftIdeaCandidateId: candidate });
    if (scenario === "deleted") await ctx.db.delete(candidate);
    return { projectId, candidate, existing };
  });
  const candidateBefore = await t.run(ctx => ctx.db.get(data.candidate));
  await t.run(ctx => ensureDraftColumn(ctx, data.projectId));
  const columns = await t.run(ctx => ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", data.projectId)).collect());
  expect(isDraftColumn(columns[0])).toBe(true);
  if (data.existing) expect(columns[0]._id).toBe(data.existing);
  else expect(columns[0]._id).not.toBe(data.candidate);
  expect((await t.run(ctx => ctx.db.get(data.projectId)))?.draftIdeaCandidateId).toBeUndefined();
  expect(await t.run(ctx => ctx.db.get(data.candidate))).toEqual(candidateBefore);
});
