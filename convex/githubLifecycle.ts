import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { canEdit, changeOpenIssueCount, requireMember, touchProject } from "./lib/permissions";
import { recordCompletion } from "./lib/completions";
import { ensureDraftColumn } from "./lib/columns";
import { repositoryUrl } from "./lib/repository";
import { deleteTaskRecord } from "./tasks";

const NEVER = Number.MAX_SAFE_INTEGER;
const canonical = (url?: string) => repositoryUrl(url)?.toLowerCase();
const workFor = (ctx: MutationCtx, taskId: Id<"tasks">) => ctx.db.query("githubIssueWork").withIndex("by_taskId", q => q.eq("taskId", taskId)).unique();

/** Called in the same transaction as every user-visible issue change, including deletion. */
export async function enqueueIssue(ctx: MutationCtx, task: Doc<"tasks">, deleted = false, wake = true): Promise<void> {
  const project = await ctx.db.get(task.projectId);
  const existing = await workFor(ctx, task._id);
  const repoUrl = existing?.repoUrl || canonical(task.githubIssueUrl?.split("/issues/")[0]) || canonical(project?.repoUrl);
  if (!repoUrl) return;
  const now = Date.now();
  const fields = { title: task.title, description: task.description || "", done: task.done, deleted,
    revision: (existing?.revision ?? 0) + 1, state: "pending" as const, error: undefined, updatedAt: now,
    // Do not invalidate an active lease: its result must attach any remotely created issue before the next revision runs.
    nextAt: existing?.leaseUntil && existing.leaseUntil > now ? existing.leaseUntil : now };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("githubIssueWork", { ...fields, projectId: task.projectId, taskId: task._id, repoUrl,
    repoId: task.githubIssueRepoId ?? project?.githubRepoId, number: task.githubIssueNumber, nodeId: task.githubIssueNodeId, attempts: 0 });
  if (!deleted) await ctx.db.patch(task._id, { githubSyncState: "pending", githubSyncError: undefined });
  if (wake) await ctx.scheduler.runAfter(0, internal.integrations.kick, {});
}

export const status = query({
  args: { sessionToken: v.string(), projectId: v.id("projects") },
  handler: async (ctx, a) => {
    await requireMember(ctx, a.projectId, a.sessionToken);
    const rows = await ctx.db.query("githubIssueWork").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", a.projectId)).order("desc").take(100);
    return rows.map(({ taskId, title, deleted, state, error, updatedAt }) => ({ taskId, title, deleted, state, error, updatedAt }));
  },
});
export const retry = mutation({
  args: { sessionToken: v.string(), projectId: v.id("projects"), taskId: v.id("tasks") }, returns: v.null(),
  handler: async (ctx, a) => {
    const { member } = await requireMember(ctx, a.projectId, a.sessionToken);
    if (!canEdit(member)) throw new ConvexError("You have view-only access");
    const row = await workFor(ctx, a.taskId), task = await ctx.db.get(a.taskId);
    if (row && row.projectId !== a.projectId || task && task.projectId !== a.projectId) throw new ConvexError("Issue not found");
    if (task) await enqueueIssue(ctx, task);
    else if (row?.deleted) {
      await ctx.db.patch(row._id, { nextAt: Math.max(Date.now(), row.leaseUntil || 0), state: "pending", error: undefined });
      await ctx.scheduler.runAfter(0, internal.integrations.kick, {});
    } else throw new ConvexError("Issue not found");
    return null;
  },
});
export const claim = internalMutation({
  args: { taskId: v.optional(v.id("tasks")) }, returns: v.string(),
  handler: async (ctx, a) => {
    const now = Date.now();
    const row = a.taskId ? await workFor(ctx, a.taskId) : await ctx.db.query("githubIssueWork").withIndex("by_nextAt", q => q.lte("nextAt", now)).first();
    if (!row || row.nextAt > now || (row.leaseUntil || 0) > now) return JSON.stringify(null);
    const lease = crypto.randomUUID(), leaseUntil = now + 90000;
    await ctx.db.patch(row._id, { lease, leaseUntil, nextAt: leaseUntil, state: "syncing", attempts: row.attempts + 1 });
    const task = await ctx.db.get(row.taskId);
    if (task) await ctx.db.patch(task._id, { githubSyncState: "syncing", githubSyncError: undefined });
    return JSON.stringify({ ...row, lease, leaseUntil });
  },
});
export const start = internalMutation({
  args: { id: v.id("githubIssueWork"), lease: v.string(), repoId: v.number(), create: v.boolean() }, returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id), project = row && await ctx.db.get(row.projectId);
    if (!row || row.lease !== a.lease || (row.leaseUntil || 0) <= Date.now()) throw new ConvexError("Issue sync lease expired");
    if (!project || canonical(project.repoUrl) !== row.repoUrl || row.repoId && row.repoId !== a.repoId || project.githubRepoId && project.githubRepoId !== a.repoId) throw new ConvexError("Repository identity changed; sync stopped");
    if (!project.githubRepoId) await ctx.db.patch(project._id, { githubRepoId: a.repoId });
    const leaseUntil = Date.now() + 90000;
    await ctx.db.patch(row._id, { repoId: a.repoId, leaseUntil, nextAt: leaseUntil, ...(a.create ? { createStarted: true } : {}) });
    return null;
  },
});
export const finish = internalMutation({
  args: { id: v.id("githubIssueWork"), lease: v.string(), revision: v.number(), error: v.optional(v.string()), rejectedCreate: v.optional(v.boolean()),
    number: v.optional(v.number()), nodeId: v.optional(v.string()), updatedAt: v.optional(v.number()), searchPage: v.optional(v.number()) }, returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.lease !== a.lease) return null;
    const task = await ctx.db.get(row.taskId);
    const state = a.error ? "error" : row.revision === a.revision ? "synced" : "pending";
    const number = a.number ?? row.number, nodeId = a.nodeId ?? row.nodeId;
    const error = a.error?.slice(0, 500);
    await ctx.db.patch(row._id, { state, error, number, nodeId, lease: undefined, leaseUntil: undefined,
      searchPage: number ? undefined : a.searchPage ?? row.searchPage,
      ...(a.rejectedCreate ? { createStarted: undefined } : {}), remoteUpdatedAt: a.updatedAt ?? row.remoteUpdatedAt,
      nextAt: state === "synced" ? NEVER : state === "pending" ? Date.now() : Date.now() + Math.min(300000, 5000 * 2 ** Math.min(row.attempts, 6)), updatedAt: Date.now() });
    if (task) await ctx.db.patch(task._id, { githubSyncState: state, githubSyncError: error,
      ...(number ? { githubIssueNumber: number, githubIssueUrl: `${row.repoUrl}/issues/${number}`, githubIssueNodeId: nodeId, githubIssueRepoId: row.repoId } : {}),
      ...(!a.error && row.revision === a.revision ? { githubIssueState: row.done ? "closed" as const : "open" as const, githubIssueUpdatedAt: a.updatedAt, githubIssueSyncedAt: Date.now(), githubIssueReopenRequested: undefined } : {}) });
    return null;
  },
});

/** Bounded, restart-safe migration/reconnect sweep; includes Draft and completed issues. */
export const reconcile = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), taskId: v.optional(v.id("tasks")) }, returns: v.string(),
  handler: async (ctx, a) => {
    if (a.taskId) {
      const task = await ctx.db.get(a.taskId);
      if (task && !task.githubIssueNumber && !await workFor(ctx, task._id)) await enqueueIssue(ctx, task, false, false);
      return JSON.stringify({ nextCursor: null });
    }
    const page = await ctx.db.query("tasks").paginate({ cursor: a.cursor, numItems: 50 });
    // Existing links are first read from GitHub, not republished from a stale pre-migration snapshot.
    for (const task of page.page) if (!task.githubIssueNumber && !await workFor(ctx, task._id)) await enqueueIssue(ctx, task, false, false);
    return JSON.stringify({ nextCursor: page.isDone ? null : page.continueCursor });
  },
});
export const projects = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), repoUrl: v.optional(v.string()) }, returns: v.string(),
  handler: async (ctx, a) => {
    const page = await ctx.db.query("projects").paginate({ cursor: a.cursor, numItems: a.repoUrl ? 100 : 1 });
    return JSON.stringify({ rows: page.page.filter(p => p.repoUrl && p.status === "active" && (!a.repoUrl || canonical(p.repoUrl) === canonical(a.repoUrl))).map(p => ({ projectId: p._id, repoUrl: p.repoUrl })), nextCursor: page.isDone ? null : page.continueCursor });
  },
});
export const syncError = internalMutation({
  args: { taskId: v.optional(v.id("tasks")), projectId: v.optional(v.id("projects")), error: v.string() }, returns: v.null(),
  handler: async (ctx, a) => {
    const task = a.taskId ? await ctx.db.get(a.taskId) : null;
    if (task) await ctx.db.patch(task._id, { githubSyncState: "error", githubSyncError: a.error.slice(0, 500) });
    if (a.projectId && await ctx.db.get(a.projectId)) await ctx.db.patch(a.projectId, { githubSyncError: a.error.slice(0, 500) || undefined });
    return null;
  },
});

export const begin = internalMutation({
  args: { projectId: v.id("projects"), repoUrl: v.string(), number: v.number() }, returns: v.number(),
  handler: async (ctx, a) => {
    const url = canonical(a.repoUrl), project = await ctx.db.get(a.projectId);
    if (!url || !project || canonical(project.repoUrl) !== url) throw new ConvexError("Repository changed");
    const row = await ctx.db.query("githubIssueReads").withIndex("by_projectId_and_repoUrl_and_number", q => q.eq("projectId", a.projectId).eq("repoUrl", url).eq("number", a.number)).unique();
    const sequence = (row?.sequence || 0) + 1;
    if (row) await ctx.db.patch(row._id, { sequence });
    else await ctx.db.insert("githubIssueReads", { ...a, repoUrl: url, sequence });
    return sequence;
  },
});

export const incomingArgs = {
  projectId: v.id("projects"), repoUrl: v.string(), repoId: v.optional(v.number()), number: v.number(), nodeId: v.optional(v.string()),
  title: v.optional(v.string()), description: v.optional(v.string()), state: v.union(v.literal("open"), v.literal("closed"), v.literal("deleted")),
  updatedAt: v.number(), taskId: v.optional(v.id("tasks")),
  sequence: v.optional(v.number()), importOnly: v.optional(v.boolean()),
};
type Incoming = { projectId: Id<"projects">; repoUrl: string; repoId?: number; number: number; nodeId?: string; title?: string; description?: string; state: "open" | "closed" | "deleted"; updatedAt: number; taskId?: Id<"tasks">; sequence?: number; importOnly?: boolean };
export async function applyIncoming(ctx: MutationCtx, a: Incoming): Promise<Id<"tasks"> | null> {
  const project = await ctx.db.get(a.projectId), url = canonical(a.repoUrl);
  if (!project || !url || canonical(project.repoUrl) !== url || project.githubRepoId && a.repoId && project.githubRepoId !== a.repoId) throw new ConvexError("Repository identity changed; sync stopped");
  if (!Number.isSafeInteger(a.number) || a.number < 1 || !Number.isFinite(a.updatedAt)) throw new ConvexError("Invalid GitHub issue");
  if (!project.githubRepoId && a.repoId) await ctx.db.patch(project._id, { githubRepoId: a.repoId });
  const read = await ctx.db.query("githubIssueReads").withIndex("by_projectId_and_repoUrl_and_number", q => q.eq("projectId", a.projectId).eq("repoUrl", url).eq("number", a.number)).unique();
  if (a.sequence !== undefined && (!read || read.sequence !== a.sequence)) return null;
  if (read?.deletedNodeId && a.state !== "deleted") return null;
  if (a.state === "deleted") {
    if (!a.nodeId) throw new ConvexError("A verified issue node identity is required for deletion");
    if (read) await ctx.db.patch(read._id, { deletedNodeId: a.nodeId });
    else await ctx.db.insert("githubIssueReads", { projectId: a.projectId, repoUrl: url, number: a.number, sequence: 0, deletedNodeId: a.nodeId });
  }
  if (a.taskId) {
    const existing = await workFor(ctx, a.taskId);
    if (existing && (existing.projectId !== a.projectId || existing.repoUrl !== url || existing.repoId && a.repoId && existing.repoId !== a.repoId || existing.number && existing.number !== a.number || existing.nodeId && a.nodeId && existing.nodeId !== a.nodeId)) throw new ConvexError("Issue marker belongs to a different repository or issue");
    if (existing?.deleted) {
      await ctx.db.patch(existing._id, { number: a.number, nodeId: a.nodeId, ...(a.state === "deleted" ? { state: "synced", nextAt: NEVER, lease: undefined, leaseUntil: undefined } : {}) });
      return null;
    }
  }
  const tombstone = await ctx.db.query("githubIssueWork").withIndex("by_repoUrl_and_number", q => q.eq("repoUrl", url).eq("number", a.number)).take(100);
  const removed = tombstone.find(row => row.projectId === a.projectId && row.deleted);
  if (removed) {
    if (a.state === "deleted") await ctx.db.patch(removed._id, { state: "synced", error: undefined, nextAt: NEVER, lease: undefined, leaseUntil: undefined });
    return null;
  }
  let task = a.taskId ? await ctx.db.get(a.taskId) : await ctx.db.query("tasks").withIndex("by_project_githubIssueNumber", q => q.eq("projectId", a.projectId).eq("githubIssueNumber", a.number)).unique();
  if (task && (task.projectId !== a.projectId || task.githubIssueNumber && task.githubIssueNumber !== a.number || task.githubIssueUrl && canonical(task.githubIssueUrl.split("/issues/")[0]) !== url || task.githubIssueNodeId && a.nodeId && task.githubIssueNodeId !== a.nodeId || task.githubIssueRepoId && a.repoId && task.githubIssueRepoId !== a.repoId)) throw new ConvexError("Issue linkage changed");
  if (task && a.importOnly) return null;
  if (task && a.state !== "deleted" && (task.githubIssueUpdatedAt || 0) > a.updatedAt) return null;
  if (task && a.state !== "deleted" && a.sequence === undefined && task.githubIssueUpdatedAt === a.updatedAt) return null;
  if (a.state === "deleted") {
    if (task) {
      await enqueueIssue(ctx, task, true, false);
      const work = await workFor(ctx, task._id);
      if (work) await ctx.db.patch(work._id, { state: "synced", nextAt: NEVER, lease: undefined, leaseUntil: undefined, number: a.number, nodeId: a.nodeId });
      await deleteTaskRecord(ctx, { projectId: a.projectId, taskId: task._id }, true);
    }
    return null;
  }
  if (!task) {
    if (!a.title) return null;
    const { column } = await ensureDraftColumn(ctx, a.projectId);
    const done = a.state === "closed", now = Date.now();
    const id = await ctx.db.insert("tasks", { projectId: a.projectId, teamId: project.teamId, columnId: column._id, title: a.title.slice(0, 250), description: a.description?.slice(0, 60000), done, priority: "medium", order: now, createdAt: now, updatedAt: now });
    task = (await ctx.db.get(id))!;
    await changeOpenIssueCount(ctx, a.projectId, done ? 0 : 1);
  }
  const work = await workFor(ctx, task._id);
  const matchesDesired = work && work.done === (a.state === "closed") && (a.title === undefined || a.title === work.title) && (a.description === undefined || a.description === work.description);
  const localPending = work && work.state !== "synced" && !matchesDesired;
  const done = localPending ? task.done : a.state === "closed";
  if (done !== task.done) { await recordCompletion(ctx, task, done, a.updatedAt); await changeOpenIssueCount(ctx, a.projectId, done ? -1 : 1); }
  await ctx.db.patch(task._id, { githubIssueNumber: a.number, githubIssueUrl: `${url}/issues/${a.number}`, githubIssueNodeId: a.nodeId ?? task.githubIssueNodeId, githubIssueRepoId: a.repoId ?? task.githubIssueRepoId,
    githubIssueState: a.state, githubIssueUpdatedAt: a.updatedAt, githubIssueSyncedAt: Date.now(),
    ...(!localPending ? { done, ...(a.title !== undefined ? { title: a.title.slice(0, 250) } : {}), ...(a.description !== undefined ? { description: a.description.slice(0, 60000) || undefined } : {}), githubSyncState: "synced" as const, githubSyncError: undefined, githubIssueReopenRequested: undefined, ...(!done ? { completionPullRequest: undefined } : {}) } : {}), updatedAt: Date.now() });
  if (work) await ctx.db.patch(work._id, { number: a.number, nodeId: a.nodeId ?? work.nodeId, repoId: a.repoId ?? work.repoId, remoteUpdatedAt: a.updatedAt,
    ...(!localPending ? { state: "synced", error: undefined, nextAt: NEVER, title: a.title ?? task.title, description: a.description ?? task.description ?? "", done } : {}) });
  else await ctx.db.insert("githubIssueWork", { projectId: a.projectId, taskId: task._id, repoUrl: url, repoId: a.repoId, number: a.number, nodeId: a.nodeId, title: a.title ?? task.title, description: a.description ?? "", done, deleted: false, revision: 1, state: "synced", attempts: 0, nextAt: NEVER, updatedAt: Date.now(), remoteUpdatedAt: a.updatedAt });
  await touchProject(ctx, a.projectId);
  return task._id;
}
export const incoming = internalMutation({ args: incomingArgs, handler: applyIncoming });
