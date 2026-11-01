import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createWorkspace } from "./workspaces";
import { admitStorageReference, issueUpload, storageMetadata } from "./lib/storage";
import {
  createSession,
  createUser,
  getSessionUser,
  getUserByEmail,
  invalidateOtherSessions,
  makePasswordRecord,
  normalizeEmail,
  publicUser,
  requireUser,
  verifyPassword,
} from "./lib/auth";

export const me = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const result = await getSessionUser(ctx, args.sessionToken);
    if (!result) return null;
    return {
      ...publicUser(result.user),
      createdAt: result.user._creationTime,
      avatarUrl: result.user.avatarStorageId ? await ctx.storage.getUrl(result.user.avatarStorageId) : null,
    };
  },
});

export const generateAvatarUploadUrl = mutation({
  args: { sessionToken: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    return issueUpload(ctx, args.sessionToken, { kind: "profile", userId: user._id });
  },
});

export const updateProfile = mutation({
  args: {
    sessionToken: v.string(),
    username: v.optional(v.string()),
    name: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    const patch: Partial<{
      username: string | undefined;
      name: string;
      avatarStorageId: Id<"_storage"> | undefined;
      updatedAt: number;
    }> = { updatedAt: Date.now() };
    if (args.username !== undefined) {
      const username = args.username.trim().replace(/^@+/, "");
      if (username.length > 40) throw new ConvexError("Username must be 40 characters or fewer");
      patch.username = username || undefined;
    }
    if (args.name !== undefined) {
      if (args.name.length > 100) throw new ConvexError("Name must be 100 characters or fewer");
      patch.name = args.name.trim() || user.name;
    }
    if (args.avatarStorageId !== undefined) {
      const file = await storageMetadata(ctx, args.avatarStorageId);
      if (!file || file.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.contentType || "")) throw new ConvexError("Choose a PNG, JPEG, WebP or GIF under 5 MB");
      await admitStorageReference(ctx, args.avatarStorageId, user, { kind: "user", userId: user._id });
      patch.avatarStorageId = args.avatarStorageId;
    }
    await ctx.db.patch(user._id, patch);
    return null;
  },
});

export const loginAccount = internalMutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const user = await getUserByEmail(ctx, email);

    if (!user || user.status !== "active" || !(await verifyPassword(user, args.password))) {
      throw new ConvexError("Invalid email or password");
    }

    const now = Date.now();
    await ctx.db.patch(user._id, { lastLoginAt: now, updatedAt: now });
    const sessionToken = await createSession(ctx, user._id);
    return { sessionToken, user: publicUser(user) };
  },
});

// Set ORIGIN_SIGNUP_MODE=invite in the Convex environment to allow new accounts only through invitations.
const inviteOnly = () => process.env.ORIGIN_SIGNUP_MODE === "invite";

export const signupMode = query({
  args: {},
  returns: v.object({ inviteOnly: v.boolean() }),
  handler: async () => ({ inviteOnly: inviteOnly() }),
});

export const signupAccount = internalMutation({
  args: { email: v.string(), password: v.string(), name: v.string(), workspaceName: v.optional(v.string()), slug: v.optional(v.string()), inviteToken: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new ConvexError("Enter a valid email address");
    if (args.password.length < 10 || args.password.length > 128) throw new ConvexError("Use a password between 10 and 128 characters");
    if (!args.name.trim() || args.name.length > 100) throw new ConvexError("Enter your name");
    if (inviteOnly() && !args.inviteToken) throw new ConvexError("This Origin instance is invite-only. Ask a workspace admin for an invitation link.");
    if (await getUserByEmail(ctx, email)) throw new ConvexError("An account already exists. Sign in instead.");
    if (args.inviteToken) {
      const inviteToken = args.inviteToken;
      const invite = await ctx.db.query("workspaceInvites").withIndex("by_token", q => q.eq("token", inviteToken)).unique();
      if (!invite || invite.revoked || invite.expiresAt < Date.now()) throw new ConvexError("This invitation has expired");
      if (invite.email && invite.email !== email) throw new ConvexError("Use the email address on your invitation");
    }
    const userId = await createUser(ctx, { email, name: args.name, password: args.password });
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("Could not create the account. Try again.");
    const workspace = args.inviteToken ? null : await createWorkspace(ctx, user, args.workspaceName || `${args.name.trim()}'s workspace`, args.slug);
    return { sessionToken: await createSession(ctx, userId), user: publicUser(user), slug: workspace?.slug || null };
  },
});

export const reserveAuthAttempt = internalMutation({
  args: { key: v.string(), signup: v.boolean() }, returns: v.boolean(),
  handler: async (ctx, args) => {
    const key = `${args.signup ? "signup" : "login"}:${args.key.trim().toLowerCase().slice(0, 254)}`;
    const row = await ctx.db.query("authAttempts").withIndex("by_key", q => q.eq("key", key)).unique();
    const now = Date.now(); const count = row && row.expiresAt > now ? row.count + 1 : 1;
    const expiresAt = row && row.expiresAt > now ? row.expiresAt : now + 15 * 60000;
    if (row) await ctx.db.patch(row._id, { count, expiresAt }); else await ctx.db.insert("authAttempts", { key, count, expiresAt });
    return count <= (args.signup ? 5 : 15);
  },
});

export const login = action({
  args: { email: v.string(), password: v.string() }, returns: v.any(),
  handler: async (ctx, args): Promise<{ sessionToken: string; user: ReturnType<typeof publicUser> }> => {
    if (args.email.length > 254 || args.password.length > 128) throw new ConvexError("Invalid email or password");
    const allowed: boolean = await ctx.runMutation(internal.auth.reserveAuthAttempt, { key: args.email, signup: false });
    if (!allowed) throw new ConvexError("Too many sign-in attempts. Try again in 15 minutes.");
    return await ctx.runMutation(internal.auth.loginAccount, args);
  },
});

export const signup = action({
  args: { email: v.string(), password: v.string(), name: v.string(), workspaceName: v.optional(v.string()), slug: v.optional(v.string()), inviteToken: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args): Promise<{ sessionToken: string; user: ReturnType<typeof publicUser>; slug: string | null }> => {
    const allowed: boolean = await ctx.runMutation(internal.auth.reserveAuthAttempt, { key: args.email, signup: true });
    if (!allowed) throw new ConvexError("Too many signup attempts. Try again in 15 minutes.");
    return await ctx.runMutation(internal.auth.signupAccount, args);
  },
});

export const revokeOtherSessions = mutation({
  args: { sessionToken: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const result = await getSessionUser(ctx, args.sessionToken);
    if (!result) throw new ConvexError("Your session has expired. Sign in again.");
    await invalidateOtherSessions(ctx, result.user, result.session);
    return null;
  },
});

export const logout = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const result = await getSessionUser(ctx, args.sessionToken);
    if (result) await ctx.db.delete(result.session._id);
    return null;
  },
});

export const changePassword = mutation({
  args: { sessionToken: v.string(), currentPassword: v.string(), newPassword: v.string() },
  handler: async (ctx, args) => {
    if (args.newPassword.length < 10 || args.newPassword.length > 128 || args.currentPassword.length > 128) throw new ConvexError("Use a password between 10 and 128 characters");
    const current = await getSessionUser(ctx, args.sessionToken);
    if (!current) throw new ConvexError("Your session has expired. Sign in again.");
    const { user } = current;
    if (!(await verifyPassword(user, args.currentPassword))) throw new ConvexError("Current password is wrong");
    const passwordRecord = await makePasswordRecord(args.newPassword);
    await ctx.db.patch(user._id, { ...passwordRecord, updatedAt: Date.now() });
    await invalidateOtherSessions(ctx, user, current.session);
    return null;
  },
});

export const acceptInviteAccount = internalMutation({
  args: { inviteToken: v.string(), name: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    if (args.password.length > 128 || args.name.length > 100 || args.inviteToken.length > 128) throw new ConvexError("Invalid invitation details");
    const projectInvite = await ctx.db
      .query("members")
      .withIndex("by_token", (q) => q.eq("inviteToken", args.inviteToken))
      .unique();
    const teamInvite = projectInvite
      ? null
      : await ctx.db
          .query("teamMembers")
          .withIndex("by_token", (q) => q.eq("inviteToken", args.inviteToken))
          .unique();
    const invite = projectInvite ?? teamInvite;
    if (!invite || invite.status !== "invited") throw new ConvexError("Invitation not found");
    const project = projectInvite ? await ctx.db.get(projectInvite.projectId) : null;
    if (projectInvite && !project) throw new ConvexError("Project no longer exists");
    const teamId = project?.teamId ?? teamInvite?.teamId;
    const team = teamId ? await ctx.db.get(teamId) : null;
    if (teamId && (!team || team.deletingAt !== undefined)) throw new ConvexError("Workspace no longer exists");

    const now = Date.now();
    const email = normalizeEmail(invite.email);
    let user = await getUserByEmail(ctx, email);
    if (user) {
      if (user.status !== "active") throw new ConvexError("Account is unavailable");
      if (!(await verifyPassword(user, args.password))) throw new ConvexError("Existing account password is wrong");
      await ctx.db.patch(user._id, { name: args.name.trim() || user.name, updatedAt: now });
    } else {
      if (args.password.length < 10) throw new ConvexError("Password must be at least 10 characters");
      const userId = await createUser(ctx, {
        email,
        name: args.name.trim() || invite.name || email,
        password: args.password,
        role: "user",
      });
      user = await ctx.db.get(userId);
    }
    if (!user) throw new ConvexError("Could not create the account. Try again.");

    const patch = {
      userId: user._id,
      email,
      name: args.name.trim() || invite.name || email,
      status: "active" as const,
      inviteToken: undefined,
      joinedAt: now,
      updatedAt: now,
    };

    if (projectInvite) {
      if (project?.teamId) {
        const membership = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", project.teamId!).eq("email", email)).unique();
        if (membership?.userId && membership.userId !== user._id) throw new ConvexError("Workspace membership belongs to another account");
        const fields = { ...patch, role: projectInvite.role === "viewer" ? "viewer" as const : "member" as const };
        if (!membership) await ctx.db.insert("teamMembers", { teamId: project.teamId, ...fields, createdAt: now });
        else if (membership.status !== "active") await ctx.db.patch(membership._id, fields);
      }
      await ctx.db.patch(projectInvite._id, patch);
      const sessionToken = await createSession(ctx, user._id);
      return { sessionToken, user: publicUser(user), projectId: projectInvite.projectId, teamId: project?.teamId ?? null };
    }

    if (!teamInvite) throw new ConvexError("Invitation not found");
    await ctx.db.patch(teamInvite._id, patch);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", teamInvite.teamId))
      .take(1);
    const sessionToken = await createSession(ctx, user._id);
    return { sessionToken, user: publicUser(user), projectId: projects[0]?._id ?? null, teamId: teamInvite.teamId };
  },
});

export const acceptInvite = action({
  args: { inviteToken: v.string(), name: v.string(), password: v.string() }, returns: v.any(),
  handler: async (ctx, args): Promise<{ sessionToken: string; user: ReturnType<typeof publicUser>; projectId: Id<"projects"> | null; teamId: Id<"teams"> | null }> => {
    if (args.inviteToken.length > 128 || args.password.length > 128 || args.name.length > 100) throw new ConvexError("Invalid invitation details");
    const allowed: boolean = await ctx.runMutation(internal.auth.reserveAuthAttempt, { key: `invite:${args.inviteToken}`, signup: false });
    if (!allowed) throw new ConvexError("Too many attempts. Try again in 15 minutes.");
    return ctx.runMutation(internal.auth.acceptInviteAccount, args);
  },
});
