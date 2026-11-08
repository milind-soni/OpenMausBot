import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authorize } from "./connectors";
import { canEdit, getActiveTeamMember, projectMember, requireTeamMember } from "./lib/permissions";

async function context(ctx: QueryCtx, user: Doc<"users">, teamId: Id<"teams">, projectId?: Id<"projects">, taskId?: Id<"tasks">, tokenWrite = true) {
  const member = user.status === "active" ? await getActiveTeamMember(ctx, teamId, user.email) : null;
  if (!member || (member.userId && member.userId !== user._id)) throw new ConvexError("Workspace access revoked");
  if (taskId && !projectId) throw new ConvexError("Project required");
  const project = projectId ? await ctx.db.get(projectId) : null;
  const projectAccess = project ? await projectMember(ctx, project, user) : null;
  if (projectId && (!project || project.teamId !== teamId || !projectAccess)) throw new ConvexError("Project not found");
  const task = taskId ? await ctx.db.get(taskId) : null;
  if (taskId && (!task || task.projectId !== projectId)) throw new ConvexError("Issue not found");
  const projects = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", teamId)).take(500);
  const projectIds: Id<"projects">[] = [];
  for (const row of projects) if (await projectMember(ctx, row, user)) projectIds.push(row._id);
  return JSON.stringify({
    userId: user._id, teamId, workspaceRole: member.role,
    admin: tokenWrite && (member.role === "owner" || member.role === "admin"),
    projectAdmin: tokenWrite && Boolean(projectAccess && ["owner", "admin"].includes(projectAccess.role)),
    write: tokenWrite && canEdit(projectAccess || member), projectIds,
    project: project ? { id: project._id, name: project.name, status: project.status, repositoryUrl: project.repoUrl, githubWorkspaceAccess: project.githubWorkspaceAccess } : null,
    task: task ? { id: task._id, title: task.title, description: task.description || "", done: task.done, completionPullRequest: task.completionPullRequest } : null,
  });
}

export const browserContext = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), projectId: v.optional(v.id("projects")), taskId: v.optional(v.id("tasks")) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    return context(ctx, user, args.teamId, args.projectId, args.taskId);
  },
});

export const mcpContext = query({
  args: { token: v.string(), projectId: v.optional(v.id("projects")), taskId: v.optional(v.id("tasks")), write: v.optional(v.boolean()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const { user, grant } = await authorize(ctx, args.token, args.write === true, args.projectId);
    return JSON.stringify({ ...JSON.parse(await context(ctx, user, grant.teamId, args.projectId, args.taskId, grant.write)), grantId: grant._id });
  },
});

/** Only the signed integration bridge may revalidate a stored run principal without a session token. */
export const runContext = internalQuery({
  args: { userId: v.id("users"), teamId: v.id("teams"), projectId: v.optional(v.id("projects")), taskId: v.optional(v.id("tasks")), grantId: v.optional(v.id("connectorGrants")) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.status !== "active") throw new ConvexError("Account access revoked");
    if (args.grantId) {
      const grant = await ctx.db.get(args.grantId);
      if (!grant || grant.revoked || !grant.write || grant.expiresAt <= Date.now() || grant.userId !== user._id || grant.teamId !== args.teamId || grant.hostId || grant.runId) throw new ConvexError("Automation authorization revoked");
    }
    return context(ctx, user, args.teamId, args.projectId, args.taskId);
  },
});
