import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { getActiveTeamMember, normalizeEmail, projectPeople, requireAdmin, requireMember } from "./lib/permissions";
import { roleValidator } from "./lib/validators";
import { reviewGitHubAccess } from "./lib/githubAccess";

function makeInviteToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

export const list = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { member } = await requireMember(ctx, args.projectId, args.sessionToken);
    const rows = await ctx.db
      .query("members")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(500);
    return rows.map(row => ({ ...row, inviteToken: ["owner", "admin"].includes(member.role) ? row.inviteToken : undefined }));
  },
});

export const people = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  returns: v.array(v.object({ _id: v.union(v.id("members"), v.id("teamMembers")), userId: v.id("users"), email: v.string(), role: roleValidator, status: v.literal("active"), name: v.string(), username: v.optional(v.string()), avatarUrl: v.union(v.string(), v.null()) })),
  handler: async (ctx, args) => {
    const { project } = await requireMember(ctx, args.projectId, args.sessionToken);
    return projectPeople(ctx, project);
  },
});

export const addWorkspaceMember = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), email: v.string(), role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project } = await requireAdmin(ctx, args.projectId, args.sessionToken);
    if (!project.teamId) throw new ConvexError("Workspace project required");
    const person = await getActiveTeamMember(ctx, project.teamId, args.email);
    const user = person?.userId ? await ctx.db.get(person.userId) : null;
    if (!person || user?.status !== "active") throw new ConvexError("Choose an active workspace member");
    const existing = await ctx.db.query("members").withIndex("by_project_email", q => q.eq("projectId", project._id).eq("email", person.email)).unique();
    if (existing?.role === "owner") return null;
    const fields = { userId: user._id, email: user.email, name: user.name, role: args.role, status: "active" as const, inviteToken: undefined, updatedAt: Date.now(), joinedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("members", { projectId: project._id, ...fields, createdAt: Date.now() });
    await reviewGitHubAccess(ctx, project.teamId, user.email);
    return null;
  },
});

export const getInvite = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("members")
      .withIndex("by_token", (q) => q.eq("inviteToken", args.token))
      .unique();
    if (invite?.status === "invited") {
      const project = await ctx.db.get(invite.projectId);
      if (!project) return null;
      return {
        projectId: invite.projectId,
        projectName: project.name,
        email: invite.email,
        role: invite.role,
        invitedBy: invite.invitedBy,
      };
    }

    const teamInvite = await ctx.db
      .query("teamMembers")
      .withIndex("by_token", (q) => q.eq("inviteToken", args.token))
      .unique();
    if (!teamInvite || teamInvite.status !== "invited") return null;
    const team = await ctx.db.get(teamInvite.teamId);
    if (!team) return null;
    return {
      projectId: null,
      projectName: team.name,
      email: teamInvite.email,
      role: teamInvite.role,
      invitedBy: teamInvite.invitedBy,
    };
  },
});

export const invite = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    role: roleValidator,
  },
  handler: async (ctx, args) => {
    const { user } = await requireAdmin(ctx, args.projectId, args.sessionToken);
    if (args.role === "owner") throw new ConvexError("Invite people as admin, member or viewer");

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new ConvexError("Project not found");

    const now = Date.now();
    const email = normalizeEmail(args.email);
    const existing = await ctx.db
      .query("members")
      .withIndex("by_project_email", (q) => q.eq("projectId", args.projectId).eq("email", email))
      .unique();

    if (existing?.status === "active") {
      throw new ConvexError("Already a member");
    }

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
      await ctx.db.insert("members", {
        projectId: args.projectId,
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

    return { inviteToken, email, projectName: project.name, invitedBy: user.name || user.email };
  },
});

export const sendInvite = action({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    role: roleValidator,
    origin: v.string(),
  },
  returns: v.object({ inviteLink: v.string(), sent: v.boolean(), reason: v.string() }),
  handler: async () => { throw new ConvexError("Use workspace invitations in Origin to send email invitations"); },
});

export const updateRole = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    memberId: v.id("members"),
    role: roleValidator,
  },
  handler: async (ctx, args) => {
    const { member: requester, project } = await requireAdmin(ctx, args.projectId, args.sessionToken);
    const member = await ctx.db.get(args.memberId);
    if (!member || member.projectId !== args.projectId) throw new ConvexError("Member not found");
    if (member.role === "owner" && requester.role !== "owner") throw new ConvexError("Only the workspace owner can do this");
    if (args.role === "owner" && requester.role !== "owner") throw new ConvexError("Only the workspace owner can do this");
    await ctx.db.patch(args.memberId, { role: args.role, updatedAt: Date.now() });
    await reviewGitHubAccess(ctx, project.teamId, member.email);
  },
});

export const remove = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    memberId: v.id("members"),
  },
  handler: async (ctx, args) => {
    const { member: requester, user, project } = await requireAdmin(ctx, args.projectId, args.sessionToken);
    const member = await ctx.db.get(args.memberId);
    if (!member || member.projectId !== args.projectId) throw new ConvexError("Member not found");
    if (member.role === "owner" && requester.role !== "owner") throw new ConvexError("Only the workspace owner can do this");
    if (member.email === user.email) throw new ConvexError("You can't remove yourself");
    await ctx.db.delete(args.memberId);
    await reviewGitHubAccess(ctx, project.teamId, member.email);
  },
});
