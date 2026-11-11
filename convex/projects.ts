import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { canEdit, getActiveTeamMember, normalizeEmail, projectMember, projectPeople, requireAdmin, requireMember, requireTeamMember, touchProject } from "./lib/permissions";
import { repositoryUrl } from "./lib/repository";
import { compareProjectOrder, reorderWorkspaceProjects } from "./lib/projectOrder";
import { repoVisibility } from "./integrationTables";
import { callSignalKindValidator, projectIconTypeValidator, projectStatusValidator } from "./lib/validators";
import type { Id, Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { admitStorageReference, issueUpload, storageMetadata, validateUpload } from "./lib/storage";
import { DEFAULT_WORKFLOW_COLUMNS, ensureDraftColumn } from "./lib/columns";
import { DRAFT_COLUMN_TITLE } from "../lib/origin-columns";
const accents = ["#111111", "#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626"];
const callStaleMs = 30_000;

export const listForUser = query({
  args: { sessionToken: v.string(), teamId: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    if (args.teamId) {
      await requireTeamMember(ctx, args.teamId, args.sessionToken);
      const projects = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", args.teamId)).take(500);
      const rows = await Promise.all(projects.sort(compareProjectOrder).map(async project => {
        const member = await projectMember(ctx, project, user);
        return member ? {
        ...project, status: project.status === "active" ? "active" as const : "inactive" as const, memberRole: member.role,
        iconUrl: project.iconStorageId ? await ctx.storage.getUrl(project.iconStorageId) : null,
        openIssueCount: project.openIssueCount ?? (await ctx.db.query("tasks").withIndex("by_project_and_done", q => q.eq("projectId", project._id).eq("done", false)).take(1000)).length,
      } : null; }));
      return rows.filter((row): row is NonNullable<typeof row> => row !== null);
    }
    const memberships = await ctx.db
      .query("members")
      .withIndex("by_email", (q) => q.eq("email", user.email))
      .collect();

    const rows = await Promise.all(
      memberships
        .filter((membership) => membership.status === "active")
        .map(async (membership) => {
          const project = await ctx.db.get(membership.projectId);
          if (!project) return null;
          const member = await projectMember(ctx, project, user);
          if (!member) return null;
          return {
            ...project,
            status: project.status === "active" ? "active" as const : "inactive" as const,
            memberRole: member.role,
            iconUrl: project.iconStorageId ? await ctx.storage.getUrl(project.iconStorageId) : null,
          };
        }),
    );

    return rows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const get = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { member } = await requireMember(ctx, args.projectId, args.sessionToken);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new ConvexError("Project not found");
    return {
      ...project,
      status: project.status === "active" ? "active" as const : "inactive" as const,
      memberRole: member.role,
      iconUrl: project.iconStorageId ? await ctx.storage.getUrl(project.iconStorageId) : null,
    };
  },
});

export const stats = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireMember(ctx, args.projectId, args.sessionToken);
    const [tasks, commits, credentials, designAssets, members] = await Promise.all([
      ctx.db.query("tasks").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect(),
      ctx.db.query("commits").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect(),
      ctx.db.query("credentials").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect(),
      ctx.db.query("designAssets").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect(),
      projectPeople(ctx, project),
    ]);
    const doneTasks = tasks.filter((task) => task.done).length;
    return {
      tasks: tasks.length,
      doneTasks,
      progress: tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0,
      commits: commits.length,
      credentials: credentials.length,
      assets: designAssets.length,
      members: members.filter((member) => member.status === "active").length,
    };
  },
});

export const listChatMessages = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_project_and_createdAt", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(80);
    return messages.reverse();
  },
});

export const sendChatMessage = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, args.sessionToken);
    const body = args.body.trim();
    if (!body) throw new ConvexError("Message required");
    await ctx.db.insert("chatMessages", {
      projectId: args.projectId,
      authorUserId: user._id,
      authorName: user.username || user.name || user.email,
      authorEmail: user.email,
      body,
      createdAt: Date.now(),
    });
    await touchProject(ctx, args.projectId);
  },
});

export const listCallParticipants = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const cutoff = Date.now() - callStaleMs;
    const participants = await ctx.db
      .query("callParticipants")
      .withIndex("by_project_and_lastSeenAt", (q) => q.eq("projectId", args.projectId).gt("lastSeenAt", cutoff))
      .order("asc")
      .take(32);
    return await Promise.all(
      participants.map(async (participant) => ({
        ...participant,
        avatarUrl: participant.avatarStorageId ? await ctx.storage.getUrl(participant.avatarStorageId) : null,
      })),
    );
  },
});

export const joinCall = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    audioEnabled: v.boolean(),
    videoEnabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, args.sessionToken);
    const now = Date.now();
    const existing = await ctx.db
      .query("callParticipants")
      .withIndex("by_project_and_user", (q) => q.eq("projectId", args.projectId).eq("userId", user._id))
      .unique();
    const participant = {
      name: user.name || user.email,
      username: user.username,
      email: user.email,
      avatarStorageId: user.avatarStorageId,
      audioEnabled: args.audioEnabled,
      videoEnabled: args.videoEnabled,
      lastSeenAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, participant);
    } else {
      await ctx.db.insert("callParticipants", {
        projectId: args.projectId,
        userId: user._id,
        joinedAt: now,
        ...participant,
      });
    }
    return user._id;
  },
});

export const updateCallPresence = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    audioEnabled: v.boolean(),
    videoEnabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, args.sessionToken);
    const existing = await ctx.db
      .query("callParticipants")
      .withIndex("by_project_and_user", (q) => q.eq("projectId", args.projectId).eq("userId", user._id))
      .unique();
    if (!existing) return null;
    await ctx.db.patch(existing._id, {
      audioEnabled: args.audioEnabled,
      videoEnabled: args.videoEnabled,
      lastSeenAt: Date.now(),
    });
    return existing._id;
  },
});

export const leaveCall = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, args.sessionToken);
    const existing = await ctx.db
      .query("callParticipants")
      .withIndex("by_project_and_user", (q) => q.eq("projectId", args.projectId).eq("userId", user._id))
      .unique();
    if (existing) await ctx.db.delete(existing._id);

    const incoming = await ctx.db
      .query("callSignals")
      .withIndex("by_project_and_to", (q) => q.eq("projectId", args.projectId).eq("toUserId", user._id))
      .take(100);
    for (const signal of incoming) await ctx.db.delete(signal._id);

    const outgoing = await ctx.db
      .query("callSignals")
      .withIndex("by_project_and_from", (q) => q.eq("projectId", args.projectId).eq("fromUserId", user._id))
      .take(100);
    for (const signal of outgoing) await ctx.db.delete(signal._id);
  },
});

export const sendCallSignal = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    toUserId: v.id("users"),
    kind: callSignalKindValidator,
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, args.sessionToken);
    if (args.toUserId === user._id) throw new ConvexError("Cannot signal yourself");
    if (!args.payload) throw new ConvexError("Signal payload required");
    if (args.payload.length > 80_000) throw new ConvexError("Signal payload too large");
    const recipient = await ctx.db
      .query("callParticipants")
      .withIndex("by_project_and_user", (q) => q.eq("projectId", args.projectId).eq("userId", args.toUserId))
      .unique();
    if (!recipient || recipient.lastSeenAt < Date.now() - callStaleMs) throw new ConvexError("Recipient is not in the call");
    await ctx.db.insert("callSignals", {
      projectId: args.projectId,
      fromUserId: user._id,
      toUserId: args.toUserId,
      kind: args.kind,
      payload: args.payload,
      createdAt: Date.now(),
    });
  },
});

export const listCallSignals = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, args.sessionToken);
    return await ctx.db
      .query("callSignals")
      .withIndex("by_project_and_to_and_createdAt", (q) => q.eq("projectId", args.projectId).eq("toUserId", user._id))
      .order("asc")
      .take(120);
  },
});

export const ackCallSignals = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), signalIds: v.array(v.id("callSignals")) },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, args.sessionToken);
    for (const signalId of args.signalIds.slice(0, 120)) {
      const signal = await ctx.db.get(signalId);
      if (signal?.projectId === args.projectId && signal.toUserId === user._id) {
        await ctx.db.delete(signal._id);
      }
    }
  },
});

export const generateIconUploadUrl = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.projectId, args.sessionToken);
    return issueUpload(ctx, args.sessionToken, { kind: "icon", projectId: args.projectId });
  },
});

export const create = mutation({
  args: {
    sessionToken: v.string(),
    teamId: v.optional(v.id("teams")),
    name: v.string(),
    description: v.optional(v.string()),
    repoUrl: v.optional(v.string()),
    /** "later": no repository is created automatically; the person links or creates one from the project afterwards. */
    githubRepo: v.optional(v.literal("later")),
    /** Who can see the repository Origin creates for the project; private unless chosen. */
    githubRepoVisibility: v.optional(repoVisibility),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    if (!args.teamId) throw new ConvexError("Select a workspace before creating a project");
    const { member } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    if (!canEdit(member)) throw new ConvexError("You have view-only access");
    return createProjectRecord(ctx, { ...args, teamId: args.teamId }, user);
  },
});

export async function createProjectRecord(ctx: MutationCtx, args: { teamId: Id<"teams">; name: string; description?: string; repoUrl?: string; githubRepo?: "later"; githubRepoVisibility?: "private" | "public" }, user: Doc<"users">) {
  if (!args.name.trim() || args.name.length > 100) throw new ConvexError("Enter a project name under 100 characters");
    const repoUrl = repositoryUrl(args.repoUrl);
    const teamMember = await getActiveTeamMember(ctx, args.teamId, user.email);
    const workspaceProjects = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", args.teamId)).take(500);
    const now = Date.now();
    const ownerEmail = normalizeEmail(user.email);
    const projectId = await ctx.db.insert("projects", {
      githubRepoState: repoUrl ? "ready" : args.githubRepo === "later" ? undefined : "pending",
      githubWorkspaceAccess: Boolean(repoUrl && teamMember && ["owner", "admin"].includes(teamMember.role)),
      ...(args.githubRepoVisibility ? { githubRepoVisibility: args.githubRepoVisibility } : {}),
      teamId: args.teamId,
      openIssueCount: 0,
      order: Math.max(-1, ...workspaceProjects.map(p => p.order ?? 0)) + 1,
      name: args.name.trim(),
      description: args.description?.trim() || undefined,
      repoUrl,
      status: "active",
      accent: accents[Math.floor(Math.random() * accents.length)],
      iconType: "default",
      ownerEmail,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("members", {
      projectId,
      userId: user._id,
      email: ownerEmail,
      name: user.name || ownerEmail,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
      joinedAt: now,
    });

    for (const [index, title] of DEFAULT_WORKFLOW_COLUMNS.entries()) {
      await ctx.db.insert("columns", {
        projectId,
        title,
        order: index,
        isDone: false,
        ...(title === DRAFT_COLUMN_TITLE ? { isDraft: true } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!repoUrl && args.githubRepo !== "later") {
      const shared = await ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", args.teamId)).unique();
      if (shared) await ctx.scheduler.runAfter(0, internal.teamGitHub.autoCreate, { projectId });
      else await ctx.scheduler.runAfter(0, internal.integrations.kick, { projectId });
    }
    return projectId;
}

export const reorder = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), projectIds: v.array(v.id("projects")), expectedProjectIds: v.optional(v.array(v.id("projects"))) },
  returns: v.null(),
  handler: reorderWorkspaceProjects,
});

export const importRepos = mutation({
  args: {
    sessionToken: v.string(),
    repos: v.array(
      v.object({
        name: v.string(),
        repoUrl: v.string(),
        description: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    const ownerEmail = normalizeEmail(user.email);
    const existingProjects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerEmail", ownerEmail))
      .take(300);
    const existingRepoUrls = new Set(existingProjects.map((project) => project.repoUrl?.trim().toLowerCase()).filter(Boolean));
    const existingNames = new Set(existingProjects.map((project) => project.name.trim().toLowerCase()));
    const now = Date.now();
    const imported: Array<{ projectId: Id<"projects">; name: string; repoUrl: string; created: boolean }> = [];

    for (const repo of args.repos.slice(0, 100)) {
      const name = repo.name.trim();
      const repoUrl = repo.repoUrl.trim();
      if (!name || !repoUrl) continue;
      const normalizedRepoUrl = repoUrl.toLowerCase();
      const normalizedName = name.toLowerCase();
      const existing = existingProjects.find((project) => {
        return project.repoUrl?.trim().toLowerCase() === normalizedRepoUrl || project.name.trim().toLowerCase() === normalizedName;
      });
      if (existing || existingRepoUrls.has(normalizedRepoUrl) || existingNames.has(normalizedName)) {
        if (existing) {
          const access = await projectMember(ctx, existing, user);
          if (access && canEdit(access)) await ensureDraftColumn(ctx, existing._id);
          imported.push({ projectId: existing._id, name: existing.name, repoUrl: existing.repoUrl || repoUrl, created: false });
        }
        continue;
      }

      const projectId = await ctx.db.insert("projects", {
        name,
        description: repo.description?.trim() || `Imported from ${repoUrl}`,
        repoUrl,
        status: "active",
        accent: accents[imported.length % accents.length],
        iconType: "icon",
        iconValue: "repo",
        ownerEmail,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("members", {
        projectId,
        userId: user._id,
        email: ownerEmail,
        name: user.name || ownerEmail,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
        joinedAt: now,
      });
      for (const [index, title] of DEFAULT_WORKFLOW_COLUMNS.entries()) {
        await ctx.db.insert("columns", {
          projectId,
          title,
          order: index,
          isDone: false,
          ...(title === DRAFT_COLUMN_TITLE ? { isDraft: true } : {}),
          createdAt: now,
          updatedAt: now,
        });
      }
      imported.push({ projectId, name, repoUrl, created: true });
      existingRepoUrls.add(normalizedRepoUrl);
      existingNames.add(normalizedName);
    }

    return imported;
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    repoUrl: v.optional(v.string()),
    status: v.optional(projectStatusValidator),
    iconType: v.optional(projectIconTypeValidator),
    iconValue: v.optional(v.string()),
    iconStorageId: v.optional(v.id("_storage")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, project: existingProject } = await requireAdmin(ctx, args.projectId, args.sessionToken);
    const patch: Partial<{
      name: string;
      status: Doc<"projects">["status"];
      description: string | undefined;
      repoUrl: string | undefined;
      githubWorkspaceAccess: boolean;
      githubRepoId: number | undefined;
      iconType: "default" | "emoji" | "icon" | "image";
      iconValue: string | undefined;
      iconStorageId: Id<"_storage"> | undefined;
      updatedAt: number;
    }> = { updatedAt: Date.now() };
    if (args.name !== undefined) {
      if (!args.name.trim() || args.name.length > 100) throw new ConvexError("Enter a project name under 100 characters");
      patch.name = args.name.trim();
    }
    if (args.status !== undefined) patch.status = args.status;
    if (args.description !== undefined) patch.description = args.description.trim() || undefined;
    if (args.repoUrl !== undefined) {
      patch.repoUrl = repositoryUrl(args.repoUrl);
      if (existingProject.repoUrl !== patch.repoUrl) {
        const teamMember = existingProject.teamId ? await getActiveTeamMember(ctx, existingProject.teamId, user.email) : null;
        patch.githubWorkspaceAccess = Boolean(patch.repoUrl && teamMember && ["owner", "admin"].includes(teamMember.role));
        patch.githubRepoId = undefined;
      }
    }
    if (args.iconType !== undefined) {
      patch.iconType = args.iconType;
      if (args.iconType !== "image") patch.iconStorageId = undefined;
      if (args.iconType === "default") patch.iconValue = undefined;
    }
    if (args.iconValue !== undefined) patch.iconValue = args.iconValue.trim() || undefined;
    if (args.iconStorageId !== undefined) {
      const metadata = await storageMetadata(ctx, args.iconStorageId);
      if (!metadata) throw new ConvexError("File not found");
      validateUpload({ kind: "icon", projectId: args.projectId }, metadata.size, metadata.contentType);
      await admitStorageReference(ctx, args.iconStorageId, user, { kind: "project", projectId: args.projectId });
      patch.iconStorageId = args.iconStorageId;
    }
    await ctx.db.patch(args.projectId, patch);
    if (args.status === "active" && existingProject.githubRepoState === "pending") await ctx.scheduler.runAfter(0, internal.integrations.kick, { projectId: args.projectId });
    return null;
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.projectId, args.sessionToken);
    await ctx.db.patch(args.projectId, { status: "inactive", updatedAt: Date.now() });
    return null;
  },
});
