import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { canEdit, getActiveTeamMember, requireMember, requireTeamAdmin, requireTeamMember, changeOpenIssueCount, touchProject } from "./lib/permissions";
import { hasCurrentMergeReceipt, recordCompletion } from "./lib/completions";
import { DEFAULT_OWNER_EMAIL } from "./lib/auth";
import { isDraftColumn, projectDraftStatus } from "./lib/columns";
import { isLegacyIdeaColumn } from "../lib/origin-columns";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { repositoryUrl } from "./lib/repository";
import { issueStatusChanged } from "./lib/issueEvents";
import { retryPendingMirrorsForTeam } from "./lib/githubIssueSync";

async function inDraft(ctx: QueryCtx, task: Doc<"tasks">) {
  const column = await ctx.db.get(task.columnId);
  if (!column || column.projectId !== task.projectId) throw new ConvexError("Issue workflow column not found");
  if (isDraftColumn(column)) return true;
  if (!isLegacyIdeaColumn(column)) return false;
  const status = await projectDraftStatus(ctx, task.projectId);
  if (status === "unresolved") throw new ConvexError("Workflow repair required before publishing legacy Idea issues");
  return status === "absent";
}

async function completeWithMergeReceipt(ctx: MutationCtx, project: Doc<"projects">, task: Doc<"tasks">) {
  if (project.status !== "active" || !project.githubWorkspaceAccess || task.githubIssueState !== "closed"
    || !hasCurrentMergeReceipt(task, project) || await inDraft(ctx, task)) return false;
  if (!task.done) {
    await recordCompletion(ctx, task, true, task.completionPullRequest!.mergedAt);
    await changeOpenIssueCount(ctx, project._id, -1);
    await ctx.db.patch(task._id, { done: true, updatedAt: Date.now() });
    await issueStatusChanged(ctx, task);
    await touchProject(ctx, project._id);
  }
  return true;
}

async function connection(ctx: QueryCtx, project: Doc<"projects">) {
  const team = project.teamId ? await ctx.db.get(project.teamId) : null;
  const owner = team?.githubConnectedBy ? await ctx.db.get(team.githubConnectedBy) : null;
  const member = owner?.status === "active" && team ? await getActiveTeamMember(ctx, team._id, owner.email) : null;
  return member && ["owner", "admin"].includes(member.role) && team?.githubLogin
    ? { teamId: team._id, login: team.githubLogin, connectedBy: team.githubConnectedBy!, autoCreate: team.githubAutoCreate !== false } : null;
}

export const status = query({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.object({ login: v.union(v.string(), v.null()), connectedBy: v.union(v.id("users"), v.null()), autoCreate: v.boolean() }),
  handler: async (ctx, a) => {
    await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const t = await ctx.db.get(a.teamId);
    const owner = t?.githubConnectedBy ? await ctx.db.get(t.githubConnectedBy) : null;
    const member = owner?.status === "active" ? await getActiveTeamMember(ctx, a.teamId, owner.email) : null;
    const valid = member && ["owner", "admin"].includes(member.role);
    return { login: valid ? t?.githubLogin || null : null, connectedBy: valid ? t?.githubConnectedBy || null : null, autoCreate: t?.githubAutoCreate !== false };
  },
});

export const configure = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), login: v.optional(v.string()), autoCreate: v.optional(v.boolean()), disconnect: v.optional(v.boolean()) }, returns: v.null(),
  handler: async (ctx, a) => {
    const { user } = await requireTeamAdmin(ctx, a.teamId, a.sessionToken);
    if (a.disconnect) await ctx.db.patch(a.teamId, { githubLogin: undefined, githubConnectedBy: undefined, githubAutoCreate: false });
    else {
      await ctx.db.patch(a.teamId, { ...(a.login ? { githubLogin: a.login.slice(0, 100), githubConnectedBy: user._id } : {}), ...(a.autoCreate === undefined ? {} : { githubAutoCreate: a.autoCreate }) });
      // A reconnect should drain backed-off issue mirrors immediately, not after the next backoff window.
      if (a.login) await retryPendingMirrorsForTeam(ctx, a.teamId);
    }
    return null;
  },
});

export const approveRepository = mutation({
  args: { sessionToken: v.string(), projectId: v.id("projects"), repoUrl: v.optional(v.string()) }, returns: v.null(),
  handler: async (ctx, a) => {
    const project = await ctx.db.get(a.projectId);
    if (!project?.teamId || !project.repoUrl) throw new ConvexError("Repository required");
    await requireTeamAdmin(ctx, project.teamId, a.sessionToken);
    if (a.repoUrl !== undefined && project.repoUrl !== a.repoUrl) throw new ConvexError("Repository changed. Reload the project and try again.");
    await ctx.db.patch(project._id, { githubWorkspaceAccess: true }); return null;
  },
});

export const context = internalQuery({
  args: { projectId: v.id("projects"), taskId: v.optional(v.id("tasks")), credentialOwner: v.optional(v.id("users")) }, returns: v.string(),
  handler: async (ctx, a) => {
    const p = await ctx.db.get(a.projectId); if (!p) throw new ConvexError("Project not found");
    const task = a.taskId ? await ctx.db.get(a.taskId) : null;
    if (task && task.projectId !== p._id) throw new ConvexError("Issue not found");
    const credentialOwner = a.credentialOwner ? await ctx.db.get(a.credentialOwner) : null;
    const membership = credentialOwner?.status === "active" && p.teamId ? await getActiveTeamMember(ctx, p.teamId, credentialOwner.email) : null;
    const credentialAllowed = Boolean(membership && ["owner", "admin"].includes(membership.role));
    const team = p.teamId ? await ctx.db.get(p.teamId) : null;
    const teamOwner = team ? await ctx.db.get(team.ownerUserId) : null;
    const legacyOwner = p.ownerEmail === DEFAULT_OWNER_EMAIL && teamOwner?.email === DEFAULT_OWNER_EMAIL && teamOwner.status === "active";
    return JSON.stringify({ credentialAllowed, legacyOwner, project: { _id: p._id, teamId: p.teamId, name: p.name, status: p.status, description: p.description, repoUrl: p.repoUrl, githubRepoId: p.githubRepoId, githubWorkspaceAccess: p.githubWorkspaceAccess, githubRepoVisibility: p.githubRepoVisibility }, connection: await connection(ctx, p),
      task: task ? { _id: task._id, title: task.title, description: task.description, done: task.done, draft: await inDraft(ctx, task), githubIssueNumber: task.githubIssueNumber, githubIssueUrl: task.githubIssueUrl, githubIssueState: task.githubIssueState, githubIssueReopenRequested: task.githubIssueReopenRequested, labels: task.labels ?? [] } : null });
  },
});

export const repoResult = internalMutation({
  args: { projectId: v.id("projects"), state: v.union(v.literal("ready"), v.literal("error"), v.literal("awaiting_connection")), repoUrl: v.optional(v.string()), repoId: v.optional(v.number()), error: v.optional(v.string()) }, returns: v.null(),
  handler: async (ctx, a) => {
    const p = await ctx.db.get(a.projectId); if (!p) return null;
    if (p.repoUrl && p.repoUrl !== a.repoUrl) return null;
    if (a.repoUrl && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(a.repoUrl)) throw new ConvexError("Invalid repository");
    await ctx.db.patch(p._id, { githubRepoState: a.state, githubRepoError: a.error?.slice(0, 300),
      ...(a.repoUrl ? { repoUrl: a.repoUrl, githubRepoId: a.repoId, githubWorkspaceAccess: true } : {}) });
    return null;
  },
});

export const linkIssue = internalMutation({
  args: { projectId: v.id("projects"), taskId: v.id("tasks"), repoUrl: v.string(), number: v.number(), issueUrl: v.string(), state: v.union(v.literal("open"), v.literal("closed")), updatedAt: v.number() }, returns: v.null(),
  handler: async (ctx, a) => {
    const project = await ctx.db.get(a.projectId); const task = await ctx.db.get(a.taskId);
    if (!project || !task || task.projectId !== project._id) throw new ConvexError("Issue not found");
    const normalized = (value?: string) => value?.replace(/\.git\/?$/, "").replace(/\/$/, "").replace(/^https?:\/\/github.com\//, "").toLowerCase();
    if (normalized(project.repoUrl) !== normalized(a.repoUrl)) throw new ConvexError("Repository changed; sync cancelled");
    if (task.githubIssueUrl && normalized(task.githubIssueUrl.split("/issues/")[0]) !== normalized(a.repoUrl)) throw new ConvexError("Issue belongs to the previous repository");
    if (task.githubIssueNumber && task.githubIssueNumber !== a.number) throw new ConvexError("Issue already linked");
    if (a.issueUrl !== `${a.repoUrl}/issues/${a.number}`) throw new ConvexError("Invalid issue URL");
    if ((task.githubIssueUpdatedAt || 0) > a.updatedAt) return null;
    const prDriven = task.githubTaskMode === "pull_request" || Boolean(await ctx.db.query("taskPullRequests").withIndex("by_taskId", q => q.eq("taskId", task._id)).first());
    const reopenedOnGitHub = !prDriven && a.state === "open" && task.githubIssueState === "closed" && task.done;
    const closedOnGitHub = !prDriven && a.state === "closed" && task.githubIssueState === "open" && !task.done && !task.githubIssueReopenRequested && !await inDraft(ctx, task);
    const changed = reopenedOnGitHub || closedOnGitHub;
    if (!changed && task.githubIssueNumber === a.number && task.githubIssueState === a.state && task.githubIssueUpdatedAt === a.updatedAt && task.githubIssueUrl === a.issueUrl && task.teamId === project.teamId && !(a.state === "open" && task.githubIssueReopenRequested)) {
      await completeWithMergeReceipt(ctx, project, task);
      return null;
    }
    if (reopenedOnGitHub) await changeOpenIssueCount(ctx, project._id, 1);
    if (closedOnGitHub) {
      await recordCompletion(ctx, task, true, a.updatedAt);
      await changeOpenIssueCount(ctx, project._id, -1);
    }
    const reopened = a.state === "open" && task.githubIssueState === "closed";
    await ctx.db.patch(task._id, { teamId: project.teamId, githubIssueNumber: a.number, githubIssueUrl: a.issueUrl, githubIssueState: a.state, githubIssueUpdatedAt: a.updatedAt, githubIssueSyncedAt: Date.now(), ...(a.state === "open" ? { githubIssueReopenRequested: undefined } : {}), ...(reopened ? { completionPullRequest: undefined } : {}), ...(changed ? { done: closedOnGitHub, updatedAt: Date.now() } : {}) });
    if (changed) await issueStatusChanged(ctx, task);
    await completeWithMergeReceipt(ctx, project, (await ctx.db.get(task._id))!);
    if (changed || !task.githubIssueNumber) await touchProject(ctx, project._id); return null;
  },
});

/** Forgets the GitHub issue removed for an issue moved back to Draft; leaving Draft creates a new one. */
export const unlinkIssue = internalMutation({
  args: { projectId: v.id("projects"), taskId: v.id("tasks"), number: v.number() }, returns: v.null(),
  handler: async (ctx, a) => {
    const task = await ctx.db.get(a.taskId);
    if (!task || task.projectId !== a.projectId || task.githubIssueNumber !== a.number) return null;
    await ctx.db.patch(task._id, {
      githubIssueNumber: undefined, githubIssueUrl: undefined, githubIssueState: undefined, githubIssueSyncedAt: undefined,
      githubIssueUpdatedAt: undefined, githubIssueReopenRequested: undefined,
    });
    await touchProject(ctx, a.projectId);
    return null;
  },
});

/** Security: only the signed server bridge records head-pinned merge receipts; an issue closure completes the issue without one. */
export const completeMergedIssue = internalMutation({
  args: {
    projectId: v.id("projects"), taskId: v.id("tasks"), repoUrl: v.string(), issueNumber: v.number(),
    pullRequest: v.object({ number: v.number(), headSha: v.string(), mergeSha: v.string(), mergedAt: v.number() }),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { pullRequest } = args;
    if (![args.issueNumber, pullRequest.number].every(number => Number.isSafeInteger(number) && number > 0)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pullRequest.headSha)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pullRequest.mergeSha)
      || !Number.isFinite(pullRequest.mergedAt) || pullRequest.mergedAt <= 0 || pullRequest.mergedAt > Date.now() + 60000) throw new ConvexError("Invalid pull request merge receipt");
    const project = await ctx.db.get(args.projectId);
    const repoUrl = repositoryUrl(args.repoUrl);
    if (!project || project.status !== "active" || !project.githubWorkspaceAccess || !repoUrl
      || repositoryUrl(project.repoUrl)?.toLowerCase() !== repoUrl.toLowerCase()) throw new ConvexError("Repository changed or is not authorized");
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== project._id || task.githubIssueNumber !== args.issueNumber
      || task.githubIssueUrl?.toLowerCase() !== `${repoUrl}/issues/${args.issueNumber}`.toLowerCase()) throw new ConvexError("Issue linkage changed");
    if (await inDraft(ctx, task)) return false;
    const completionPullRequest = { repoUrl, issueNumber: args.issueNumber, ...pullRequest };
    if (JSON.stringify(task.completionPullRequest) !== JSON.stringify(completionPullRequest)) {
      await ctx.db.patch(task._id, { completionPullRequest });
    }
    return completeWithMergeReceipt(ctx, project, { ...task, completionPullRequest });
  },
});

export const targets = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) }, returns: v.string(),
  handler: async (ctx, a) => {
    const batch = await ctx.db.query("tasks").withIndex("by_githubIssueNumber", q => q.gt("githubIssueNumber", 0)).paginate({ cursor: a.cursor, numItems: 10 });
    const rows = [];
    for (const task of batch.page) { const p = await ctx.db.get(task.projectId); if (!p?.repoUrl) continue; rows.push({ taskId: task._id, projectId: p._id, repoUrl: p.repoUrl, number: task.githubIssueNumber, connection: await connection(ctx, p) }); }
    return JSON.stringify({ rows, nextCursor: batch.isDone ? null : batch.continueCursor });
  },
});

export const webhookTargets = internalQuery({
  args: { repoUrl: v.string(), number: v.number() }, returns: v.string(),
  handler: async (ctx, a) => {
    const tasks = await ctx.db.query("tasks").withIndex("by_githubIssueNumber", q => q.eq("githubIssueNumber", a.number)).take(500);
    const rows = [];
    const repo = a.repoUrl.toLowerCase().replace(/^https:\/\/github.com\//, "");
    for (const t of tasks) {
      const p = await ctx.db.get(t.projectId);
      if (p?.repoUrl?.toLowerCase().replace(/^https?:\/\/github.com\//, "").replace(/\.git$/, "").replace(/\/$/, "") === repo) rows.push({ taskId: t._id, projectId: p._id, repoUrl: p.repoUrl, number: t.githubIssueNumber });
    }
    return JSON.stringify(rows);
  },
});

/** Open issues outside the draft column of active, repository-authorized projects that have no GitHub issue yet, for the tick to mirror. */
export const unlinkedTasks = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) }, returns: v.string(),
  handler: async (ctx, a) => {
    const page = await ctx.db.query("projects").paginate({ cursor: a.cursor, numItems: 25 });
    const rows: { projectId: string; taskId: string }[] = [];
    for (const project of page.page) {
      if (project.status !== "active" || !project.repoUrl || !project.githubWorkspaceAccess) continue;
      const open = await ctx.db.query("tasks").withIndex("by_project_and_done", q => q.eq("projectId", project._id).eq("done", false)).take(200);
      const columns = new Map((await ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", project._id)).take(100)).map(column => [column._id, column]));
      let draftStatus: Promise<"present" | "absent" | "unresolved"> | undefined;
      for (const task of open) {
        if (task.githubIssueNumber || rows.length >= 20) continue;
        const column = columns.get(task.columnId) ?? await ctx.db.get(task.columnId);
        if (!column || column.projectId !== project._id || isDraftColumn(column)) continue;
        if (isLegacyIdeaColumn(column)) {
          draftStatus ??= projectDraftStatus(ctx, project._id);
          if (await draftStatus !== "present") continue;
        }
        rows.push({ projectId: project._id, taskId: task._id });
      }
    }
    return JSON.stringify({ rows, nextCursor: page.isDone ? null : page.continueCursor });
  },
});

export const pending = internalQuery({
  args: {}, returns: v.array(v.id("projects")),
  handler: async ctx => (await ctx.db.query("projects").withIndex("by_githubRepoState", q => q.eq("githubRepoState", "pending")).take(100)).filter(p => p.status === "active").slice(0, 20).map(p => p._id),
});

export const backfillIssueLinks = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) }, returns: v.null(),
  handler: async (ctx, a) => {
    const page = await ctx.db.query("taskAssets").paginate({ cursor: a.cursor, numItems: 100 });
    for (const asset of page.page) {
      const match = asset.url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/i);
      if (!match) continue;
      const task = await ctx.db.get(asset.taskId), project = await ctx.db.get(asset.projectId);
      const repo = project?.repoUrl?.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git\/?$/, "").replace(/\/$/, "").toLowerCase();
      if (!task || task.projectId !== asset.projectId || task.githubIssueNumber || repo !== `${match[1]}/${match[2]}`.toLowerCase()) continue;
      await ctx.db.patch(task._id, { githubIssueNumber: Number(match[3]), githubIssueUrl: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}` });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.integrations.backfillIssueLinks, { cursor: page.continueCursor });
    return null;
  },
});

export const retryRepo = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string() }, returns: v.null(),
  handler: async (ctx, a) => {
    const p = await ctx.db.get(a.projectId); if (!p?.teamId || p.repoUrl) throw new ConvexError("No repository to create");
    const { member } = await requireMember(ctx, p._id, a.sessionToken);
    if (!canEdit(member)) throw new ConvexError("You have view-only access");
    await ctx.db.patch(p._id, { githubRepoState: "pending", githubRepoError: undefined });
    const shared = await ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", p.teamId!)).unique();
    if (shared) await ctx.scheduler.runAfter(0, internal.teamGitHub.autoCreate, { projectId: p._id, manual: true });
    else await ctx.scheduler.runAfter(0, internal.integrations.kick, { projectId: p._id });
    return null;
  },
});

/** Wakes the web app's integration worker: one project's repository, the GitHub issue outbox (`issues`), or the periodic tick. */
export const kick = internalAction({
  args: { projectId: v.optional(v.id("projects")), issues: v.optional(v.boolean()) }, returns: v.null(),
  handler: async (_ctx, a) => {
    const secret = process.env.ORIGIN_INTEGRATION_SECRET; const origin = process.env.ORIGIN_PUBLIC_URL;
    if (!secret || !origin) return null;
    const body = JSON.stringify({ at: Date.now(), projectId: a.projectId, ...(a.issues ? { issues: true } : {}) });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), b => b.toString(16).padStart(2, "0")).join("");
    const response = await fetch(`${origin}/api/integrations/tick`, { method: "POST", body, headers: { "x-origin-signature": signature }, signal: AbortSignal.timeout(55000) });
    if (!response.ok) throw new ConvexError(`Integration worker returned ${response.status}`);
    return null;
  },
});

/** The instance operator when ORIGIN_ADMIN_EMAILS is unset: the current owner of the first workspace created here (the Next server records the first answer and keeps it). */
export const instanceOperator = internalQuery({
  args: {}, returns: v.union(v.object({ userId: v.id("users") }), v.null()),
  handler: async ctx => {
    const first = await ctx.db.query("teams").order("asc").first();
    return first ? { userId: first.ownerUserId } : null;
  },
});
