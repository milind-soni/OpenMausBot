import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { hashToken } from "./lib/auth";
import { canEdit, getActiveTeamMember, projectMember, projectPeople, requireTeamMember, visibleProjectRows } from "./lib/permissions";
import { createProjectRecord } from "./projects";
import { createTaskRecord, deleteTaskRecord, updateTaskRecord } from "./tasks";
import { priorityValidator } from "./lib/validators";
import { isMcpConnectorToken } from "../lib/mcp-tokens";

/** Personal access tokens and OAuth grants work only through the permission-checked MCP tools (convex/mcp.ts). */
function rejectMcpToken(token: string) {
  if (isMcpConnectorToken(token)) throw new ConvexError("This token only works with the Origin MCP server");
}

export async function authorize(ctx: QueryCtx | MutationCtx, token: string, write = false, projectId?: Id<"projects">) {
  const tokenHash = await hashToken(token);
  const grant = await ctx.db.query("connectorGrants").withIndex("by_tokenHash", q => q.eq("tokenHash", tokenHash)).unique();
  if (!grant || grant.revoked || grant.expiresAt <= Date.now()) throw new ConvexError("This connection expired or was revoked");
  if (grant.hostId) throw new ConvexError("Host token cannot access Origin actions");
  // Agent run tokens belong to the removed Agent feature and no longer authorize anything.
  if (grant.runId) throw new ConvexError("Run token cannot access Origin actions");
  const user = await ctx.db.get(grant.userId);
  const member = user?.status === "active" ? await getActiveTeamMember(ctx, grant.teamId, user.email) : null;
  if (!user || !member || (member.userId && member.userId !== user._id) || (write && (!grant.write || !canEdit(member)))) throw new ConvexError("This connection does not allow that");
  if (projectId) {
    const project = await ctx.db.get(projectId);
    const access = project && await projectMember(ctx, project, user);
    if (project?.teamId !== grant.teamId || !access || (write && !canEdit(access))) throw new ConvexError("Project not found in authorized workspace");
  }
  return { grant, user, member };
}

/** Shared by connectors.createGrant (production parity) and mcp.createOAuthGrant (token prefix marks MCP grants). */
export async function insertConnectorGrant(ctx: MutationCtx, args: { sessionToken: string; teamId: Id<"teams">; name: string; write: boolean }, prefix = "") {
  const { user, member } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
  if (args.write && !canEdit(member)) throw new ConvexError("You have view-only access to this workspace");
  const active = await ctx.db.query("connectorGrants").withIndex("by_userId_and_teamId_and_runId_and_hostId_and_revoked", q => q.eq("userId", user._id).eq("teamId", args.teamId).eq("runId", undefined).eq("hostId", undefined).eq("revoked", false)).take(21);
  if (active.filter(g => !g.revoked && g.expiresAt > Date.now()).length >= 20) throw new ConvexError("Revoke an unused connection first");
  const token = prefix + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = Date.now() + 90 * 86400000;
  const grantId = await ctx.db.insert("connectorGrants", { teamId: args.teamId, userId: user._id, name: args.name.slice(0, 120),
    tokenHash: await hashToken(token), write: args.write, expiresAt, createdAt: Date.now(), revoked: false });
  return { token, grantId, expiresAt };
}

export const createGrant = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), name: v.string(), write: v.boolean() },
  returns: v.object({ token: v.string(), grantId: v.id("connectorGrants"), expiresAt: v.number() }),
  handler: (ctx, args) => insertConnectorGrant(ctx, args),
});

export const verify = query({
  args: { token: v.string() }, returns: v.object({ write: v.boolean(), teamId: v.id("teams"), expiresAt: v.number() }),
  handler: async (ctx, a) => { const { grant, member } = await authorize(ctx, a.token); return { write: grant.write && canEdit(member), teamId: grant.teamId, expiresAt: grant.expiresAt }; },
});

export const listGrants = query({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.array(v.object({ _id: v.id("connectorGrants"), name: v.string(), write: v.boolean(), createdAt: v.number(), expiresAt: v.number(), revoked: v.boolean() })),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    return (await ctx.db.query("connectorGrants").withIndex("by_userId_and_teamId_and_runId_and_hostId", q => q.eq("userId", user._id).eq("teamId", a.teamId).eq("runId", undefined).eq("hostId", undefined)).order("desc").take(100))
      .map(({ _id, name, write, createdAt, expiresAt, revoked }) => ({ _id, name, write, createdAt, expiresAt, revoked }));
  },
});

export const revoke = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), grantId: v.id("connectorGrants") }, returns: v.null(),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const grant = await ctx.db.get(a.grantId);
    if (!grant || grant.teamId !== a.teamId || grant.userId !== user._id) throw new ConvexError("Connection not found");
    await ctx.db.patch(grant._id, { revoked: true }); return null;
  },
});

export const read = query({
  args: { token: v.string(), kind: v.union(v.literal("projects"), v.literal("project"), v.literal("issues"), v.literal("issue"), v.literal("members"), v.literal("inbox"), v.literal("notifications")),
    projectId: v.optional(v.id("projects")), taskId: v.optional(v.id("tasks")), cursor: v.optional(v.string()), done: v.optional(v.boolean()) },
  returns: v.string(),
  handler: async (ctx, a) => {
    rejectMcpToken(a.token);
    const { grant, user } = await authorize(ctx, a.token, false, a.projectId);
    const run = grant.runId ? (await ctx.db.get(grant.runId))! : null;
    if (a.kind === "projects") {
      if (run?.projectId) {
        const p = (await ctx.db.get(run.projectId))!;
        return JSON.stringify({ projects: [{ id: p._id, name: p.name, description: p.description, repoUrl: p.repoUrl, githubRepoState: p.githubRepoState, status: p.status === "active" ? "active" : "inactive" }], nextCursor: null });
      }
      const p = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", grant.teamId)).paginate({ numItems: 50, cursor: a.cursor || null });
      const visible = await visibleProjectRows(ctx, p.page.map(project => ({ ...project, projectId: project._id })), user);
      return JSON.stringify({ projects: visible.map(({ _id, name, description, repoUrl, githubRepoState, status }) => ({ id: _id, name, description, repoUrl, githubRepoState, status: status === "active" ? "active" : "inactive" })), nextCursor: p.isDone ? null : p.continueCursor });
    }
    if (a.kind === "inbox") {
      const p = await ctx.db.query("tasks").withIndex("by_teamId_and_done_and_assignedToEmail", q => q.eq("teamId", grant.teamId).eq("done", a.done ?? false).eq("assignedToEmail", user.email)).order("desc").paginate({ numItems: 50, cursor: a.cursor || null });
      const visible = await visibleProjectRows(ctx, run ? p.page.filter(t => t.projectId === run.projectId) : p.page, user, !a.done);
      const issues = await Promise.all(visible.map(async t => ({ id: t._id, projectId: t.projectId, projectName: (await ctx.db.get(t.projectId))!.name, title: t.title, done: t.done, priority: t.priority, dueDate: t.dueDate, githubIssueUrl: t.githubIssueUrl })));
      return JSON.stringify({ issues, nextCursor: p.isDone ? null : p.continueCursor });
    }
    if (a.kind === "notifications") {
      const p = await ctx.db.query("notifications").withIndex("by_user_team", q => q.eq("userId", user._id).eq("teamId", grant.teamId)).order("desc").paginate({ numItems: 50, cursor: a.cursor || null });
      const notifications = [];
      for (const row of p.page) {
        if (run && row.projectId !== run.projectId) continue;
        const project = row.projectId ? await ctx.db.get(row.projectId) : null;
        if (row.projectId && (!project || !await projectMember(ctx, project, user))) continue;
        // Chat content is outside the connector grant; expose only the mention event.
        notifications.push({ id: row._id, kind: row.kind, read: row.read, createdAt: row.createdAt, projectId: row.projectId, projectName: project?.name, taskId: row.taskId });
      }
      return JSON.stringify({ notifications, nextCursor: p.isDone ? null : p.continueCursor });
    }
    if (a.kind === "members") {
      if (a.projectId) return JSON.stringify({ members: (await projectPeople(ctx, (await ctx.db.get(a.projectId))!)).map(m => ({ name: m.name, email: m.email, role: m.role })), nextCursor: null });
      const p = await ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", grant.teamId)).paginate({ numItems: 50, cursor: a.cursor || null });
      return JSON.stringify({ members: p.page.filter(m => m.status === "active").map(m => ({ id: m._id, userId: m.userId, name: m.name, email: m.email, role: m.role })), nextCursor: p.isDone ? null : p.continueCursor });
    }
    if (!a.projectId) throw new ConvexError("Project required");
    if (a.kind === "project") {
      const p = (await ctx.db.get(a.projectId))!;
      const columns = await ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", p._id)).take(20);
      return JSON.stringify({ id: p._id, name: p.name, description: p.description, repoUrl: p.repoUrl, status: p.status === "active" ? "active" : "inactive", columns: columns.map(c => ({ id: c._id, title: c.title })) });
    }
    const serialize = (t: { _id: string; title: string; description?: string; columnId: string; done: boolean; priority: string; assignedToEmail?: string; dueDate?: string; githubIssueUrl?: string; githubTaskBranch?: string }) => ({ id: t._id, title: t.title, description: t.description, columnId: t.columnId, done: t.done, priority: t.priority, assignedToEmail: t.assignedToEmail, dueDate: t.dueDate, githubIssueUrl: t.githubIssueUrl, githubTaskBranch: t.githubTaskBranch });
    if (a.kind === "issue") {
      const task = a.taskId ? await ctx.db.get(a.taskId) : null;
      if (!task || task.projectId !== a.projectId) throw new ConvexError("Issue not found");
      return JSON.stringify(serialize(task));
    }
    const p = await ctx.db.query("tasks").withIndex("by_project_and_done", q => q.eq("projectId", a.projectId!).eq("done", a.done ?? false)).order("desc").paginate({ numItems: 50, cursor: a.cursor || null });
    return JSON.stringify({ issues: p.page.map(serialize), nextCursor: p.isDone ? null : p.continueCursor });
  },
});

export const write = mutation({
  args: { token: v.string(), requestId: v.string(), change: v.union(
    v.object({ kind: v.literal("create_project"), name: v.string(), description: v.optional(v.string()) }),
    v.object({ kind: v.literal("update_project"), projectId: v.id("projects"), name: v.optional(v.string()), description: v.optional(v.string()) }),
    v.object({ kind: v.literal("create_issue"), projectId: v.id("projects"), columnId: v.optional(v.id("columns")), title: v.string(), description: v.optional(v.string()), priority: priorityValidator, assignedToEmail: v.string(), dueDate: v.string() }),
    v.object({ kind: v.literal("update_issue"), projectId: v.id("projects"), taskId: v.id("tasks"), title: v.optional(v.string()), description: v.optional(v.string()), priority: v.optional(priorityValidator), assignedToEmail: v.optional(v.string()), dueDate: v.optional(v.string()), done: v.optional(v.boolean()) }),
    v.object({ kind: v.literal("delete_issue"), projectId: v.id("projects"), taskId: v.id("tasks") }),
  ) }, returns: v.string(),
  handler: async (ctx, a) => {
    rejectMcpToken(a.token);
    const c = a.change;
    const { grant, user, member } = await authorize(ctx, a.token, true, "projectId" in c ? c.projectId : undefined);
    if (c.kind === "update_project" && !["owner", "admin"].includes(member.role)) throw new ConvexError("Workspace admin access required");
    if (a.requestId.length < 8 || a.requestId.length > 120) throw new ConvexError("A stable unique request ID is required");
    const key = await hashToken(JSON.stringify(c));
    const previous = await ctx.db.query("connectorOperations").withIndex("by_grantId_and_requestId", q => q.eq("grantId", grant._id).eq("requestId", a.requestId)).unique();
    if (previous) { const saved = JSON.parse(previous.result); if (saved.key !== key) throw new ConvexError("Request ID already used for another operation"); return JSON.stringify(saved.result); }
    let result: { id: string };
    if (c.kind === "create_project") result = { id: await createProjectRecord(ctx, { teamId: grant.teamId, name: c.name, description: c.description }, user) };
    else if (c.kind === "create_issue") result = { id: await createTaskRecord(ctx, c, user._id) };
    else if (c.kind === "update_issue") { await updateTaskRecord(ctx, c, user._id); result = { id: c.taskId }; }
    else if (c.kind === "delete_issue") { await deleteTaskRecord(ctx, c); result = { id: c.taskId }; }
    else {
      if (c.name !== undefined && (!c.name.trim() || c.name.length > 100)) throw new ConvexError("Project name required, maximum 100 characters");
      if ((c.description?.length || 0) > 10000) throw new ConvexError("Description too long");
      await ctx.db.patch(c.projectId, { ...(c.name === undefined ? {} : { name: c.name.trim() }), ...(c.description === undefined ? {} : { description: c.description }), updatedAt: Date.now() });
      result = { id: c.projectId };
    }
    await ctx.db.insert("connectorOperations", { grantId: grant._id, requestId: a.requestId, result: JSON.stringify({ key, result }) });
    return JSON.stringify(result);
  },
});
