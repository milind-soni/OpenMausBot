import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canEdit, changeOpenIssueCount, getActiveTeamMember, requireAdmin, requireMember, touchProject } from "./lib/permissions";
import { recordCompletion } from "./lib/completions";
import { agentsTables } from "./agentsTables";
import { internal } from "./_generated/api";
import { reserveTaskBranch } from "./lib/taskBranches";
import { issueStatusChanged } from "./lib/issueEvents";
import { issueKey, pullRequestReferences, textReferences, type IssueReference } from "../lib/github-references";

export const prState = v.union(v.literal("draft"), v.literal("open"), v.literal("closed"), v.literal("merged"));
export const snapshot = v.object({ number: v.number(), url: v.string(), branch: v.string(), headSha: v.string(), baseSha: v.string(), state: prState, checks: v.string(), review: v.string(), mergeable: v.union(v.boolean(), v.null()), githubUpdatedAt: v.number() });
const taskPullRequestsDoc = v.object({ ...agentsTables.taskPullRequests.validator.fields, _id: v.id("taskPullRequests"), _creationTime: v.number() });
export const repoName = (url?: string) => url?.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();

/**
 * The column an issue moves to while its pull request is open. Strict for PRs opened from Origin (the project must
 * configure it); lenient for PRs found through a reference, which never block on project settings.
 */
async function reviewColumn(ctx: QueryCtx | MutationCtx, project: Doc<"projects">, lenient = false) {
  if (project.githubReviewColumnId === null) return null;
  const column = project.githubReviewColumnId ? await ctx.db.get(project.githubReviewColumnId) : null;
  if (!column || column.projectId !== project._id || column.isDone || /^done$/i.test(column.title.trim())) {
    if (lenient) return null;
    throw new ConvexError("Configure an active PR review column, or explicitly disable review movement in project settings");
  }
  return column;
}

/** Completes an issue from GitHub (a merged PR or a closing commit) and moves it to the project's Done column. */
async function completeFromGitHub(ctx: MutationCtx, project: Doc<"projects">, task: Doc<"tasks">, completedAt: number) {
  const columns = await ctx.db.query("columns").withIndex("by_project", q => q.eq("projectId", project._id)).take(100);
  let doneColumn = columns.find(c => c._id === project.githubDoneColumnId) ?? columns.find(c => c.isDone || /^done$/i.test(c.title.trim()));
  if (!doneColumn) {
    const id = await ctx.db.insert("columns", { projectId: project._id, title: "Done", isDone: true, order: Math.max(-1, ...columns.map(c => c.order)) + 1, createdAt: Date.now(), updatedAt: Date.now() });
    doneColumn = (await ctx.db.get(id))!;
  }
  await recordCompletion(ctx, task, true, completedAt);
  await changeOpenIssueCount(ctx, project._id, -1);
  await ctx.db.patch(task._id, { done: true, columnId: doneColumn._id, githubIssueReopenRequested: undefined, updatedAt: Date.now() });
  await issueStatusChanged(ctx, task);
  await touchProject(ctx, project._id);
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

const PR_ORDER = { open: 0, draft: 0, merged: 1, closed: 2 } as const;
export const linkedPullRequest = v.object({
  number: v.number(), url: v.string(), title: v.union(v.string(), v.null()), state: prState, repository: v.string(), branch: v.string(),
  checks: v.string(), review: v.string(), mergeable: v.union(v.boolean(), v.null()), author: v.union(v.string(), v.null()), updatedAt: v.number(),
  issues: v.array(v.object({ taskId: v.id("tasks"), key: v.string(), title: v.string(), done: v.boolean(), completesOnMerge: v.boolean() })),
});

/**
 * Pull requests linked to the project's issues, one entry per PR with every issue it is linked to: open and draft
 * first, then merged, then closed, each most recently updated first. Its state, title and checks come from the most
 * recently synced link row.
 */
export async function linkedPullRequests(ctx: QueryCtx, projectId: Id<"projects">, limit = 500): Promise<(typeof linkedPullRequest.type)[]> {
  const rows = await ctx.db.query("taskPullRequests").withIndex("by_projectId_and_number", q => q.eq("projectId", projectId)).order("desc").take(limit);
  const groups = new Map<string, Doc<"taskPullRequests">[]>();
  for (const row of rows) groups.set(row.url.toLowerCase(), [...groups.get(row.url.toLowerCase()) ?? [], row]);
  const tasks = new Map<Id<"tasks">, Doc<"tasks"> | null>();
  for (const row of rows) if (!tasks.has(row.taskId)) tasks.set(row.taskId, await ctx.db.get(row.taskId));
  const result = [...groups.values()].map(group => {
    const latest = group.reduce((a, b) => (b.githubUpdatedAt ?? b.updatedAt) > (a.githubUpdatedAt ?? a.updatedAt) ? b : a);
    return {
      number: latest.number, url: latest.url, title: group.find(row => row.title)?.title ?? null, state: latest.state,
      repository: latest.repository || repoName(latest.url.split("/pull/")[0]) || "", branch: latest.branch, checks: latest.checks, review: latest.review,
      mergeable: latest.mergeable ?? null, author: latest.authorLogin ?? null, updatedAt: latest.githubUpdatedAt ?? latest.updatedAt,
      issues: group.flatMap(row => {
        const task = tasks.get(row.taskId);
        return task && task.projectId === projectId ? [{ taskId: task._id, key: issueKey(task._id), title: task.title, done: task.done, completesOnMerge: row.closes !== false }] : [];
      }),
    };
  }).filter(pr => pr.issues.length);
  return result.sort((a, b) => PR_ORDER[a.state] - PR_ORDER[b.state] || b.updatedAt - a.updatedAt);
}

/** The project's Pull requests section, with what a linked PR does to its issues. */
export const projectPullRequests = query({
  args: { sessionToken: v.string(), projectId: v.id("projects") },
  returns: v.object({ pullRequests: v.array(linkedPullRequest), reviewColumn: v.union(v.string(), v.null()), doneColumn: v.string() }),
  handler: async (ctx, a) => {
    const { project } = await requireMember(ctx, a.projectId, a.sessionToken);
    const review = project.githubReviewColumnId ? await ctx.db.get(project.githubReviewColumnId) : null;
    const done = project.githubDoneColumnId ? await ctx.db.get(project.githubDoneColumnId) : null;
    return {
      pullRequests: await linkedPullRequests(ctx, project._id),
      reviewColumn: review?.projectId === project._id ? review.title : null,
      doneColumn: done?.projectId === project._id ? done.title : "Done",
    };
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

/**
 * Applies what GitHub says about a pull request to its row and, on lifecycle transitions only, to the issue:
 * - opened/reopened: the issue moves to the review column (when the project has one);
 * - closed without merging: it returns to the column it came from, if it is still in the review column;
 * - merged: it completes, when the link closes it (branch, title or closing keyword; PRs opened from Origin always do).
 * Check, review and head updates never move or reopen an issue, so a person's manual change stays.
 * Out-of-order and duplicate deliveries are rejected by GitHub's updated_at and the per-row sync sequence; merged is final.
 */
export async function applySnapshot(ctx: MutationCtx, row: Doc<"taskPullRequests">, s: typeof snapshot.type, sequence: number) {
  const project = await ctx.db.get(row.projectId), task = await ctx.db.get(row.taskId);
  if (!project || !task || task.projectId !== project._id || repoName(project.repoUrl) !== repoName(row.url.split("/pull/")[0])) return false;
  if (s.url !== row.url || s.number !== row.number || s.branch !== row.branch || !/^[a-f0-9]{40,64}$/i.test(s.headSha) || !/^[a-f0-9]{40,64}$/i.test(s.baseSha) || !Number.isFinite(s.githubUpdatedAt)) throw new ConvexError("Invalid PR snapshot");
  if (sequence < Math.max(row.appliedSequence ?? 0, row.syncSequence ?? 0) || s.githubUpdatedAt < (row.githubUpdatedAt ?? 0) || (row.state === "merged" && s.state !== "merged")) return false;
  const reference = row.linkSource === "reference";
  const firstSync = !row.githubUpdatedAt;
  const active = s.state === "open" || s.state === "draft";
  const wasActive = !firstSync && (row.state === "open" || row.state === "draft");
  let previousColumnId = row.previousColumnId;
  let columnId = task.columnId;
  if (active && !wasActive) {
    const review = await reviewColumn(ctx, project, reference);
    previousColumnId = firstSync && row.previousColumnId ? row.previousColumnId : task.columnId;
    if (review && !task.done) columnId = review._id;
  }
  if (s.state === "closed" && wasActive && previousColumnId && task.columnId === project.githubReviewColumnId && previousColumnId !== task.columnId) {
    const previous = await ctx.db.get(previousColumnId);
    if (previous?.projectId === project._id) columnId = previousColumnId;
  }
  const justMerged = s.state === "merged" && (firstSync || row.state !== "merged");
  if (justMerged && row.closes !== false && !task.done) {
    await completeFromGitHub(ctx, project, task, s.githubUpdatedAt);
    if (!reference && task.githubTaskMode !== "pull_request") await ctx.db.patch(task._id, { githubTaskMode: "pull_request" });
  } else if (columnId !== task.columnId || (!reference && task.githubTaskMode !== "pull_request")) {
    await ctx.db.patch(task._id, { ...(reference ? {} : { githubTaskMode: "pull_request" as const }), columnId, updatedAt: Date.now() });
    await issueStatusChanged(ctx, task);
    await touchProject(ctx, project._id);
  }
  // A payload-only snapshot carries no check or review result; keep the last known ones for the same head.
  const checks = s.checks === "unknown" && row.headSha === s.headSha ? row.checks : s.checks;
  const review = s.review === "unknown" ? row.review : s.review;
  await ctx.db.patch(row._id, { ...s, checks, review, repository: repoName(s.url.split("/pull/")[0]), previousColumnId, appliedSequence: sequence, updatedAt: Date.now() });
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
    if (old && (old.state === "done" || old.lease > Date.now() - 90000)) return null;
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

// Pull requests and commits that refer to Origin issues (lib/github-references.ts). The Next server receives GitHub's
// signed webhook, checks that each project's GitHub connection can read the repository, and passes only those projects.

/** Active projects whose approved repository is this one; the Next server verifies repository access for each. */
export const repositoryProjects = internalQuery({
  args: { repoUrl: v.string() }, returns: v.array(v.id("projects")),
  handler: async (ctx, a) => {
    const repository = repoName(a.repoUrl);
    if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new ConvexError("Invalid repository");
    let rows = await ctx.db.query("projects").withIndex("by_repoUrl", q => q.eq("repoUrl", a.repoUrl)).take(50);
    // Repository URLs keep the casing people typed; GitHub sends its canonical casing.
    if (!rows.length) rows = (await ctx.db.query("projects").withIndex("by_repoUrl", q => q.gte("repoUrl", "https://github.com/")).take(2000)).filter(p => repoName(p.repoUrl) === repository);
    return rows.filter(p => p.status === "active" && p.githubWorkspaceAccess && repoName(p.repoUrl) === repository).slice(0, 20).map(p => p._id);
  },
});

/** The Origin issues of a project that references point at; ambiguous issue keys are skipped. */
async function resolveReferences(ctx: MutationCtx, project: Doc<"projects">, references: IssueReference[]) {
  const found = new Map<Id<"tasks">, boolean>();
  const add = (task: Doc<"tasks"> | null | undefined, closes: boolean) => { if (task && task.projectId === project._id) found.set(task._id, (found.get(task._id) ?? false) || closes); };
  const keys = references.filter(r => r.kind === "key");
  if (keys.length) {
    const byKey = new Map<string, Doc<"tasks">[]>();
    for (const task of await ctx.db.query("tasks").withIndex("by_project", q => q.eq("projectId", project._id)).take(5000)) byKey.set(issueKey(task._id), [...byKey.get(issueKey(task._id)) ?? [], task]);
    for (const reference of keys) { const matches = byKey.get(reference.key); if (matches?.length === 1) add(matches[0], reference.closes); }
  }
  for (const reference of references) {
    if (reference.kind === "number") {
      const matches = await ctx.db.query("tasks").withIndex("by_project_githubIssueNumber", q => q.eq("projectId", project._id).eq("githubIssueNumber", reference.number)).take(2);
      if (matches.length === 1) add(matches[0], reference.closes);
    } else if (reference.kind === "id") {
      const id = ctx.db.normalizeId("tasks", reference.id);
      add(id ? await ctx.db.get(id) : null, reference.closes);
    }
  }
  return [...found].slice(0, 20);
}

async function allowedProject(ctx: MutationCtx, projectId: Id<"projects">, repository: string) {
  const project = await ctx.db.get(projectId);
  return project && project.status === "active" && project.githubWorkspaceAccess && repoName(project.repoUrl) === repository ? project : null;
}

/** Who opened the PR, when they linked their GitHub account to Origin; otherwise the workspace owner stands in. */
async function requesterFor(ctx: MutationCtx, project: Doc<"projects">, authorId?: number): Promise<Id<"users"> | null> {
  const link = authorId ? await ctx.db.query("githubUserLinks").withIndex("by_githubId", q => q.eq("githubId", authorId)).unique() : null;
  const user = link ? await ctx.db.get(link.userId) : null;
  if (user?.status === "active" && project.teamId && await getActiveTeamMember(ctx, project.teamId, user.email)) return user._id;
  const team = project.teamId ? await ctx.db.get(project.teamId) : null;
  return team?.ownerUserId ?? null;
}

/**
 * Links a pull request to the issues its branch, title and body refer to, drops links whose reference was edited
 * away (unless merged), and applies the PR state. The snapshot comes from GitHub's signed webhook payload.
 */
export const linkReferences = internalMutation({
  args: { repoUrl: v.string(), projectIds: v.array(v.id("projects")), title: v.string(), body: v.optional(v.string()), authorLogin: v.optional(v.string()), authorId: v.optional(v.number()), snapshot },
  returns: v.array(v.object({ taskId: v.id("tasks"), closes: v.boolean() })),
  handler: async (ctx, a) => {
    const repository = repoName(a.repoUrl)!;
    if (a.snapshot.url.toLowerCase() !== `https://github.com/${repository}/pull/${a.snapshot.number}`) throw new ConvexError("Invalid PR snapshot");
    const references = pullRequestReferences({ title: a.title, body: a.body, branch: a.snapshot.branch });
    const linked: { taskId: Id<"tasks">; closes: boolean }[] = [];
    for (const projectId of [...new Set(a.projectIds)].slice(0, 20)) {
      const project = await allowedProject(ctx, projectId, repository);
      if (!project) continue;
      const wanted = new Map(await resolveReferences(ctx, project, references));
      const rows = await ctx.db.query("taskPullRequests").withIndex("by_projectId_and_number", q => q.eq("projectId", project._id).eq("number", a.snapshot.number)).take(50);
      const current = rows.filter(row => repoName(row.url.split("/pull/")[0]) === repository);
      for (const row of current) {
        if (row.linkSource === "reference" && !wanted.has(row.taskId) && row.state !== "merged") { await ctx.db.delete(row._id); continue; }
        const closes = wanted.get(row.taskId);
        const title = a.title.slice(0, 250);
        if (row.linkSource === "reference" && (row.closes !== closes || row.title !== title)) await ctx.db.patch(row._id, { closes, title });
        else if (row.title !== title) await ctx.db.patch(row._id, { title });
        wanted.delete(row.taskId);
        const fresh = (await ctx.db.get(row._id))!;
        await applySnapshot(ctx, fresh, a.snapshot, Math.max(fresh.syncSequence ?? 0, fresh.appliedSequence ?? 0) + 1);
        linked.push({ taskId: row.taskId, closes: closes ?? row.closes !== false });
      }
      if (!wanted.size) continue;
      const requesterUserId = await requesterFor(ctx, project, a.authorId);
      if (!requesterUserId) continue;
      for (const [taskId, closes] of wanted) {
        const id = await ctx.db.insert("taskPullRequests", {
          repository, projectId: project._id, taskId, requesterUserId, number: a.snapshot.number, url: a.snapshot.url, branch: a.snapshot.branch,
          title: a.title.slice(0, 250), ...(a.authorLogin ? { authorLogin: a.authorLogin.slice(0, 100) } : {}),
          linkSource: "reference", closes, state: "open", checks: "unknown", review: "unknown", updatedAt: Date.now(),
        });
        await applySnapshot(ctx, (await ctx.db.get(id))!, a.snapshot, 1);
        linked.push({ taskId, closes });
      }
    }
    return linked;
  },
});

/** Completes the issues that commits pushed to the default branch close (`Closes ORI-ABCD`, `Fixes #12`). */
export const completeFromCommits = internalMutation({
  args: { repoUrl: v.string(), projectIds: v.array(v.id("projects")), commits: v.array(v.object({ message: v.string(), timestamp: v.number() })) },
  returns: v.array(v.id("tasks")),
  handler: async (ctx, a) => {
    const repository = repoName(a.repoUrl)!;
    const completed: Id<"tasks">[] = [];
    for (const projectId of [...new Set(a.projectIds)].slice(0, 20)) {
      const project = await allowedProject(ctx, projectId, repository);
      if (!project) continue;
      for (const commit of a.commits.slice(0, 100)) {
        const closing = textReferences(commit.message).filter(reference => reference.closes);
        if (!closing.length) continue;
        for (const [taskId] of await resolveReferences(ctx, project, closing)) {
          const task = await ctx.db.get(taskId);
          if (!task || task.done) continue;
          const at = Number.isFinite(commit.timestamp) && commit.timestamp > 0 && commit.timestamp <= Date.now() + 60000 ? commit.timestamp : Date.now();
          await completeFromGitHub(ctx, project, task, at);
          completed.push(taskId);
        }
      }
    }
    return completed;
  },
});
