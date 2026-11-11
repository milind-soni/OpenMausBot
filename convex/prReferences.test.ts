/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { Id } from "./_generated/dataModel";
import type { PRSnapshot } from "../lib/github-pr-snapshot";
import { issueKey } from "../lib/github-references";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const repoUrl = "https://github.com/Acme/Widgets";
const sha = (c: string) => c.repeat(40);
// convex-test ids all end in "tasks", so every test issue has the same key; issues beyond the first are named by link.
const url = (id: string) => `https://origin.test/acme?project=p&issue=${id}`;

async function workspace(t: ReturnType<typeof convexTest>, email: string, name: string, repo = repoUrl) {
  const sessionToken = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name, email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, userId);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name, repoUrl: repo });
  const scope = { sessionToken, projectId };
  const columns = (await t.query(api.tasks.board, scope)).columns;
  const todo = columns.find(c => c.title === "Todo")!._id;
  const review = await t.run(async ctx => {
    await ctx.db.patch(projectId, { githubWorkspaceAccess: true });
    return ctx.db.insert("columns", { projectId, title: "In review", order: 5, isDone: false, createdAt: 1, updatedAt: 1 });
  });
  const create = (title: string) => t.mutation(api.tasks.createTask, { ...scope, columnId: todo, title, priority: "medium" });
  return { sessionToken, teamId, projectId, scope, todo, review, create };
}

async function fixture() {
  const t = convexTest(schema, modules);
  const a = await workspace(t, "owner@acme.test", "Acme");
  const taskId = await a.create("Fix login");
  const key = issueKey(taskId);
  const pr = (over: Partial<PRSnapshot> = {}): PRSnapshot => ({ number: 7, url: `${repoUrl}/pull/7`, branch: `origin/${key}-fix-login`, headSha: sha("a"), baseSha: sha("b"), state: "open", checks: "unknown", review: "unknown", mergeable: null, githubUpdatedAt: 1000, ...over });
  const link = (snapshot: PRSnapshot, extra: { title?: string; body?: string; projectIds?: Id<"projects">[] } = {}) =>
    t.mutation(internal.taskPRs.linkReferences, { repoUrl, projectIds: extra.projectIds ?? [a.projectId], title: extra.title ?? "Fix login", body: extra.body, snapshot });
  const task = (id = taskId) => t.run(ctx => ctx.db.get(id));
  const rows = () => t.run(ctx => ctx.db.query("taskPullRequests").collect());
  return { t, a, taskId, key, pr, link, task, rows };
}

describe("pull requests link to the issues they reference", () => {
  test("a branch with the issue key links, moves the issue to review, and merging completes it once", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.a.projectId, { githubReviewColumnId: f.a.review }));
    expect(await f.link(f.pr())).toEqual([{ taskId: f.taskId, closes: true }]);
    expect(await f.task()).toMatchObject({ columnId: f.a.review, done: false });
    expect(await f.rows()).toEqual([expect.objectContaining({ linkSource: "reference", closes: true, state: "open", title: "Fix login", repository: "acme/widgets" })]);
    await f.link(f.pr({ state: "merged", githubUpdatedAt: 2000 }));
    expect(await f.task()).toMatchObject({ done: true, completedAt: 2000 });
    const doneColumn = await f.t.run(async ctx => ctx.db.get((await ctx.db.get(f.taskId))!.columnId));
    expect(doneColumn).toMatchObject({ title: "Done", isDone: true });
    expect((await f.t.query(api.projects.get, f.a.scope)).openIssueCount).toBe(0);
    // A redelivered merge after someone reopened the issue does not complete it again.
    await f.t.mutation(api.tasks.updateTask, { ...f.a.scope, taskId: f.taskId, done: false });
    await f.link(f.pr({ state: "merged", githubUpdatedAt: 2000 }));
    expect((await f.task())!.done).toBe(false);
    expect(await f.t.run(ctx => ctx.db.query("taskCompletions").collect())).toHaveLength(1);
  });

  test("an older event arriving after the merge changes nothing; check updates never reopen or move a completed issue", async () => {
    const f = await fixture();
    await f.link(f.pr({ githubUpdatedAt: 1000 }));
    await f.t.mutation(api.tasks.updateTask, { ...f.a.scope, taskId: f.taskId, done: true });
    await f.link(f.pr({ githubUpdatedAt: 1500, checks: "success" }));
    expect((await f.task())!.done).toBe(true);
    await f.t.mutation(api.tasks.updateTask, { ...f.a.scope, taskId: f.taskId, done: false });
    await f.link(f.pr({ state: "merged", githubUpdatedAt: 3000 }));
    expect((await f.task())!.done).toBe(true);
    await f.link(f.pr({ state: "open", githubUpdatedAt: 2000 }));
    expect(await f.rows()).toEqual([expect.objectContaining({ state: "merged", githubUpdatedAt: 3000, checks: "success" })]);
    expect((await f.task())!.done).toBe(true);
  });

  test("closing keywords close; linking keywords only link; editing the reference away unlinks", async () => {
    const f = await fixture();
    const other = await f.a.create("Write docs");
    const branch = "feature/no-key";
    expect(await f.link(f.pr({ branch }), { title: "Login and docs", body: `Closes ${url(f.taskId)}\nRefs ${url(other)}` })).toEqual(expect.arrayContaining([{ taskId: f.taskId, closes: true }, { taskId: other, closes: false }]));
    await f.link(f.pr({ branch, githubUpdatedAt: 1500 }), { title: "Login only", body: `Closes ${url(f.taskId)}` });
    expect((await f.rows()).map(row => row.taskId)).toEqual([f.taskId]);
    await f.link(f.pr({ branch, githubUpdatedAt: 1600 }), { title: "Login only", body: `Refs ${url(f.taskId)}` });
    await f.link(f.pr({ branch, state: "merged", githubUpdatedAt: 2000 }), { title: "Login only", body: `Refs ${url(f.taskId)}` });
    expect((await f.task())!.done).toBe(false);
    expect(await f.rows()).toEqual([expect.objectContaining({ closes: false, state: "merged" })]);
  });

  test("`Fixes #12` resolves through the GitHub issue linked to an Origin issue; ambiguous keys are skipped", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.taskId, { githubIssueNumber: 12, githubIssueUrl: `${repoUrl}/issues/12` }));
    expect(await f.link(f.pr({ branch: "x" }), { title: "Login", body: "Fixes #12" })).toEqual([{ taskId: f.taskId, closes: true }]);
    // A GitHub issue number linked to two Origin issues is ambiguous and links neither.
    const twin = await f.a.create("Twin");
    await f.t.run(ctx => ctx.db.patch(twin, { githubIssueNumber: 13, githubIssueUrl: `${repoUrl}/issues/13` }));
    await f.t.run(ctx => ctx.db.patch(f.taskId, { githubIssueNumber: 13, githubIssueUrl: `${repoUrl}/issues/13` }));
    expect(await f.link(f.pr({ number: 8, url: `${repoUrl}/pull/8`, branch: "y" }), { title: "Twin", body: "Fixes #13" })).toEqual([]);
  });

  test("workspace isolation: only approved, active projects the server verified are touched", async () => {
    const f = await fixture();
    const b = await workspace(f.t, "owner@other.test", "Other");
    const theirs = await b.create("Their issue");
    await f.t.run(ctx => ctx.db.patch(b.projectId, { githubWorkspaceAccess: false }));
    const ids = await f.t.query(internal.taskPRs.repositoryProjects, { repoUrl: "https://github.com/acme/widgets" });
    expect(ids).toEqual([f.a.projectId]);
    // Even if a caller passes it, an unapproved project or another repository's project is ignored.
    const result = await f.link(f.pr({ branch: "x" }), { title: "Theirs", body: `Closes ${url(theirs)}`, projectIds: [b.projectId] });
    expect(result).toEqual([]);
    const c = await workspace(f.t, "owner@third.test", "Third", "https://github.com/third/repo");
    const third = await c.create("Third issue");
    expect(await f.link(f.pr({ branch: "x" }), { body: `Closes ${url(third)}`, projectIds: [c.projectId] })).toEqual([]);
    expect(await f.rows()).toEqual([]);
    // An issue of another project never links through this project, even when named directly.
    expect(await f.link(f.pr({ branch: "x" }), { body: `Closes ${url(theirs)}`, projectIds: [f.a.projectId] })).toEqual([]);
  });

  test("closing commits on the default branch complete issues; linking ones do not", async () => {
    const f = await fixture();
    const other = await f.a.create("Docs");
    const done = await f.t.mutation(internal.taskPRs.completeFromCommits, { repoUrl, projectIds: [f.a.projectId], commits: [
      { message: `Tidy login\n\nFixes ${url(f.taskId)}`, timestamp: 5000 },
      { message: `Part of ${url(other)}`, timestamp: 5000 },
    ] });
    expect(done).toEqual([f.taskId]);
    expect(await f.task()).toMatchObject({ done: true, completedAt: 5000 });
    expect((await f.task(other))!.done).toBe(false);
    expect(await f.t.mutation(internal.taskPRs.completeFromCommits, { repoUrl, projectIds: [f.a.projectId], commits: [{ message: `Fixes ${url(f.taskId)}`, timestamp: 6000 }] })).toEqual([]);
  });
});
