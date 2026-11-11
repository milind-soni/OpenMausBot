import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { isDraftColumn, projectDraftStatus } from "./columns";
import { isLegacyIdeaColumn } from "../../lib/origin-columns";

// The outbox side of two-way GitHub issue sync (convex/githubIssueSync.ts). Issue writes call queueGitHubSync (or
// queueGitHubDelete before deleting); the Next worker (lib/github-sync.ts syncGitHubOutbox) drains the outbox.

/** Coalesces a burst of edits (typing a description) into one push. */
const KICK_DELAY_MS = 3000;

/** Whether an issue is in Backlog (the draft column), where it stays in Origin only. Never throws. */
export async function taskInDraft(ctx: QueryCtx, task: Doc<"tasks">) {
  const column = await ctx.db.get(task.columnId);
  if (!column || column.projectId !== task.projectId) return true;
  if (isDraftColumn(column)) return true;
  if (!isLegacyIdeaColumn(column)) return false;
  return await projectDraftStatus(ctx, task.projectId) !== "present";
}

/** Projects whose issues mirror to GitHub: active, linked to a repository an admin approved (or with a repo token). */
export async function githubSyncEnabled(ctx: QueryCtx, project: Doc<"projects"> | null): Promise<boolean> {
  if (!project?.repoUrl || (project.status && project.status !== "active")) return false;
  if (project.githubWorkspaceAccess) return true;
  return Boolean(await ctx.db.query("githubProjectConnections").withIndex("by_projectId", q => q.eq("projectId", project._id)).first());
}

/** Issues the team mirrors as draft pull requests (project Code settings) are not mirrored as GitHub issues. */
export function mirrorsAsPullRequest(task: Doc<"tasks">, project: Doc<"projects">) {
  return task.githubTaskMode === "pull_request" || (!task.githubTaskMode && project.githubTaskMode === "pull_request");
}

export async function mirrorRow(ctx: QueryCtx, taskId: Id<"tasks">) {
  return ctx.db.query("githubIssueMirrors").withIndex("by_taskId", q => q.eq("taskId", taskId)).unique();
}

async function kick(ctx: MutationCtx) {
  // Without a worker to call (tests, a deployment without the web app) the 2-minute cron tick drains the outbox.
  if (!process.env.ORIGIN_PUBLIC_URL || !process.env.ORIGIN_INTEGRATION_SECRET) return;
  await ctx.scheduler.runAfter(KICK_DELAY_MS, internal.integrations.kick, { issues: true });
}

/** Marks an issue's mirror as having changes for GitHub; wakes the worker when it was idle. */
export async function markPending(ctx: MutationCtx, projectId: Id<"projects">, taskId: Id<"tasks">, deleted?: { repoUrl: string; number: number }, wake = true) {
  const now = Date.now();
  const row = await mirrorRow(ctx, taskId);
  if (!row) {
    await ctx.db.insert("githubIssueMirrors", { projectId, taskId, pending: true, revision: 1, attempts: 0, nextAt: now, updatedAt: now, ...(deleted ? { deleted } : {}) });
    if (wake) await kick(ctx);
    return;
  }
  const leased = (row.leaseUntil ?? 0) > now;
  await ctx.db.patch(row._id, {
    pending: true, revision: row.revision + 1, updatedAt: now, ...(deleted ? { deleted } : {}),
    // A row the worker holds keeps its lease (the worker sees the new revision and goes again); a backed-off one retries now.
    ...(leased ? {} : { nextAt: now, attempts: 0 }),
  });
  if (wake && (!row.pending || !leased)) await kick(ctx);
}

/** Call after any write to an issue's title, description, labels, column or completion. */
export async function queueGitHubSync(ctx: MutationCtx, taskId: Id<"tasks">) {
  const task = await ctx.db.get(taskId);
  if (!task) return;
  const project = await ctx.db.get(task.projectId);
  if (!project || !await githubSyncEnabled(ctx, project) || mirrorsAsPullRequest(task, project)) return;
  // A Backlog issue without a GitHub issue has nothing to mirror yet; leaving Backlog queues it again.
  if (!task.githubIssueNumber && await taskInDraft(ctx, task)) return;
  await markPending(ctx, task.projectId, taskId);
}

/** Call before deleting an issue: its GitHub issue is closed (not deleted, see convex/githubIssueSync.ts). */

/** After a workspace reconnects GitHub, pending mirrors should retry now instead of waiting out backoff. */
export async function retryPendingMirrorsForTeam(ctx: MutationCtx, teamId: Id<"teams">) {
  const projectIds = new Set((await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", teamId)).take(500)).map(project => project._id));
  if (!projectIds.size) return 0;
  const rows = await ctx.db.query("githubIssueMirrors").withIndex("by_pending_and_nextAt", q => q.eq("pending", true)).take(500);
  let retried = 0;
  for (const row of rows) {
    if (!projectIds.has(row.projectId)) continue;
    await markPending(ctx, row.projectId, row.taskId, row.deleted, false);
    retried++;
  }
  if (retried) await kick(ctx);
  return retried;
}

export async function queueGitHubDelete(ctx: MutationCtx, task: Doc<"tasks">) {
  const repoUrl = task.githubIssueUrl?.split("/issues/")[0];
  if (task.githubIssueNumber && repoUrl) return markPending(ctx, task.projectId, task._id, { repoUrl, number: task.githubIssueNumber });
  const row = await mirrorRow(ctx, task._id);
  if (row) await ctx.db.delete(row._id);
}
