import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { StorageScope } from "./lib/storage";

const WRITES_PER_STEP = 250;
const MEMBERS_REVOKED_AT_ONCE = 500;
const STALLED_AFTER_MS = 15 * 60_000;
const NOTICES_KEPT_MS = 180 * 24 * 60 * 60_000;
const NOTICES_EXPIRED_AT_ONCE = 500;

type Row = { _id: Id<TableNames> };
type Deleter = NonNullable<Doc<"teams">["deletedBy"]>;

/** Tells an active member's computers, through `workspaces:deleted`, that this workspace is gone, before their membership goes. */
async function noteDeletion(ctx: MutationCtx, team: Doc<"teams">, member: Doc<"teamMembers">) {
  if (member.status !== "active" || !team.deletedBy || team.deletingAt === undefined) return;
  await ctx.db.insert("deletedWorkspaces", { email: member.email, teamId: team._id, name: team.name, deletedBy: team.deletedBy, deletedAt: team.deletingAt });
}

/** Hides the workspace from every member at once, then removes everything in it in bounded, resumable steps. */
export async function startWorkspaceDeletion(ctx: MutationCtx, team: Doc<"teams">, deletedBy: Deleter) {
  const deleting = team.deletingAt === undefined ? { ...team, deletingAt: Date.now(), deletedBy } : team;
  if (team.deletingAt === undefined) await ctx.db.patch(team._id, { deletingAt: deleting.deletingAt, deletedBy });
  const members = await ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", team._id)).take(MEMBERS_REVOKED_AT_ONCE);
  for (const member of members) {
    await noteDeletion(ctx, deleting, member);
    await ctx.db.delete(member._id);
  }
  await ctx.scheduler.runAfter(0, internal.workspaceDeletion.purge, { teamId: team._id });
}

function purger(ctx: MutationCtx, teamId: Id<"teams">) {
  let left = WRITES_PER_STEP;

  /** Deletes every row `next` returns, children first; false once this step's write budget is spent. */
  async function drain<T extends Row>(next: (limit: number) => Promise<T[]>, children?: (row: T) => Promise<boolean>, after?: (row: T) => Promise<void>): Promise<boolean> {
    for (;;) {
      if (left <= 0) return false;
      const rows = await next(left);
      if (!rows.length) return true;
      for (const row of rows) {
        if (children && !await children(row)) return false;
        if (left <= 0) return false;
        await ctx.db.delete(row._id);
        left -= 1;
        if (after) await after(row);
      }
    }
  }

  async function inWorkspace(scope: StorageScope) {
    if (scope.kind === "workspace") return scope.teamId === teamId;
    if (scope.kind === "user") return false;
    const project = await ctx.db.get(scope.projectId);
    return !project || project.teamId === teamId;
  }

  /** Drops this workspace's claims on a file, and the file itself once nothing outside the workspace uses it. */
  async function releaseFile(storageId: Id<"_storage"> | undefined) {
    if (!storageId) return;
    const admissions = await ctx.db.query("storageAdmissions").withIndex("by_storageId_and_scopeKey", q => q.eq("storageId", storageId)).take(50);
    let sharedElsewhere = admissions.length === 50;
    for (const admission of admissions) {
      if (await inWorkspace(admission.scope)) { await ctx.db.delete(admission._id); left -= 1; }
      else sharedElsewhere = true;
    }
    if (sharedElsewhere) return;
    const stillUsed = await ctx.db.query("designAssets").withIndex("by_storageId", q => q.eq("storageId", storageId)).first()
      ?? await ctx.db.query("projects").withIndex("by_iconStorageId", q => q.eq("iconStorageId", storageId)).first()
      ?? await ctx.db.query("workspaceAgents").withIndex("by_avatarStorageId", q => q.eq("avatarStorageId", storageId)).first()
      ?? await ctx.db.query("users").withIndex("by_avatarStorageId", q => q.eq("avatarStorageId", storageId)).first()
      ?? await ctx.db.query("drawingFiles").withIndex("by_storageId", q => q.eq("storageId", storageId)).first();
    if (stillUsed || !await ctx.db.system.get(storageId)) return;
    await ctx.storage.delete(storageId);
    left -= 1;
  }

  return { drain, releaseFile };
}

type Purger = ReturnType<typeof purger>;

async function all(steps: Array<() => Promise<boolean>>) {
  for (const step of steps) if (!await step()) return false;
  return true;
}

function taskSteps(ctx: MutationCtx, { drain }: Purger, task: Doc<"tasks">) {
  return all([
    () => drain(n => ctx.db.query("taskRelations").withIndex("by_fromTaskId", q => q.eq("fromTaskId", task._id)).take(n)),
    () => drain(n => ctx.db.query("taskRelations").withIndex("by_toTaskId", q => q.eq("toTaskId", task._id)).take(n)),
    () => drain(n => ctx.db.query("taskComments").withIndex("by_task", q => q.eq("taskId", task._id)).take(n)),
    () => drain(n => ctx.db.query("taskAssets").withIndex("by_task", q => q.eq("taskId", task._id)).take(n)),
    () => drain(n => ctx.db.query("taskPullRequests").withIndex("by_taskId", q => q.eq("taskId", task._id)).take(n)),
    () => drain(n => ctx.db.query("taskCompletions").withIndex("by_taskId", q => q.eq("taskId", task._id)).take(n)),
    () => drain(n => ctx.db.query("designLinks").withIndex("by_task", q => q.eq("taskId", task._id)).take(n)),
    () => drain(n => ctx.db.query("issueActivity").withIndex("by_taskId_and_createdAt", q => q.eq("taskId", task._id)).take(n)),
  ]);
}

function canvasSteps(ctx: MutationCtx, { drain, releaseFile }: Purger, canvas: Doc<"canvases">) {
  const scene = { teamId: canvas.teamId, canvasId: canvas._id };
  return all([
    () => drain(n => ctx.db.query("canvasComments").withIndex("by_canvas", q => q.eq("canvasId", canvas._id)).take(n)),
    () => drain(n => ctx.db.query("canvasVersions").withIndex("by_canvas", q => q.eq("canvasId", canvas._id)).take(n),
      version => drain(n => ctx.db.query("canvasVersionChunks").withIndex("by_version", q => q.eq("versionId", version._id)).take(n))),
    () => drain(n => ctx.db.query("designLinks").withIndex("by_canvas", q => q.eq("canvasId", canvas._id)).take(n)),
    () => drain(n => ctx.db.query("drawingElements").withIndex("by_scene", q => q.eq("teamId", scene.teamId).eq("canvasId", scene.canvasId)).take(n)),
    () => drain(n => ctx.db.query("drawingFiles").withIndex("by_scene", q => q.eq("teamId", scene.teamId).eq("canvasId", scene.canvasId)).take(n), undefined, file => releaseFile(file.storageId)),
    () => drain(n => ctx.db.query("drawingPresence").withIndex("by_scene", q => q.eq("teamId", scene.teamId).eq("canvasId", scene.canvasId)).take(n)),
    () => drain(n => ctx.db.query("publishedPages").withIndex("by_canvasId_and_frameId", q => q.eq("canvasId", canvas._id)).take(n), undefined, page => releaseFile(page.ogStorageId)),
  ]);
}

function projectSteps(ctx: MutationCtx, purge: Purger, project: Doc<"projects">) {
  const { drain, releaseFile } = purge;
  const projectId = project._id;
  return all([
    () => drain(n => ctx.db.query("members").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("tasks").withIndex("by_project", q => q.eq("projectId", projectId)).take(n), task => taskSteps(ctx, purge, task)),
    () => drain(n => ctx.db.query("taskComments").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("taskAssets").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("taskPullRequests").withIndex("by_projectId_and_number", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("taskCompletions").withIndex("by_projectId_and_completedAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("columns").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("milestones").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("releases").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n),
      release => drain(n => ctx.db.query("releaseIssues").withIndex("by_releaseId", q => q.eq("releaseId", release._id)).take(n))),
    () => drain(n => ctx.db.query("feedbackPortals").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n),
      portal => drain(n => ctx.db.query("feedbackEntries").withIndex("by_portalId_and_createdAt", q => q.eq("portalId", portal._id)).take(n))),
    () => drain(n => ctx.db.query("projectAgents").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("agentApprovals").withIndex("by_projectId_and_outcome", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("canvases").withIndex("by_project", q => q.eq("projectId", projectId)).take(n), canvas => canvasSteps(ctx, purge, canvas)),
    () => drain(n => ctx.db.query("broadcastPosts").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("campaigns").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("pipelineActivities").withIndex("by_projectId_and_status", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("pipelineDeals").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("pipelineLeads").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId)).take(n),
      lead => drain(n => ctx.db.query("pipelineSequences").withIndex("by_leadId", q => q.eq("leadId", lead._id)).take(n))),
    () => drain(n => ctx.db.query("pipelineSettings").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("pipelineViews").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("pipelineTemplates").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("publishedPages").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n), undefined, page => releaseFile(page.ogStorageId)),
    () => drain(n => ctx.db.query("studioGenerations").withIndex("by_projectId_and_createdAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("studioWorkflows").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("studioWorkflowRuns").withIndex("by_projectId_and_createdAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("studioCharacters").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("studioTemplates").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("standupDigests").withIndex("by_projectId_and_day", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("agentBudgets").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("budgetSpend").withIndex("by_projectId_and_month", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("chiefHeartbeats").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("callNotes").withIndex("by_projectId_and_createdAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("shipReleases").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("shipTargets").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("brandKits").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("pulseDays").withIndex("by_projectId_and_day", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("githubRepoJobs").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("githubBranchProtections").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("sharedKeys").withIndex("by_projectId", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("commits").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("githubPullRequests").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("wikiPages").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("credentials").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("designTokens").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("designAssets").withIndex("by_project", q => q.eq("projectId", projectId)).take(n), undefined, asset => releaseFile(asset.storageId)),
    () => drain(n => ctx.db.query("chatMessages").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("callParticipants").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
    () => drain(n => ctx.db.query("callSignals").withIndex("by_project", q => q.eq("projectId", projectId)).take(n)),
  ]);
}

function runSteps(ctx: MutationCtx, { drain }: Purger, run: Doc<"workspaceAgentRuns">) {
  return all([
    () => drain(n => ctx.db.query("workspaceAgentEvents").withIndex("by_runId_and_sequence", q => q.eq("runId", run._id)).take(n)),
    () => drain(n => ctx.db.query("agentApprovals").withIndex("by_runId_and_requestId", q => q.eq("runId", run._id)).take(n)),
    () => drain(n => ctx.db.query("agentOperations").withIndex("by_runId_and_requestId", q => q.eq("runId", run._id)).take(n)),
    () => drain(n => ctx.db.query("workspaceAgentMessages").withIndex("by_runId", q => q.eq("runId", run._id)).take(n)),
    () => drain(n => ctx.db.query("modelHostExecutions").withIndex("by_runId", q => q.eq("runId", run._id)).take(n)),
  ]);
}

/** Removes one bounded step of the workspace; true once the workspace itself is gone. */
async function purgeWorkspace(ctx: MutationCtx, team: Doc<"teams">) {
  const purge = purger(ctx, team._id);
  const { drain, releaseFile } = purge;
  const teamId = team._id;
  const done = await all([
    () => drain(n => ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", teamId)).take(n), undefined, member => noteDeletion(ctx, team, member)),
    () => drain(n => ctx.db.query("workspaceInvites").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("connectorGrants").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n),
      grant => drain(n => ctx.db.query("connectorOperations").withIndex("by_grantId_and_requestId", q => q.eq("grantId", grant._id)).take(n))),
    () => drain(n => ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", teamId)).take(n),
      project => projectSteps(ctx, purge, project), project => releaseFile(project.iconStorageId)),
    () => drain(n => ctx.db.query("workspaceAgentRuns").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n), run => runSteps(ctx, purge, run)),
    () => drain(n => ctx.db.query("agentThreads").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n), thread => all([
      () => drain(n => ctx.db.query("agentThreadMessages").withIndex("by_threadId_and_seq", q => q.eq("threadId", thread._id)).take(n)),
      () => drain(n => ctx.db.query("agentThreadReads").withIndex("by_threadId_and_userId", q => q.eq("threadId", thread._id)).take(n)),
    ])),
    () => drain(n => ctx.db.query("workspaceAgents").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n), agent => all([
      () => drain(n => ctx.db.query("projectAgents").withIndex("by_agentId", q => q.eq("agentId", agent._id)).take(n)),
      () => drain(n => ctx.db.query("agentRendererBots").withIndex("by_agentId", q => q.eq("agentId", agent._id)).take(n)),
      () => drain(n => ctx.db.query("agentBudgets").withIndex("by_agentId", q => q.eq("agentId", agent._id)).take(n)),
      () => drain(n => ctx.db.query("budgetSpend").withIndex("by_agentId_and_month", q => q.eq("agentId", agent._id)).take(n)),
    ]), agent => releaseFile(agent.avatarStorageId)),
    () => drain(n => ctx.db.query("modelHostSources").withIndex("by_teamId_and_enabled", q => q.eq("teamId", teamId)).take(n),
      source => drain(n => ctx.db.query("modelHostExecutions").withIndex("by_sourceId_and_status_and_leaseUntil", q => q.eq("sourceId", source._id)).take(n))),
    () => drain(n => ctx.db.query("agentHosts").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n), host => all([
      () => drain(n => ctx.db.query("agentComputers").withIndex("by_hostId", q => q.eq("hostId", host._id)).take(n)),
      () => drain(n => ctx.db.query("agentRendererBots").withIndex("by_hostId_and_botId", q => q.eq("hostId", host._id)).take(n)),
      () => drain(n => ctx.db.query("modelHostSources").withIndex("by_hostId", q => q.eq("hostId", host._id)).take(n)),
      () => drain(n => ctx.db.query("modelHostExecutions").withIndex("by_hostId_and_status_and_leaseUntil", q => q.eq("hostId", host._id)).take(n)),
    ])),
    () => drain(n => ctx.db.query("workspaceAgentEvents").withIndex("by_teamId_and_createdAt", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("milestones").withIndex("by_teamId_and_targetDate", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("releases").withIndex("by_teamId_and_createdAt", q => q.eq("teamId", teamId)).take(n),
      release => drain(n => ctx.db.query("releaseIssues").withIndex("by_releaseId", q => q.eq("releaseId", release._id)).take(n))),
    () => drain(n => ctx.db.query("feedbackPortals").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n),
      portal => drain(n => ctx.db.query("feedbackEntries").withIndex("by_portalId_and_createdAt", q => q.eq("portalId", portal._id)).take(n))),
    () => drain(n => ctx.db.query("taskCompletions").withIndex("by_teamId_and_completedAt", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("wikiPages").withIndex("by_teamId_and_updatedAt", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("notifications").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("notificationPreferences").withIndex("by_teamId_and_userId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("savedViews").withIndex("by_teamId_and_userId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("drawingBoards").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("drawingElements").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("drawingFiles").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n), undefined, file => releaseFile(file.storageId)),
    () => drain(n => ctx.db.query("drawingPresence").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("publishedPages").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n), undefined, page => releaseFile(page.ogStorageId)),
    () => drain(n => ctx.db.query("agentRetention").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("agentBudgets").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("budgetSpend").withIndex("by_teamId_and_month", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("chiefHeartbeats").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("teamChatMessages").withIndex("by_team_conversation_created", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("teamChatFiles").withIndex("by_team_conversation_file", q => q.eq("teamId", teamId)).take(n), undefined, file => releaseFile(file.storageId)),
    () => drain(n => ctx.db.query("teamDirectConversations").withIndex("by_team_conversation", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("teamChatReads").withIndex("by_team_conversation_user", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("teamCallParticipants").withIndex("by_team_room_user", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("teamCallSignals").withIndex("by_team_room_recipient_created", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("teamCallAgents").withIndex("by_team_room", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("teamCallLines").withIndex("by_team_room_line", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("projectPresence").withIndex("by_team_updatedAt", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("issueWebhooks").withIndex("by_teamId", q => q.eq("teamId", teamId)).take(n)),
    () => drain(n => ctx.db.query("sharedKeys").withIndex("by_teamId_and_integration", q => q.eq("teamId", teamId)).take(n)),
  ]);
  if (!done) return false;
  await ctx.db.delete(teamId);
  return true;
}

export const purge = internalMutation({
  args: { teamId: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, { teamId }) => {
    const team = await ctx.db.get(teamId);
    if (!team || team.deletingAt === undefined) return null;
    if (!await purgeWorkspace(ctx, team)) await ctx.scheduler.runAfter(0, internal.workspaceDeletion.purge, { teamId });
    return null;
  },
});

/** Restarts a deletion whose scheduled step failed, so an interrupted workspace never stays half deleted. */
export const resume = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const stalled = await ctx.db.query("teams").withIndex("by_deletingAt", q => q.gt("deletingAt", 0).lt("deletingAt", Date.now() - STALLED_AFTER_MS)).take(20);
    for (const team of stalled) await ctx.scheduler.runAfter(0, internal.workspaceDeletion.purge, { teamId: team._id });
    return null;
  },
});

export const expireNotices = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const expired = await ctx.db.query("deletedWorkspaces").withIndex("by_deletedAt", q => q.lt("deletedAt", Date.now() - NOTICES_KEPT_MS)).take(NOTICES_EXPIRED_AT_ONCE);
    for (const notice of expired) await ctx.db.delete(notice._id);
    if (expired.length === NOTICES_EXPIRED_AT_ONCE) await ctx.scheduler.runAfter(0, internal.workspaceDeletion.expireNotices, {});
    return null;
  },
});
