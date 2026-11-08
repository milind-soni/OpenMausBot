import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { canEdit, changeOpenIssueCount, requireAdmin, requireMember, touchProject } from "./lib/permissions";
import { recordCompletion } from "./lib/completions";
import { agentsTables } from "./agentsTables";
import { internal } from "./_generated/api";
import { reserveTaskBranch } from "./lib/taskBranches";
import { enqueueIssue } from "./githubLifecycle";

export const prState = v.union(v.literal("draft"), v.literal("open"), v.literal("closed"), v.literal("merged"));
export const snapshot = v.object({ number: v.number(), url: v.string(), branch: v.string(), headSha: v.string(), baseSha: v.string(), state: prState, checks: v.string(), review: v.string(), mergeable: v.union(v.boolean(), v.null()), githubUpdatedAt: v.number() });
const taskPullRequestsDoc = v.object({ ...agentsTables.taskPullRequests.validator.fields, _id: v.id("taskPullRequests"), _creationTime: v.number() });
export const repoName = (url?: string) => url?.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();

async function reviewColumn(ctx: QueryCtx | MutationCtx, project: Doc<"projects">) {
  if (project.githubReviewColumnId === null) return null;
  const column = project.githubReviewColumnId ? await ctx.db.get(project.githubReviewColumnId) : null;
  if (!column || column.projectId !== project._id || column.isDone || /^done$/i.test(column.title.trim())) throw new ConvexError("Configure an active PR review column, or explicitly disable review movement in project settings");
  return column;
}

export const configure = mutation({
  args: { sessionToken: v.string(), projectId: v.id("projects"), mode: v.union(v.literal("issue"), v.literal("pull_request")), reviewColumnId: v.optional(v.union(v.id("columns"), v.null())), doneColumnId: v.optional(v.id("columns")) }, returns: v.null(),
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.projectId, a.sessionToken);
    for (const id of [a.reviewColumnId, a.doneColumnId]) if (id && (await ctx.db.get(id))?.projectId !== a.projectId) throw new ConvexError("Column not found");
    if (a.reviewColumnId) {
      const review = (await ctx.db.get(a.reviewColumnId))!;
      if (review.isDone || /^done$/i.test(review.title.trim())) throw new ConvexError("The review column must be an active workflow column");
    }
    await ctx.db.patch(a.projectId, { githubTaskMode: a.mode, githubReviewColumnId: a.reviewColumnId, githubDoneColumnId: a.doneColumnId });
    return null;
  },
});
export const columns = query({
  args: { sessionToken: v.string(), projectId: v.id("projects") }, returns: v.array(v.object({ id: v.id("columns"), title: v.string(), isDone: v.boolean() })),
  handler: async (ctx, a) => { await requireMember(ctx, a.projectId, a.sessionToken); return (await ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", a.projectId)).take(100)).map(c => ({ id: c._id, title: c.title, isDone: Boolean(c.isDone || /^done$/i.test(c.title.trim())) })); },
});
export const list = query({
  args: { sessionToken: v.string(), taskId: v.id("tasks") }, returns: v.array(taskPullRequestsDoc),
  handler: async (ctx, a) => {
    const task = await ctx.db.get(a.taskId); if (!task) throw new ConvexError("Issue not found");
    await requireMember(ctx, task.projectId, a.sessionToken);
    return ctx.db.query("taskPullRequests").withIndex("by_taskId", q => q.eq("taskId", task._id)).take(50);
  },
});

// Authenticated Next adapter only. It never returns any GitHub credential.
export const humanContext = internalMutation({
  args: { sessionToken: v.string(), projectId: v.id("projects"), taskId: v.id("tasks"), choosePR: v.optional(v.boolean()) }, returns: v.string(),
  handler: async (ctx, a) => {
    const { project, member, user } = await requireMember(ctx, a.projectId, a.sessionToken);
    if (!canEdit(member)) throw new ConvexError("You have view-only access");
    const task = await ctx.db.get(a.taskId);
    if (!task || task.projectId !== project._id) throw new ConvexError("Issue not found");
    if (!project.repoUrl || !project.githubWorkspaceAccess || project.status !== "active") throw new ConvexError("Authorize this active project's repository first");
    await reviewColumn(ctx, project);
    const existingPR = await ctx.db.query("taskPullRequests").withIndex("by_taskId", q => q.eq("taskId", task._id)).first();
    const branch = await reserveTaskBranch(ctx, task);
    if (a.choosePR) await ctx.db.patch(task._id, { githubTaskMode: "pull_request", githubTaskBranch: branch });
    return JSON.stringify({ project, task: { ...task, githubTaskBranch: branch }, existingPR, requesterUserId: user._id });
  },
});

export async function applySnapshot(ctx: MutationCtx, row: Doc<"taskPullRequests">, s: typeof snapshot.type, sequence: number) {
  const project = await ctx.db.get(row.projectId), task = await ctx.db.get(row.taskId);
  if (!project || !task || task.projectId !== project._id || repoName(project.repoUrl) !== repoName(row.url.split("/pull/")[0])) return false;
  if (s.url !== row.url || s.number !== row.number || s.branch !== row.branch || !/^[a-f0-9]{40,64}$/i.test(s.headSha) || !/^[a-f0-9]{40,64}$/i.test(s.baseSha) || !Number.isFinite(s.githubUpdatedAt)) throw new ConvexError("Invalid PR snapshot");
  if (sequence < Math.max(row.appliedSequence ?? 0, row.syncSequence ?? 0) || s.githubUpdatedAt < (row.githubUpdatedAt ?? 0) || (row.state === "merged" && s.state !== "merged")) return false;
  // Sequence orders same-second head/review/check changes as well as lifecycle events.
  const columns = await ctx.db.query("columns").withIndex("by_project", q => q.eq("projectId", project._id)).take(100);
  let previousColumnId = row.previousColumnId;
  let columnId = task.columnId;
  const active = s.state === "open" || s.state === "draft";
  const review = active ? await reviewColumn(ctx, project) : null;
  const wasActive = row.state === "open" || row.state === "draft";
  if (active && (!row.githubUpdatedAt || !wasActive)) { previousColumnId = !row.githubUpdatedAt && row.previousColumnId ? row.previousColumnId : task.columnId; if (review) columnId = review._id; }
  if (s.state === "closed" && wasActive && previousColumnId && columns.some(c => c._id === previousColumnId)) columnId = previousColumnId;
  const newlyMerged = s.state === "merged" && row.state !== "merged";
  const done = newlyMerged ? true : task.done;
  if (newlyMerged) {
    let doneColumn = columns.find(c => c._id === project.githubDoneColumnId) ?? columns.find(c => c.isDone || /^done$/i.test(c.title.trim()));
    if (!doneColumn) {
      const id = await ctx.db.insert("columns", { projectId: project._id, title: "Done", isDone: true, order: Math.max(-1, ...columns.map(c => c.order)) + 1, createdAt: Date.now(), updatedAt: Date.now() });
      doneColumn = (await ctx.db.get(id))!;
    }
    columnId = doneColumn._id;
    await recordCompletion(ctx, task, true, s.githubUpdatedAt);
  }
  if (task.done !== done) await changeOpenIssueCount(ctx, project._id, done ? -1 : 1);
  if (task.githubTaskMode !== "pull_request" || task.done !== done || task.columnId !== columnId) {
    await ctx.db.patch(task._id, { githubTaskMode: "pull_request", done, columnId, updatedAt: Date.now() });
    if (task.done !== done) await enqueueIssue(ctx, (await ctx.db.get(task._id))!);
    await touchProject(ctx, project._id);
  }
  await ctx.db.patch(row._id, { ...s, repository: repoName(s.url.split("/pull/")[0]), previousColumnId, appliedSequence: sequence, updatedAt: Date.now() });
  return true;
}

export const finalize = internalMutation({
  args: { sessionToken: v.string(), projectId: v.id("projects"), taskId: v.id("tasks"), snapshot }, returns: v.string(),
  handler: async (ctx, a) => {
    const access = await requireMember(ctx, a.projectId, a.sessionToken);
    if (!canEdit(access.member)) throw new ConvexError("You have view-only access");
    const requesterUserId = access.user._id;
    const task = await ctx.db.get(a.taskId), project = await ctx.db.get(a.projectId);
    if (!task || task.projectId !== a.projectId || !project?.githubWorkspaceAccess || repoName(project.repoUrl) !== repoName(a.snapshot.url.split("/pull/")[0])) throw new ConvexError("This issue belongs to another repository");
    let old = await ctx.db.query("taskPullRequests").withIndex("by_projectId_and_number", q => q.eq("projectId", a.projectId).eq("number", a.snapshot.number)).unique();
    if (old && (old.taskId !== task._id || old.url !== a.snapshot.url || old.branch !== a.snapshot.branch)) throw new ConvexError("PR linkage collision");
    // One lifecycle driver per task: avoid competing PRs completing/reopening a task.
    const existing = await ctx.db.query("taskPullRequests").withIndex("by_taskId", q => q.eq("taskId", task._id)).first();
    if (existing && existing._id !== old?._id) throw new ConvexError("This issue already has a pull request");
    if (!old) {
      const id = await ctx.db.insert("taskPullRequests", { repository: repoName(a.snapshot.url.split("/pull/")[0]), projectId: a.projectId, taskId: task._id, requesterUserId, number: a.snapshot.number, url: a.snapshot.url, branch: a.snapshot.branch, state: "draft", checks: "unknown", review: "unknown", updatedAt: Date.now() });
      old = (await ctx.db.get(id))!;
    }
    await applySnapshot(ctx, old, a.snapshot, (old.syncSequence ?? 0) + 1);
    return JSON.stringify({ id: old._id, status: "opened", number: old.number, url: old.url, state: a.snapshot.state });
  },
});

export const targets = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), state: v.union(v.literal("draft"), v.literal("open"), v.literal("closed")) }, returns: v.string(),
  handler: async (ctx, a) => {
    const page = await ctx.db.query("taskPullRequests").withIndex("by_state", q => q.eq("state", a.state)).paginate({ cursor: a.cursor, numItems: 10 });
    return JSON.stringify({ rows: page.page, nextCursor: page.isDone ? null : page.continueCursor });
  },
});
export const eventTargets = internalQuery({
  args: { repoUrl: v.string(), numbers: v.array(v.number()), headSha: v.optional(v.string()) }, returns: v.array(taskPullRequestsDoc),
  handler: async (ctx, a) => {
    const result: Doc<"taskPullRequests">[] = [];
    const candidates: Doc<"taskPullRequests">[] = [];
    const repository = repoName(a.repoUrl);
    for (const number of [...new Set(a.numbers)].slice(0, 100)) candidates.push(...await ctx.db.query("taskPullRequests").withIndex("by_repository_and_number", q => q.eq("repository", repository).eq("number", number)).take(100));
    // GitHub sometimes omits pull_requests in check events. The stored head index
    // still locates affected tasks; reconciliation catches unlinked/new heads.
    if (a.headSha) candidates.push(...await ctx.db.query("taskPullRequests").withIndex("by_repository_and_headSha", q => q.eq("repository", repository).eq("headSha", a.headSha)).take(100));
    // Additive rollout: don't silently acknowledge a delivery while a large legacy
    // set is still being indexed. The bounded cron drains it before retry.
    const legacy = await ctx.db.query("taskPullRequests").withIndex("by_repository_and_number", q => q.eq("repository", undefined)).take(101);
    if (legacy.length > 100) throw new ConvexError("PR repository backfill pending; retry delivery");
    candidates.push(...legacy.filter(row => a.numbers.includes(row.number) || Boolean(a.headSha && row.headSha === a.headSha)));
    for (const row of candidates) {
      if (result.some(r => r._id === row._id) || repoName(row.url.split("/pull/")[0]) !== repoName(a.repoUrl)) continue;
      const project = await ctx.db.get(row.projectId);
      if (project && repoName(project.repoUrl) === repoName(a.repoUrl)) result.push(row);
    }
    return result;
  },
});
export const backfillRepositories = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const rows = await ctx.db.query("taskPullRequests").withIndex("by_repository_and_number", q => q.eq("repository", undefined)).take(100);
    for (const row of rows) await ctx.db.patch(row._id, { repository: repoName(row.url.split("/pull/")[0]) ?? "" });
    if (rows.length === 100) await ctx.scheduler.runAfter(0, internal.taskPRs.backfillRepositories, {});
    return null;
  },
});
export const beginSync = internalMutation({
  args: { id: v.id("taskPullRequests") }, returns: v.union(v.number(), v.null()),
  handler: async (ctx, a) => { const row = await ctx.db.get(a.id); if (!row) return null; const n = Math.max(row.syncSequence ?? 0, row.appliedSequence ?? 0) + 1; await ctx.db.patch(a.id, { syncSequence: n }); return n; },
});
export const sync = internalMutation({
  args: { id: v.id("taskPullRequests"), sequence: v.number(), snapshot }, returns: v.boolean(),
  handler: async (ctx, a) => { const row = await ctx.db.get(a.id); return row ? applySnapshot(ctx, row, a.snapshot, a.sequence) : false; },
});
export const delivery = internalMutation({
  args: { deliveryId: v.string(), fingerprint: v.string(), finishLease: v.optional(v.number()) }, returns: v.union(v.number(), v.null()),
  handler: async (ctx, a) => {
    if (!/^[\w-]{1,200}$/.test(a.deliveryId) || !/^[a-f0-9]{64}$/.test(a.fingerprint)) throw new ConvexError("Invalid delivery");
    const old = await ctx.db.query("githubDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", a.deliveryId)).unique();
    if (old && old.fingerprint !== a.fingerprint) throw new ConvexError("Delivery payload collision");
    if (a.finishLease !== undefined) { if (old?.lease === a.finishLease) await ctx.db.patch(old._id, { state: "done" }); return null; }
    if (old?.state === "done") return null;
    if (old && old.lease > Date.now() - 90000) throw new ConvexError("Delivery already processing; retry after its lease expires");
    const lease = Date.now();
    if (old) await ctx.db.patch(old._id, { state: "processing", lease });
    else await ctx.db.insert("githubDeliveries", { deliveryId: a.deliveryId, fingerprint: a.fingerprint, state: "processing", lease, expiresAt: Date.now() + 30 * 86400000 });
    return lease;
  },
});
export const cleanup = internalMutation({
  args: {}, returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const expired = await ctx.db.query("githubDeliveries").withIndex("by_expiresAt", q => q.lt("expiresAt", Date.now())).take(200);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === 200) await ctx.scheduler.runAfter(0, internal.taskPRs.cleanup, {});
    return null;
  },
});
