import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { globalIssueWebhook } from "../issueWebhooks";
import { issueKey } from "../../lib/github-references";
import { issueWebhookChanges, issueWebhookPayload, type IssueWebhookChanges, type IssueWebhookEvent } from "../../lib/issue-webhook";

// Issue webhooks from issue writes: call issueCreated after inserting an issue, and issueStatusChanged with the
// issue as it was before a write that may move or complete it. Each schedules convex/issueWebhooks.ts `deliver`
// with the finished body; nothing is scheduled when neither the workspace nor the deployment has a webhook.

async function webhookConfigured(ctx: MutationCtx, teamId: Id<"teams">) {
  return Boolean(globalIssueWebhook()) || Boolean(await ctx.db.query("issueWebhooks").withIndex("by_teamId", q => q.eq("teamId", teamId)).unique());
}

async function columnTitle(ctx: MutationCtx, columnId: Id<"columns">) {
  return (await ctx.db.get(columnId))?.title ?? "";
}

async function schedule(ctx: MutationCtx, type: IssueWebhookEvent, task: Doc<"tasks">, changes: IssueWebhookChanges | null) {
  const project = await ctx.db.get(task.projectId);
  const teamId = task.teamId ?? project?.teamId;
  const team = teamId ? await ctx.db.get(teamId) : null;
  if (!project || !team || team.deletingAt || !await webhookConfigured(ctx, team._id)) return;
  const payload = issueWebhookPayload({
    type, occurredAt: Date.now(),
    workspace: { id: team._id, name: team.name, slug: team.slug ?? team._id },
    project: { id: project._id, name: project.name, repoUrl: project.repoUrl },
    issue: {
      id: task._id, key: issueKey(task._id), title: task.title, description: task.description, labels: task.labels, status: await columnTitle(ctx, task.columnId),
      completed: task.done, assignee: task.assignedToEmail ? { email: task.assignedToEmail, name: task.assignedToName } : null, acceptanceCriteria: task.acceptanceCriteria,
    },
    changes,
    origin: process.env.ORIGIN_PUBLIC_URL,
  });
  await ctx.scheduler.runAfter(0, internal.issueWebhooks.deliver, { teamId: team._id, event: type, deliveryId: payload.id, body: JSON.stringify(payload) });
}

export async function issueCreated(ctx: MutationCtx, taskId: Id<"tasks">) {
  const task = await ctx.db.get(taskId);
  if (task) await schedule(ctx, "issue.created", task, null);
}

/** Sends issue.updated when the column title (status) or completion differs from `before`; other edits send nothing. */
export async function issueStatusChanged(ctx: MutationCtx, before: Doc<"tasks">) {
  const after = await ctx.db.get(before._id);
  if (!after || (after.columnId === before.columnId && after.done === before.done)) return;
  const changes = issueWebhookChanges(
    { status: await columnTitle(ctx, before.columnId), completed: before.done },
    { status: await columnTitle(ctx, after.columnId), completed: after.done },
  );
  if (changes) await schedule(ctx, "issue.updated", after, changes);
}
