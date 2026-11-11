/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { PRSnapshot } from "../lib/github-pr-snapshot";
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const repoUrl = "https://github.com/test/prs";
const sha = (s: string) => s.repeat(40);

async function fixture() {
  const t = convexTest(schema, modules);
  const person = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name: "Owner", email: "prs@test.dev", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: Date.now(), updatedAt: Date.now() });
    return { userId, sessionToken: await createSession(ctx, userId) };
  });
  const { sessionToken, userId } = person;
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "PR test" });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "PRs", repoUrl });
  const { taskId, columnId, reviewId } = await t.run(async ctx => {
    await ctx.db.patch(projectId, { githubWorkspaceAccess: true });
    const columnId = (await ctx.db.query("columns").withIndex("by_project", q => q.eq("projectId", projectId)).collect()).find(column => column.title === "Todo")!._id;
    const reviewId = await ctx.db.insert("columns", { projectId, title: "In review", order: 5, isDone: false, createdAt: 1, updatedAt: 1 });
    const taskId = await ctx.db.insert("tasks", { projectId, teamId, title: "Implement", columnId, done: false, priority: "medium", order: 1, createdAt: 1, updatedAt: 1 });
    await ctx.db.patch(projectId, { openIssueCount: 1, githubReviewColumnId: reviewId });
    return { taskId, columnId, reviewId };
  });
  const tool = { branch: "origin/task" };
  const s: PRSnapshot = { number: 1, url: `${repoUrl}/pull/1`, branch: tool.branch, headSha: sha("a"), baseSha: sha("b"), state: "draft", checks: "pending", review: "review_required", mergeable: null, githubUpdatedAt: 1000 };
  const link = async (snapshot = s) => JSON.parse(await t.mutation(internal.taskPRs.finalize, { sessionToken, projectId, taskId, snapshot }));
  return { t, sessionToken, userId, teamId, projectId, taskId, columnId, reviewId, tool, s, link };
}

describe("PR lifecycle and missed event recovery", () => {
  test("unchanged cron snapshots advance ordering without rewriting the task and project", async () => {
    const f = await fixture(); const { id } = await f.link();
    await f.t.run(async ctx => { await ctx.db.patch(f.taskId, { updatedAt: 123 }); await ctx.db.patch(f.projectId, { updatedAt: 456 }); });
    await f.t.mutation(internal.taskPRs.sync, { id, sequence: 2, snapshot: f.s });
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.updatedAt).toBe(123);
    expect((await f.t.run(ctx => ctx.db.get(f.projectId)))!.updatedAt).toBe(456);
  });
  test("review configuration never hides an unmerged task in a system Done column", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.reviewId, { isDone: true }));
    await expect(f.t.mutation(api.taskPRs.configure, { sessionToken: f.sessionToken, projectId: f.projectId, mode: "pull_request", reviewColumnId: f.reviewId })).rejects.toThrow("active workflow");
    await f.t.run(ctx => ctx.db.patch(f.projectId, { githubReviewColumnId: f.reviewId }));
    await expect(f.link()).rejects.toThrow("Configure an active PR review column");
    expect(await f.t.run(ctx => ctx.db.get(f.taskId))).toMatchObject({ columnId: f.columnId, done: false });
  });
  test("webhook targets are repository-scoped despite common PR numbers elsewhere", async () => {
    const f = await fixture(); const { id } = await f.link();
    const original = (await f.t.run(ctx => ctx.db.get("taskPullRequests", id)))!;
    const { _id, _creationTime, ...fields } = original; void _id; void _creationTime;
    await f.t.run(async ctx => {
      await ctx.db.delete(id);
      for (let n = 0; n < 30; n++) await ctx.db.insert("taskPullRequests", { ...fields, repository: `foreign/repo-${n}`, url: `https://github.com/foreign/repo-${n}/pull/1` });
      await ctx.db.insert("taskPullRequests", fields);
    });
    const found = await f.t.query(internal.taskPRs.eventTargets, { repoUrl: repoUrl.toUpperCase(), numbers: [1, 1], headSha: f.s.headSha });
    expect(found).toHaveLength(1); expect(found[0].url).toBe(f.s.url);
    await f.t.run(ctx => ctx.db.patch(found[0]._id, { repository: undefined }));
    expect(await f.t.query(internal.taskPRs.eventTargets, { repoUrl, numbers: [1] })).toHaveLength(1);
    await f.t.mutation(internal.taskPRs.backfillRepositories, {});
    expect((await f.t.run(ctx => ctx.db.get(found[0]._id)))!.repository).toBe("test/prs");
  });
  test("closed-unmerged PRs remain reconciliation targets for missed reopen/merge events", async () => {
    const f = await fixture(); const { id } = await f.link();
    await f.t.mutation(internal.taskPRs.sync, { id, sequence: 2, snapshot: { ...f.s, state: "closed", githubUpdatedAt: 2000 } });
    expect(JSON.parse(await f.t.query(internal.taskPRs.targets, { state: "closed", cursor: null })).rows.map((r: { _id: string }) => r._id)).toEqual([id]);
    await f.t.mutation(internal.taskPRs.sync, { id, sequence: 3, snapshot: { ...f.s, state: "open", githubUpdatedAt: 3000 } });
    expect(await f.t.run(ctx => ctx.db.get(f.taskId))).toMatchObject({ columnId: f.reviewId, done: false });
  });
  test("draft/open never complete; close restores column; only merge moves Done and records completion once", async () => {
    const f = await fixture(); const linked = await f.link();
    expect(await f.t.run(ctx => ctx.db.get(f.taskId))).toMatchObject({ done: false, columnId: f.reviewId, githubTaskMode: "pull_request" });
    const update = async (state: PRSnapshot["state"], time: number) => {
      const sequence = (await f.t.mutation(internal.taskPRs.beginSync, { id: linked.id }))!;
      return f.t.mutation(internal.taskPRs.sync, { id: linked.id, sequence, snapshot: { ...f.s, state, githubUpdatedAt: time, checks: "success", review: "approved", mergeable: true } });
    };
    await update("open", 2000);
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.done).toBe(false);
    await update("closed", 3000);
    expect(await f.t.run(ctx => ctx.db.get(f.taskId))).toMatchObject({ done: false, columnId: f.columnId });
    await update("open", 4000);
    await update("merged", 5000); await update("merged", 5000);
    const task = (await f.t.run(ctx => ctx.db.get(f.taskId)))!;
    expect(task.done).toBe(true);
    expect((await f.t.run(ctx => ctx.db.get(task.columnId)))!.title).toBe("Done");
    expect(await f.t.run(ctx => ctx.db.query("taskCompletions").withIndex("by_taskId", q => q.eq("taskId", f.taskId)).take(10))).toHaveLength(1);
    expect((await f.t.run(ctx => ctx.db.get(f.projectId)))!.openIssueCount).toBe(0);
    expect(await update("closed", 6000)).toBe(false);
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.done).toBe(true);
  });
  test("configured review/Done columns, disabled review and missing review defaults", async () => {
    const f = await fixture();
    await f.t.mutation(api.taskPRs.configure, { sessionToken: f.sessionToken, projectId: f.projectId, mode: "pull_request", reviewColumnId: null, doneColumnId: f.reviewId });
    const linked = await f.link();
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.columnId).toBe(f.columnId);
    await f.t.mutation(internal.taskPRs.sync, { id: linked.id, sequence: 2, snapshot: { ...f.s, state: "merged", githubUpdatedAt: 2000 } });
    expect(await f.t.run(ctx => ctx.db.get(f.taskId))).toMatchObject({ columnId: f.reviewId, done: true });
    const g = await fixture(); await g.t.run(ctx => ctx.db.delete(g.reviewId));
    await expect(g.link()).rejects.toThrow("Configure an active PR review column");
    expect((await g.t.run(ctx => ctx.db.get(g.taskId)))!.columnId).toBe(g.columnId);
    const missing = await fixture();
    await missing.t.run(ctx => ctx.db.patch(missing.projectId, { githubReviewColumnId: undefined }));
    await expect(missing.link()).rejects.toThrow("Configure an active PR review column");
    const h = await fixture();
    await h.t.mutation(api.taskPRs.configure, { sessionToken: h.sessionToken, projectId: h.projectId, mode: "issue", reviewColumnId: h.columnId });
    await h.link(); expect((await h.t.run(ctx => ctx.db.get(h.taskId)))!.columnId).toBe(h.columnId);
  });
  test("timestamps and sync sequence reject stale head/check/review snapshots, including same-second pushes", async () => {
    const f = await fixture(); const { id } = await f.link();
    const earlier = (await f.t.mutation(internal.taskPRs.beginSync, { id }))!;
    const latest = (await f.t.mutation(internal.taskPRs.beginSync, { id }))!;
    expect(await f.t.mutation(internal.taskPRs.sync, { id, sequence: latest, snapshot: { ...f.s, headSha: sha("c"), checks: "failure", review: "changes_requested" } })).toBe(true);
    expect(await f.t.mutation(internal.taskPRs.sync, { id, sequence: earlier, snapshot: { ...f.s, checks: "success", review: "approved" } })).toBe(false);
    expect(await f.t.mutation(internal.taskPRs.sync, { id, sequence: latest + 1, snapshot: { ...f.s, githubUpdatedAt: 999 } })).toBe(false);
    expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ headSha: sha("c"), checks: "failure", review: "changes_requested" });
    expect(JSON.parse(await f.t.query(internal.taskPRs.targets, { cursor: null, state: "draft" })).rows).toHaveLength(1);
    await f.t.run(ctx => ctx.db.patch(f.projectId, { repoUrl: "https://github.com/test/changed" }));
    expect(await f.t.mutation(internal.taskPRs.sync, { id, sequence: latest + 2, snapshot: { ...f.s, state: "merged", githubUpdatedAt: 2000 } })).toBe(false);
  });
  test("issue closure needs trusted merge evidence, and issue-mode reopening still applies", async () => {
    const f = await fixture(); await f.t.mutation(internal.taskPRs.humanContext, { sessionToken: f.sessionToken, projectId: f.projectId, taskId: f.taskId, choosePR: true }); // Protect before the first PR link exists.
    const issue = { projectId: f.projectId, taskId: f.taskId, repoUrl, number: 42, issueUrl: `${repoUrl}/issues/42`, state: "closed" as const, updatedAt: 2000 };
    await f.t.mutation(internal.integrations.linkIssue, issue);
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.done).toBe(false);
    await f.link({ ...f.s, state: "merged", githubUpdatedAt: 3000 });
    await f.t.mutation(internal.integrations.linkIssue, { ...issue, state: "open", updatedAt: 4000 });
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.done).toBe(true);
    const g = await fixture(); await g.t.mutation(internal.integrations.linkIssue, { ...issue, taskId: g.taskId, projectId: g.projectId });
    expect((await g.t.run(ctx => ctx.db.get(g.taskId)))!.done).toBe(false);
    await g.t.mutation(internal.integrations.completeMergedIssue, { projectId: g.projectId, taskId: g.taskId, repoUrl, issueNumber: 42, pullRequest: { number: 9, headSha: sha("a"), mergeSha: sha("b"), mergedAt: 2500 } });
    expect((await g.t.run(ctx => ctx.db.get(g.taskId)))!.done).toBe(true);
    await g.t.mutation(internal.integrations.linkIssue, { ...issue, taskId: g.taskId, projectId: g.projectId, state: "open", updatedAt: 3000 });
    expect((await g.t.run(ctx => ctx.db.get(g.taskId)))!.done).toBe(false);
  });
});

describe("Delivery dedupe and finalize authority", () => {
  test("delivery claims are atomic, leased, deduplicated and payload-bound", async () => {
    const f = await fixture(), a = { deliveryId: "signed-delivery-1", fingerprint: "a".repeat(64) };
    const claims = await Promise.all([f.t.mutation(internal.taskPRs.delivery, a), f.t.mutation(internal.taskPRs.delivery, a)]);
    expect(claims.filter(n => n !== null)).toHaveLength(1);
    const lease = claims.find(n => n !== null)!;
    await f.t.mutation(internal.taskPRs.delivery, { ...a, finishLease: lease });
    expect(await f.t.mutation(internal.taskPRs.delivery, a)).toBeNull();
    await expect(f.t.mutation(internal.taskPRs.delivery, { ...a, fingerprint: "b".repeat(64) })).rejects.toThrow("collision");
    await f.t.run(async ctx => { const row = (await ctx.db.query("githubDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", a.deliveryId)).unique())!; await ctx.db.patch(row._id, { state: "processing", lease: 1 }); });
    expect(await f.t.mutation(internal.taskPRs.delivery, a)).not.toBeNull();
  });
  test("finalize is idempotent and task status exposes authoritative SHAs; wrong URL/link/task is denied", async () => {
    const f = await fixture(); const result = await f.link();
    expect(await f.link()).toMatchObject({ status: "opened", number: 1, url: f.s.url });
    expect((await f.t.query(api.taskPRs.list, { sessionToken: f.sessionToken, taskId: f.taskId }))[0]).toMatchObject({ headSha: f.s.headSha, baseSha: f.s.baseSha, state: "draft" });
    await expect(f.link({ ...f.s, number: 2, url: "https://github.com/foreign/repo/pull/2" })).rejects.toThrow("repository");
    await expect(f.t.mutation(internal.taskPRs.finalize, { sessionToken: "wrong", projectId: f.projectId, taskId: f.taskId, snapshot: f.s })).rejects.toThrow();
    expect((await f.t.query(api.taskPRs.list, { sessionToken: f.sessionToken, taskId: f.taskId }))[0]._id).toBe(result.id);
  });
  test("task action keeps a stable branch after rename and the project mirror default remains issues", async () => {
    const f = await fixture();
    expect((await f.t.run(ctx => ctx.db.get(f.projectId)))!.githubTaskMode).toBeUndefined();
    const a = { sessionToken: f.sessionToken, projectId: f.projectId, taskId: f.taskId, choosePR: true };
    const first = JSON.parse(await f.t.mutation(internal.taskPRs.humanContext, a));
    await f.t.run(ctx => ctx.db.patch(f.taskId, { title: "Renamed task" }));
    const next = JSON.parse(await f.t.mutation(internal.taskPRs.humanContext, a));
    expect(next.task.githubTaskBranch).toBe(first.task.githubTaskBranch);
    expect(next.task.githubTaskMode).toBe("pull_request");
    await f.t.run(ctx => ctx.db.patch(f.projectId, { githubWorkspaceAccess: false }));
    await expect(f.t.mutation(internal.taskPRs.humanContext, a)).rejects.toThrow("Authorize");
  });
});

describe("GitHub-first issue lifecycle", () => {
  test("a GitHub-linked issue completes by hand or through a merged pull request", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.taskId, { githubIssueNumber: 7, githubIssueUrl: `${repoUrl}/issues/7`, githubIssueState: "open" }));
    await f.t.mutation(api.tasks.updateTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId: f.taskId, done: true });
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.done).toBe(true);
    await f.t.mutation(api.tasks.updateTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId: f.taskId, done: false });
    await f.link({ ...f.s, state: "merged", githubUpdatedAt: 3000 });
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.done).toBe(true);
    await f.t.mutation(api.tasks.updateTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId: f.taskId, done: false });
    await f.t.mutation(api.tasks.updateTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId: f.taskId, done: true });
    expect((await f.t.run(ctx => ctx.db.get(f.taskId)))!.done).toBe(true);
  });
  test("unlinked open issues of authorized projects are listed for mirroring, and the context carries the last GitHub state", async () => {
    const f = await fixture();
    const page = JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null }));
    expect(page.rows).toEqual([{ projectId: f.projectId, taskId: f.taskId }]);
    await f.t.run(ctx => ctx.db.patch(f.taskId, { githubIssueNumber: 3, githubIssueState: "closed" }));
    expect(JSON.parse(await f.t.query(internal.integrations.unlinkedTasks, { cursor: null })).rows).toEqual([]);
    const context = JSON.parse(await f.t.query(internal.integrations.context, { projectId: f.projectId, taskId: f.taskId }));
    expect(context.task.githubIssueState).toBe("closed");
  });
  test("a project created with githubRepo later waits for the person instead of creating a repository", async () => {
    const f = await fixture();
    const later = await f.t.mutation(api.projects.create, { sessionToken: f.sessionToken, teamId: f.teamId, name: "Later", githubRepo: "later" });
    const project = await f.t.run(ctx => ctx.db.get(later));
    expect(project!.githubRepoState).toBeUndefined();
    expect(await f.t.query(internal.integrations.pending, {})).not.toContain(later);
  });
});
