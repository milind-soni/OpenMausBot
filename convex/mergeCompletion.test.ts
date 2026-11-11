/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const repoUrl = "https://github.com/fixture/merge-completion";
const pullRequest = { number: 4, headSha: "a".repeat(40), mergeSha: "b".repeat(40), mergedAt: 10000 };
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = convexTest(schema, modules);
  const email = "owner@merge.test";
  const sessionToken = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name: "Owner", email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, userId);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Merge fixture" });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Merge fixture", repoUrl });
  const scope = { sessionToken, projectId };
  const columns = (await t.query(api.tasks.board, scope)).columns;
  const taskId = await t.mutation(api.tasks.createTask, { ...scope, columnId: columns[1]!._id, title: "Implement issue", priority: "medium", assignedToEmail: email, dueDate: "2026-12-31" });
  const link = (state: "open" | "closed", updatedAt: number) => t.mutation(internal.integrations.linkIssue, { projectId, taskId, repoUrl, number: 7, issueUrl: `${repoUrl}/issues/7`, state, updatedAt });
  const completion = { projectId, taskId, repoUrl, issueNumber: 7, pullRequest };
  const complete = () => t.mutation(internal.integrations.completeMergedIssue, completion);
  const task = async () => (await t.query(api.tasks.details, { ...scope, taskId })).task;
  return { t, scope, columns, taskId, link, completion, complete, task };
}

describe("GitHub issue state sync", () => {
  test("closing the GitHub issue completes the Origin issue once, and reopening it on GitHub reopens it", async () => {
    const f = await fixture();
    await f.link("open", 1000);
    await f.link("closed", 2000);
    expect(await f.task()).toMatchObject({ githubIssueState: "closed", done: true, completedAt: 2000 });
    await f.link("closed", 2000);
    await f.link("closed", 2500);
    expect(await f.t.run(ctx => ctx.db.query("taskCompletions").collect())).toHaveLength(1);
    expect((await f.t.query(api.projects.get, f.scope)).openIssueCount).toBe(0);
    await f.link("open", 3000);
    expect(await f.task()).toMatchObject({ githubIssueState: "open", done: false });
    expect((await f.t.query(api.projects.get, f.scope)).openIssueCount).toBe(1);
  });

  test("a GitHub close does not complete an issue first seen closed, one in Draft, or one reopened in Origin", async () => {
    const f = await fixture();
    await f.link("closed", 1000);
    expect(await f.task()).toMatchObject({ githubIssueState: "closed", done: false });
    expect((await f.task()).githubIssueReopenRequested).toBeUndefined();
    await f.link("open", 2000);
    await f.t.mutation(api.tasks.moveTask, { ...f.scope, taskId: f.taskId, columnId: f.columns[0]!._id });
    await f.link("closed", 3000);
    expect((await f.task()).done).toBe(false);
    await f.t.mutation(api.tasks.moveTask, { ...f.scope, taskId: f.taskId, columnId: f.columns[1]!._id });
    await f.link("open", 4000);
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: f.taskId, done: true });
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: f.taskId, done: false });
    await f.link("closed", 5000);
    expect(await f.task()).toMatchObject({ done: false, githubIssueReopenRequested: true });
    expect((await f.t.query(api.projects.get, f.scope)).openIssueCount).toBe(1);
  });

  test("a pull-request-driven issue follows its pull request, not its GitHub issue", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.taskId, { githubTaskMode: "pull_request" }));
    await f.link("open", 1000);
    await f.link("closed", 2000);
    expect((await f.task()).done).toBe(false);
  });

  test("legacy snapshots never complete an issue just because GitHub reports closed", async () => {
    const f = await fixture();
    await f.t.mutation(internal.github.upsertRepoSnapshot, { ...f.scope, repoUrl, issues: [{ number: 7, title: "Closed elsewhere", state: "closed", url: `${repoUrl}/issues/7`, updatedAt: 1000 }], pullRequests: [] });
    expect((await f.t.query(api.tasks.board, f.scope)).tasks.every(task => !task.done)).toBe(true);
  });

  test("a trusted, repository-pinned merge receipt completes once and survives a retry", async () => {
    const f = await fixture();
    await f.link("closed", 1000);
    expect(await f.complete()).toBe(true);
    expect(await f.complete()).toBe(true);
    expect(await f.task()).toMatchObject({ done: true, completionPullRequest: { repoUrl, issueNumber: 7, ...pullRequest } });
    expect((await f.t.query(api.projects.get, f.scope)).openIssueCount).toBe(0);
    expect(await f.t.run(ctx => ctx.db.query("taskCompletions").collect())).toHaveLength(1);
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: f.taskId, done: false });
    expect((await f.task()).completionPullRequest).toBeUndefined();
    expect(await f.complete()).toBe(true);
    expect((await f.task()).done).toBe(true);
    expect(await f.t.run(ctx => ctx.db.query("taskCompletions").collect())).toHaveLength(1);
  });

  test("Draft issues do not retain receipts, and stale repositories or mismatched issue numbers cannot complete", async () => {
    const f = await fixture();
    await f.link("open", 1000);
    await f.t.mutation(api.tasks.moveTask, { ...f.scope, taskId: f.taskId, columnId: f.columns[0]!._id });
    expect(await f.complete()).toBe(false);
    expect((await f.task()).done).toBe(false);
    expect((await f.task()).completionPullRequest).toBeUndefined();
    await f.t.mutation(api.tasks.moveTask, { ...f.scope, taskId: f.taskId, columnId: f.columns[1]!._id });
    await f.link("closed", 2000);
    await expect(f.t.mutation(internal.integrations.completeMergedIssue, { ...f.completion, issueNumber: 8 })).rejects.toThrow("Issue");
    await expect(f.t.mutation(internal.integrations.completeMergedIssue, { ...f.completion, repoUrl: "https://github.com/other/project" })).rejects.toThrow("Repository");
    await expect(f.t.mutation(internal.integrations.completeMergedIssue, { ...f.completion, pullRequest: { ...pullRequest, headSha: "invalid" } })).rejects.toThrow("merge");
    expect((await f.task()).done).toBe(false);
  });

  test("a merge receipt recorded before GitHub closes the issue completes it once GitHub does", async () => {
    const f = await fixture();
    await f.link("open", 1000);
    expect(await f.complete()).toBe(false);
    expect(await f.task()).toMatchObject({ done: false, completionPullRequest: { number: pullRequest.number } });
    await f.link("closed", 2000);
    expect((await f.task()).done).toBe(true);
    await f.link("closed", 2000);
    expect(await f.t.run(ctx => ctx.db.query("taskCompletions").collect())).toHaveLength(1);
    expect((await f.t.query(api.projects.get, f.scope)).openIssueCount).toBe(0);
  });

  test("a pending receipt cannot authorize completion in a replacement repository", async () => {
    const f = await fixture();
    await f.link("open", 1000);
    expect(await f.complete()).toBe(false);
    await f.t.mutation(api.projects.update, { ...f.scope, repoUrl: "https://github.com/fixture/replacement" });
    await expect(f.link("closed", 2000)).rejects.toThrow("Repository changed");
    await expect(f.complete()).rejects.toThrow("Repository changed");
    expect((await f.task()).done).toBe(false);
  });

  test("an externally reopened issue drops its receipt and a later GitHub close completes it again", async () => {
    const f = await fixture();
    await f.link("closed", 1000);
    expect(await f.complete()).toBe(true);
    await f.link("open", 2000);
    expect(await f.task()).toMatchObject({ done: false, githubIssueState: "open" });
    expect((await f.task()).completionPullRequest).toBeUndefined();
    await f.link("closed", 3000);
    expect((await f.task()).done).toBe(true);
    expect((await f.task()).completionPullRequest).toBeUndefined();
    expect((await f.t.query(api.projects.get, f.scope)).openIssueCount).toBe(0);
    expect(await f.t.run(ctx => ctx.db.query("taskCompletions").collect())).toHaveLength(1);
  });

  test("an explicit reopen sets an intent that clears once GitHub reports open", async () => {
    const f = await fixture();
    await f.link("closed", 1000);
    await f.complete();
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: f.taskId, done: false });
    expect(await f.task()).toMatchObject({ done: false, githubIssueReopenRequested: true });
    const context = JSON.parse(await f.t.query(internal.integrations.context, { projectId: f.scope.projectId, taskId: f.taskId }));
    expect(context.task.githubIssueReopenRequested).toBe(true);
    await f.link("open", 2000);
    expect((await f.task()).githubIssueReopenRequested).toBeUndefined();
  });

  test("leaving Draft by movement or column deletion explicitly requests reopening", async () => {
    const f = await fixture();
    await f.link("closed", 1000);
    await f.t.mutation(api.tasks.moveTask, { ...f.scope, taskId: f.taskId, columnId: f.columns[0]!._id });
    expect((await f.task()).githubIssueReopenRequested).toBeUndefined();
    await f.t.mutation(api.tasks.moveTask, { ...f.scope, taskId: f.taskId, columnId: f.columns[1]!._id });
    expect((await f.task()).githubIssueReopenRequested).toBe(true);
    await f.link("open", 2000);
    await f.t.mutation(api.tasks.moveTask, { ...f.scope, taskId: f.taskId, columnId: f.columns[0]!._id });
    await f.link("closed", 3000);
    await f.t.mutation(api.tasks.deleteColumn, { ...f.scope, columnId: f.columns[0]!._id, moveToColumnId: f.columns[1]!._id });
    expect((await f.task()).githubIssueReopenRequested).toBe(true);
  });

  test("legacy snapshot reopening clears trusted completion evidence before a later GitHub close", async () => {
    const f = await fixture();
    await f.link("closed", 1000);
    await f.complete();
    await f.t.mutation(internal.github.upsertRepoSnapshot, { ...f.scope, repoUrl, issues: [{ number: 7, title: "Reopened elsewhere", state: "open", url: `${repoUrl}/issues/7`, updatedAt: 2000 }], pullRequests: [] });
    expect(await f.task()).toMatchObject({ done: false, githubIssueState: "open" });
    expect((await f.task()).completionPullRequest).toBeUndefined();
    expect((await f.task()).githubIssueReopenRequested).toBeUndefined();
    await f.link("closed", 3000);
    expect(await f.task()).toMatchObject({ done: true });
    expect((await f.task()).completionPullRequest).toBeUndefined();
  });

  test("the signed HTTP bridge rejects unsigned receipts and dispatches a valid receipt", async () => {
    const f = await fixture();
    await f.link("closed", 1000);
    const secret = "merge-fixture-only-".repeat(3);
    vi.stubEnv("ORIGIN_INTEGRATION_SECRET", secret);
    const body = JSON.stringify({ at: Date.now(), operation: "completeMergedIssue", args: f.completion });
    expect((await f.t.fetch("/integrations", { method: "POST", body })).status).toBe(401);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), byte => byte.toString(16).padStart(2, "0")).join("");
    const response = await f.t.fetch("/integrations", { method: "POST", body, headers: { "x-origin-signature": signature } });
    expect(response.status).toBe(200);
    expect(await response.json()).toBe(true);
    expect((await f.task()).done).toBe(true);
  });
});
