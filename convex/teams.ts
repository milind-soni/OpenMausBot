import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { normalizeEmail, projectMember, requireTeamAdmin, requireTeamMember } from "./lib/permissions";
import schema from "./schema";
import { roleValidator } from "./lib/validators";
import { reviewGitHubAccess } from "./lib/githubAccess";
import { startWorkspaceDeletion } from "./workspaceDeletion";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

async function removeMembership(ctx: MutationCtx, member: Doc<"teamMembers">) {
  // Rejoining must not silently restore previous project and connector access.
  const memberships = await ctx.db.query("members").withIndex("by_email", q => q.eq("email", member.email)).take(501);
  if (memberships.length > 500) throw new ConvexError("Remove this account's project memberships before leaving");
  for (const item of memberships) {
    const project = await ctx.db.get(item.projectId);
    if (project?.teamId === member.teamId) await ctx.db.delete(item._id);
  }
  if (member.userId) {
    // Fleet grants must not crowd personal connector revocation out of the bounded page.
    const personal = await ctx.db.query("connectorGrants").withIndex("by_userId_and_teamId_and_runId_and_hostId_and_revoked", q => q.eq("userId", member.userId!).eq("teamId", member.teamId).eq("runId", undefined).eq("hostId", undefined).eq("revoked", false)).take(21);
    for (const grant of personal) await ctx.db.patch(grant._id, { revoked: true });
    const grants = await ctx.db.query("connectorGrants").withIndex("by_userId_and_teamId_and_revoked", q => q.eq("userId", member.userId!).eq("teamId", member.teamId).eq("revoked", false)).take(100);
    for (const grant of grants) await ctx.db.patch(grant._id, { revoked: true });
  }
  await ctx.db.delete(member._id);
  await reviewGitHubAccess(ctx, member.teamId, member.email);
}

export const leave = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { member } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    if (member.role === "owner") throw new ConvexError("The workspace owner cannot leave their workspace");
    await removeMembership(ctx, member);
    return null;
  },
});

function makeInviteToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

export const listWithProjects = query({
  args: { sessionToken: v.string() },
  returns: v.array(v.object({ ...schema.tables.teams.validator.fields, _id: v.id("teams"), _creationTime: v.number(), memberRole: roleValidator, projects: v.array(v.object({ ...schema.tables.projects.validator.fields, _id: v.id("projects"), _creationTime: v.number() })) })),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    const memberships = await ctx.db
      .query("teamMembers")
      .withIndex("by_email", (q) => q.eq("email", user.email))
      .take(101);

    if (memberships.length > 100) throw new ConvexError("Too many workspaces to list");
    const active = memberships.filter(m => m.status === "active" && (!m.userId || m.userId === user._id));
    const rows = []; let projectCount = 0;
    for (const membership of active) {
      const team = await ctx.db.get(membership.teamId);
      if (!team) continue;
      const projects = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", team._id)).take(Math.min(201, 1001 - projectCount));
      projectCount += projects.length;
      if (projects.length > 200 || projectCount > 1000) throw new ConvexError("Too many projects to list");
      const visible = [];
      for (const project of projects) if (await projectMember(ctx, project, user)) visible.push(project);
      rows.push({ ...team, memberRole: membership.role, projects: visible.sort((a, b) => b.updatedAt - a.updatedAt) });
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const create = mutation({
  args: { sessionToken: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    const now = Date.now();
    const teamId = await ctx.db.insert("teams", {
      name: args.name.trim(),
      ownerUserId: user._id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      teamId,
      userId: user._id,
      email: user.email,
      name: user.name || user.email,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
      joinedAt: now,
    });
    return teamId;
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  handler: async (ctx, args) => {
    const { member, user } = await requireTeamAdmin(ctx, args.teamId, args.sessionToken);
    if (member.role !== "owner") throw new ConvexError("Only the workspace owner can do this");
    const projects = await ctx.db.query("projects").withIndex("by_team", (q) => q.eq("teamId", args.teamId)).collect();
    if (projects.length) throw new ConvexError("Delete the workspace's projects first");
    const team = await ctx.db.get(args.teamId);
    if (team) await startWorkspaceDeletion(ctx, team, { userId: user._id, name: user.name });
  },
});

export const members = query({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  handler: async (ctx, args) => {
    const { member } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const rows = await ctx.db.query("teamMembers").withIndex("by_team", (q) => q.eq("teamId", args.teamId)).take(500);
    return rows.map(row => ({ ...row, inviteToken: ["owner", "admin"].includes(member.role) ? row.inviteToken : undefined }));
  },
});

export const invite = mutation({
  args: {
    sessionToken: v.string(),
    teamId: v.id("teams"),
    email: v.string(),
    name: v.optional(v.string()),
    role: roleValidator,
  },
  handler: async (ctx, args) => {
    const { user } = await requireTeamAdmin(ctx, args.teamId, args.sessionToken);
    if (args.role === "owner") throw new ConvexError("Invite people as admin, member or viewer");
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new ConvexError("Workspace not found");
    const now = Date.now();
    const email = normalizeEmail(args.email);
    const existing = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_email", (q) => q.eq("teamId", args.teamId).eq("email", email))
      .unique();
    if (existing?.status === "active") throw new ConvexError("Already a member");
    const inviteToken = makeInviteToken();
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name?.trim() || email,
        role: args.role,
        status: "invited",
        inviteToken,
        invitedBy: user.email,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("teamMembers", {
        teamId: args.teamId,
        email,
        name: args.name?.trim() || email,
        role: args.role,
        status: "invited",
        inviteToken,
        invitedBy: user.email,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { inviteToken, email, teamName: team.name, invitedBy: user.name || user.email };
  },
});

export const sendInvite = action({
  args: {
    sessionToken: v.string(),
    teamId: v.id("teams"),
    email: v.string(),
    name: v.optional(v.string()),
    role: roleValidator,
    origin: v.string(),
  },
  returns: v.object({ inviteLink: v.string(), sent: v.boolean(), reason: v.string() }),
  handler: async () => { throw new ConvexError("Use workspace invitations in Origin to send email invitations"); },
});

export const updateRole = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), memberId: v.id("teamMembers"), role: roleValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireTeamAdmin(ctx, args.teamId, args.sessionToken);
    const member = await ctx.db.get(args.memberId);
    if (!member || member.teamId !== args.teamId) throw new ConvexError("Member not found");
    if (member.role === "owner" || args.role === "owner") throw new ConvexError("Workspace ownership cannot be changed here");
    await ctx.db.patch(args.memberId, { role: args.role, updatedAt: Date.now() });
    await reviewGitHubAccess(ctx, args.teamId, member.email);
    return null;
  },
});

export const removeMember = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), memberId: v.id("teamMembers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireTeamAdmin(ctx, args.teamId, args.sessionToken);
    const member = await ctx.db.get(args.memberId);
    if (!member || member.teamId !== args.teamId) throw new ConvexError("Member not found");
    if (member.role === "owner") throw new ConvexError("The workspace owner cannot be removed");
    if (member.email === user.email) throw new ConvexError("You can't remove yourself");
    await removeMembership(ctx, member);
    return null;
  },
});
