import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authorize, insertConnectorGrant } from "./connectors";
import { hashToken } from "./lib/auth";
import { canEdit, projectMember, projectPeople, requireTeamMember } from "./lib/permissions";
import { compareWorkflowColumns, isDoneColumn, isDraftColumn, normalizeColumnTitle } from "./lib/columns";
import { priorityValidator } from "./lib/validators";
import { addCommentRecord, changeCriteriaRecord, createTaskRecord, moveTaskRecord, updateTaskRecord } from "./tasks";
import { linkedPullRequests, repoName } from "./taskPRs";
import { vaultService } from "../lib/vault-services";
import { repositorySlug } from "../lib/issue-webhook";
import { containsMention, mentionToken } from "../lib/issue-mentions";
import { OAUTH_GRANT_PREFIX, PAT_PREFIX } from "../lib/mcp-tokens";
import { compareTaskOrder } from "../lib/task-order";
import { issueKey } from "../lib/github-references";
import { taskBranch } from "../lib/task-branch";
import { cleanLabels, projectLabels } from "./lib/labels";
import { addCriteria } from "../lib/acceptance-criteria";

// Tools for the remote MCP server (app/api/mcp). Every call carries a connector token (OAuth grant or personal
// access token, both stored as connectorGrants) and runs with the token owner's workspace and project permissions.
// Results are JSON strings; `url` fields are app-relative and made absolute by the Next route.

type Ctx = QueryCtx | MutationCtx;
type Access = Awaited<ReturnType<typeof authorize>>;

const json = (value: unknown) => JSON.stringify(value);
const fold = (value: string) => value.trim().toLowerCase();

async function workspaceSlug(ctx: Ctx, teamId: Id<"teams">) {
  const team = await ctx.db.get(teamId);
  return team?.slug ?? teamId;
}

/** Board columns: done columns are hidden on the board and their issues show in Todo (or the first column). */
async function boardColumns(ctx: Ctx, projectId: Id<"projects">) {
  const all = (await ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", projectId)).take(200)).sort(compareWorkflowColumns);
  const visible = all.filter(column => !isDoneColumn(column));
  const fallback = visible.find(column => normalizeColumnTitle(column.title) === "todo") ?? visible[0];
  const ids = new Set(visible.map(column => column._id));
  return { visible, columnFor: (task: Doc<"tasks">) => ids.has(task.columnId) ? task.columnId : fallback?._id };
}
const columnSummary = (column: Doc<"columns">) => ({ id: column._id, name: column.title, ...(isDraftColumn(column) ? { draft: true } : {}) });

async function visibleProjects(ctx: Ctx, access: Access, includeInactive = false) {
  const rows = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", access.grant.teamId)).take(500);
  const visible = [];
  for (const project of rows) {
    if (!includeInactive && project.status !== "active") continue;
    const member = await projectMember(ctx, project, access.user);
    if (member) visible.push({ project, member });
  }
  return visible.sort((a, b) => a.project.name.localeCompare(b.project.name));
}

async function resolveProject(ctx: Ctx, access: Access, ref: string) {
  const id = ctx.db.normalizeId("projects", ref.trim());
  let project = id ? await ctx.db.get(id) : null;
  if (!project) {
    const matches = (await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", access.grant.teamId)).take(500)).filter(p => fold(p.name) === fold(ref));
    project = matches.find(p => p.status === "active") ?? matches[0] ?? null;
  }
  const member = project?.teamId === access.grant.teamId ? await projectMember(ctx, project, access.user) : null;
  if (!project || !member) throw new ConvexError(`Project not found: ${ref}`);
  return { project, member };
}

/** An issue by id, or by its key (ORI-AB12) when exactly one issue the token can see has it. */
async function findIssue(ctx: Ctx, access: Access, ref: string) {
  const id = ctx.db.normalizeId("tasks", ref.trim());
  if (id) return ctx.db.get(id);
  if (!/^ORI-[0-9A-Z]{4}$/i.test(ref.trim())) return null;
  const key = ref.trim().toUpperCase();
  const found: Doc<"tasks">[] = [];
  for (const { project } of await visibleProjects(ctx, access, true)) {
    for (const task of await ctx.db.query("tasks").withIndex("by_project", q => q.eq("projectId", project._id)).take(5000)) if (issueKey(task._id) === key) found.push(task);
    if (found.length > 1) throw new ConvexError(`${key} matches more than one issue. Use the issue id from list_issues.`);
  }
  return found[0] ?? null;
}

async function resolveIssue(ctx: Ctx, access: Access, ref: string, write = false) {
  const task = await findIssue(ctx, access, ref);
  const project = task ? await ctx.db.get(task.projectId) : null;
  const member = project?.teamId === access.grant.teamId ? await projectMember(ctx, project, access.user) : null;
  if (!task || !project || !member) throw new ConvexError(`Issue not found: ${ref}. Use the issue id or key from list_issues.`);
  if (write && !canEdit(member)) throw new ConvexError("You have read-only access to this project");
  return { task, project, member };
}

function findColumn(columns: Doc<"columns">[], ref: string) {
  const column = columns.find(c => c._id === ref.trim()) ?? columns.find(c => normalizeColumnTitle(c.title) === normalizeColumnTitle(ref));
  if (!column) throw new ConvexError(`Column not found: ${ref}. Columns: ${columns.map(c => c.title).join(", ")}`);
  return column;
}

function issueSummary(slug: string, project: Doc<"projects">, task: Doc<"tasks">, column?: Doc<"columns">) {
  return {
    id: task._id, key: issueKey(task._id), title: task.title, project: project.name, projectId: project._id,
    column: column?.title ?? null, status: task.done ? "completed" : "open", priority: task.priority,
    assignee: task.assignedToEmail ? { name: task.assignedToName || task.assignedToEmail, email: task.assignedToEmail } : null,
    dueDate: task.dueDate ?? null, ...(task.labels?.length ? { labels: task.labels } : {}),
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    ...(task.githubIssueUrl ? { github: task.githubIssueUrl } : {}),
    updatedAt: new Date(task.updatedAt).toISOString(), url: `/${slug}?project=${project._id}&issue=${task._id}`,
  };
}

async function assigneeMatcher(ctx: Ctx, access: Access, ref?: string) {
  if (!ref?.trim()) return () => true;
  const value = fold(ref).replace(/^@/, "");
  if (value === "me") return (task: Doc<"tasks">) => task.assignedToEmail === access.user.email;
  if (["none", "unassigned"].includes(value)) return (task: Doc<"tasks">) => !task.assignedToEmail;
  const emails = new Set([value]);
  for (const row of await ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", access.grant.teamId)).take(500)) {
    const user = row.userId ? await ctx.db.get(row.userId) : null;
    if (user && (user.username?.toLowerCase() === value || fold(user.name) === value)) emails.add(user.email.toLowerCase());
  }
  return (task: Doc<"tasks">) => Boolean(task.assignedToEmail && (emails.has(task.assignedToEmail.toLowerCase()) || fold(task.assignedToName || "") === value));
}

const token = { token: v.string() };

/** Convex hides plain error messages from clients in production; tool errors must reach the agent. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw error instanceof ConvexError ? error : new ConvexError(error instanceof Error ? error.message : "Request failed"); }
}

export const workspace = query({
  args: token, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const team = await ctx.db.get(access.grant.teamId);
    const projects = await visibleProjects(ctx, access);
    return json({
      workspace: { id: access.grant.teamId, name: team?.name ?? "", url: `/${team?.slug ?? access.grant.teamId}` },
      you: { name: access.user.name, email: access.user.email, mention: mentionToken(access.user), role: access.member.role },
      access: access.grant.write && canEdit(access.member) ? "read_write" : "read",
      projects: projects.map(({ project, member }) => ({ id: project._id, name: project.name, openIssues: project.openIssueCount ?? null, ...(canEdit(member) ? {} : { readOnly: true }) })),
    });
  }),
});

export const projects = query({
  args: { ...token, includeInactive: v.optional(v.boolean()) }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const rows = await visibleProjects(ctx, access, a.includeInactive);
    return json({ projects: await Promise.all(rows.map(async ({ project, member }) => ({
      id: project._id, name: project.name, ...(project.description ? { description: project.description } : {}), status: project.status,
      openIssues: project.openIssueCount ?? null, columns: (await boardColumns(ctx, project._id)).visible.map(columnSummary),
      labels: await projectLabels(ctx, project._id, 50),
      ...(project.repoUrl ? { repository: project.repoUrl } : {}), ...(canEdit(member) ? {} : { readOnly: true }),
    }))) });
  }),
});

export const issues = query({
  args: { ...token, project: v.optional(v.string()), column: v.optional(v.string()), status: v.optional(v.union(v.literal("open"), v.literal("completed"), v.literal("all"))),
    assignee: v.optional(v.string()), label: v.optional(v.string()), text: v.optional(v.string()), limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const slug = await workspaceSlug(ctx, access.grant.teamId);
    const projects = a.project ? [await resolveProject(ctx, access, a.project)] : await visibleProjects(ctx, access);
    const status = a.status ?? "open";
    const limit = Math.max(1, Math.min(100, Math.floor(a.limit ?? 25)));
    const skip = Math.max(0, Number.parseInt(a.cursor || "0", 10) || 0);
    const assignee = await assigneeMatcher(ctx, access, a.assignee);
    const label = a.label ? fold(a.label) : "";
    const text = a.text ? fold(a.text) : "";
    let columnMatched = !a.column;
    const results = [];
    let matched = 0;
    // Filter first, then page, so every page is full. Order: project name, board column order, board card order;
    // completed issues follow, newest first (like the Completed view).
    outer: for (const { project } of projects) {
      const { visible, columnFor } = await boardColumns(ctx, project._id);
      let columns = visible;
      if (a.column) {
        const wanted = visible.filter(c => c._id === a.column!.trim() || normalizeColumnTitle(c.title) === normalizeColumnTitle(a.column!));
        if (!wanted.length) continue;
        columnMatched = true; columns = wanted;
      }
      const byId = new Map(visible.map(c => [c._id as string, c]));
      const rank = new Map(columns.map((c, index) => [c._id as string, index]));
      const tasks = (await ctx.db.query("tasks").withIndex("by_project", q => q.eq("projectId", project._id)).take(5000)).filter(task => {
        const column = columnFor(task);
        if (!column || !rank.has(column)) return false;
        if (status === "open" ? task.done : status === "completed" ? !task.done : false) return false;
        if (!assignee(task)) return false;
        if (label && !task.labels?.some(l => fold(l) === label)) return false;
        if (text && !`${task.title}\n${task.description ?? ""}\n${issueKey(task._id)}`.toLowerCase().includes(text)) return false;
        return true;
      });
      const open = tasks.filter(t => !t.done).sort((x, y) => rank.get(columnFor(x)!)! - rank.get(columnFor(y)!)! || compareTaskOrder(x, y));
      const completed = tasks.filter(t => t.done).sort((x, y) => y.updatedAt - x.updatedAt);
      for (const task of [...open, ...completed]) {
        if (matched++ < skip) continue;
        if (results.length === limit) { matched = -1; break outer; }
        results.push(issueSummary(slug, project, task, byId.get(columnFor(task)!)));
      }
    }
    if (!columnMatched) throw new ConvexError(`Column not found: ${a.column}`);
    return json({ issues: results, nextCursor: matched === -1 ? String(skip + limit) : null });
  }),
});

export const issue = query({
  args: { ...token, issueId: v.string() }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const { task, project } = await resolveIssue(ctx, access, a.issueId);
    const slug = await workspaceSlug(ctx, access.grant.teamId);
    const { visible, columnFor } = await boardColumns(ctx, project._id);
    const comments = await ctx.db.query("taskComments").withIndex("by_task", q => q.eq("taskId", task._id)).order("desc").take(100);
    return json({
      ...issueSummary(slug, project, task, visible.find(c => c._id === columnFor(task))),
      description: task.description ?? "",
      createdAt: new Date(task.createdAt).toISOString(),
      ...(project.repoUrl ? { branch: taskBranch(task) } : {}),
      pullRequests: (await ctx.db.query("taskPullRequests").withIndex("by_taskId", q => q.eq("taskId", task._id)).take(20)).map(pr => ({
        number: pr.number, url: pr.url, ...(pr.title ? { title: pr.title } : {}), state: pr.state, checks: pr.checks, review: pr.review, completesOnMerge: pr.closes !== false,
      })),
      comments: comments.reverse().map(c => ({ id: c._id, author: c.authorName, email: c.authorEmail, body: c.body, createdAt: new Date(c.createdAt).toISOString() })),
    });
  }),
});

export const members = query({
  args: { ...token, project: v.optional(v.string()) }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    if (a.project) {
      const { project } = await resolveProject(ctx, access, a.project);
      return json({ members: (await projectPeople(ctx, project)).map(p => ({ name: p.name, email: p.email, mention: mentionToken(p), role: p.role })) });
    }
    const rows = await ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", access.grant.teamId)).take(500);
    const people = [];
    for (const row of rows) {
      const user = row.userId ? await ctx.db.get(row.userId) : null;
      if (row.status === "active" && user?.status === "active") people.push({ name: user.name, email: user.email, mention: mentionToken(user), role: row.role });
    }
    return json({ members: people });
  }),
});

export const inbox = query({
  args: token, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const slug = await workspaceSlug(ctx, access.grant.teamId);
    const projects = await visibleProjects(ctx, access);
    const assigned = [];
    for (const { project } of projects) {
      const { visible, columnFor } = await boardColumns(ctx, project._id);
      const tasks = await ctx.db.query("tasks").withIndex("by_projectId_and_done_and_assignedToEmail", q => q.eq("projectId", project._id).eq("done", false).eq("assignedToEmail", access.user.email)).take(200);
      for (const task of tasks) assigned.push(issueSummary(slug, project, task, visible.find(c => c._id === columnFor(task))));
    }
    assigned.sort((x, y) => (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999") || y.updatedAt.localeCompare(x.updatedAt));
    const allowed = new Map(projects.map(p => [p.project._id as string, p.project]));
    const rows = await ctx.db.query("notifications").withIndex("by_user_team_read", q => q.eq("userId", access.user._id).eq("teamId", access.grant.teamId).eq("read", false)).order("desc").take(100);
    const notifications = [];
    for (const row of rows) {
      if (!["assignment", "comment", "mention"].includes(row.kind) || !row.taskId || !row.projectId || !allowed.has(row.projectId)) continue;
      const task = await ctx.db.get(row.taskId);
      if (!task) continue;
      const actor = await ctx.db.get(row.actorId);
      notifications.push({ kind: row.kind, issueId: task._id, issue: task.title, project: allowed.get(row.projectId)!.name, from: actor?.name ?? null, ...(row.preview ? { preview: row.preview } : {}), createdAt: new Date(row.createdAt).toISOString() });
      if (notifications.length === 30) break;
    }
    return json({ assigned: assigned.slice(0, 100), unread: notifications });
  }),
});

async function writer(ctx: MutationCtx, tokenValue: string) {
  return authorize(ctx, tokenValue, true);
}

async function assigneeEmail(ctx: MutationCtx, access: Access, project: Doc<"projects">, ref: string) {
  const value = fold(ref).replace(/^@/, "");
  if (value === "me") return access.user.email;
  const people = await projectPeople(ctx, project);
  const person = people.find(p => p.email.toLowerCase() === value) ?? people.find(p => p.username?.toLowerCase() === value) ?? people.find(p => fold(p.name) === value);
  if (!person) throw new ConvexError(`No project member matches "${ref}". Use list_members.`);
  return person.email;
}

const UNASSIGNED = new Set(["none", "unassigned"]);

export const createIssue = mutation({
  args: { ...token, project: v.string(), title: v.string(), description: v.optional(v.string()), column: v.optional(v.string()), priority: v.optional(priorityValidator), assignee: v.optional(v.string()), dueDate: v.optional(v.string()), labels: v.optional(v.array(v.string())), acceptanceCriteria: v.optional(v.array(v.string())) },
  returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await writer(ctx, a.token);
    const { project, member } = await resolveProject(ctx, access, a.project);
    if (!canEdit(member)) throw new ConvexError("You have read-only access to this project");
    const { visible } = await boardColumns(ctx, project._id);
    const column = a.column ? findColumn(visible, a.column) : undefined;
    const email = UNASSIGNED.has(fold(a.assignee ?? "me")) ? undefined : await assigneeEmail(ctx, access, project, a.assignee ?? "me");
    const acceptanceCriteria = a.acceptanceCriteria?.length ? addCriteria([], a.acceptanceCriteria) : undefined;
    const taskId = await createTaskRecord(ctx, { projectId: project._id, columnId: column?._id, title: a.title, description: a.description, priority: a.priority ?? "medium", assignedToEmail: email, dueDate: a.dueDate || undefined, labels: a.labels, acceptanceCriteria }, access.user._id);
    const task = (await ctx.db.get(taskId))!;
    const placed = await ctx.db.get(task.columnId);
    return json(issueSummary(await workspaceSlug(ctx, access.grant.teamId), project, task, placed ?? undefined));
  }),
});

export const updateIssue = mutation({
  args: { ...token, issueId: v.string(), title: v.optional(v.string()), description: v.optional(v.string()), priority: v.optional(priorityValidator), assignee: v.optional(v.string()), dueDate: v.optional(v.string()), labels: v.optional(v.array(v.string())) },
  returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await writer(ctx, a.token);
    const { task, project } = await resolveIssue(ctx, access, a.issueId, true);
    // "none" clears the assignee or due date (an empty value clears it in updateTaskRecord).
    const assignedToEmail = a.assignee === undefined ? undefined : UNASSIGNED.has(fold(a.assignee)) ? "" : await assigneeEmail(ctx, access, project, a.assignee);
    const dueDate = a.dueDate === undefined ? undefined : fold(a.dueDate) === "none" ? "" : a.dueDate;
    const labels = a.labels ? cleanLabels(a.labels, await projectLabels(ctx, project._id)) : undefined;
    if (labels) await ctx.db.patch(task._id, { labels });
    await updateTaskRecord(ctx, { projectId: project._id, taskId: task._id, title: a.title, description: a.description, priority: a.priority, assignedToEmail, dueDate }, access.user._id);
    return issueResult(ctx, access, task._id);
  }),
});

export const moveIssue = mutation({
  args: { ...token, issueId: v.string(), column: v.optional(v.string()), before: v.optional(v.string()), position: v.optional(v.union(v.literal("top"), v.literal("bottom"))), completed: v.optional(v.boolean()) },
  returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await writer(ctx, a.token);
    const { task, project } = await resolveIssue(ctx, access, a.issueId, true);
    if (!a.column && a.completed === undefined && !a.before && !a.position) throw new ConvexError("Give a column, a position or completed");
    const { visible, columnFor } = await boardColumns(ctx, project._id);
    const column = a.column ? findColumn(visible, a.column) : visible.find(c => c._id === columnFor(task));
    if (column && (a.column || a.before || a.position)) {
      let beforeTaskId: Id<"tasks"> | undefined;
      if (a.before) {
        const before = await resolveIssue(ctx, access, a.before);
        if (before.task.projectId !== project._id || columnFor(before.task) !== column._id) throw new ConvexError("`before` must be an issue in the target column");
        if (before.task._id === task._id) throw new ConvexError("`before` must be another issue");
        beforeTaskId = before.task._id;
      } else if (a.position === "top") {
        const first = (await ctx.db.query("tasks").withIndex("by_column_order", q => q.eq("columnId", column._id)).take(200)).find(t => t._id !== task._id && !t.done);
        beforeTaskId = first?._id;
      }
      await moveTaskRecord(ctx, { projectId: project._id, taskId: task._id, columnId: column._id, beforeTaskId });
    }
    const current = (await ctx.db.get(task._id))!;
    const done = a.completed ?? (a.column ? false : current.done);
    if (done !== current.done) await updateTaskRecord(ctx, { projectId: project._id, taskId: task._id, done }, access.user._id);
    return issueResult(ctx, access, task._id);
  }),
});

export const addComment = mutation({
  args: { ...token, issueId: v.string(), body: v.string() }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await writer(ctx, a.token);
    const { task, project } = await resolveIssue(ctx, access, a.issueId, true);
    // Resolve @mentions the same way the comment box does: a project member's @username (or @name) in the text.
    const mentions = (await projectPeople(ctx, project)).filter(p => containsMention(a.body, mentionToken(p))).slice(0, 20).map(p => ({ userId: p.userId, token: mentionToken(p) }));
    const commentId = await addCommentRecord(ctx, { projectId: project._id, taskId: task._id, body: a.body, mentions }, access.user, project);
    return json({ id: commentId, issueId: task._id, mentioned: mentions.map(m => m.token) });
  }),
});

export const addAcceptanceCriteria = mutation({
  args: { ...token, issueId: v.string(), items: v.array(v.string()) }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await writer(ctx, a.token);
    const { task } = await resolveIssue(ctx, access, a.issueId, true);
    await changeCriteriaRecord(ctx, task, { add: a.items });
    return issueResult(ctx, access, task._id);
  }),
});

export const updateAcceptanceCriteria = mutation({
  args: {
    ...token, issueId: v.string(),
    changes: v.optional(v.array(v.object({ index: v.optional(v.number()), match: v.optional(v.string()), text: v.optional(v.string()), checked: v.optional(v.boolean()), remove: v.optional(v.boolean()) }))),
    replace: v.optional(v.array(v.object({ text: v.string(), checked: v.optional(v.boolean()) }))),
  },
  returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await writer(ctx, a.token);
    const { task } = await resolveIssue(ctx, access, a.issueId, true);
    if ((a.changes === undefined) === (a.replace === undefined)) throw new ConvexError("Give either changes or replace");
    await changeCriteriaRecord(ctx, task, a.replace ? { replace: a.replace } : { edits: a.changes! });
    return issueResult(ctx, access, task._id);
  }),
});

// Assets: project library files (designAssets) and issue attachments (taskAssets). Library files stored in Convex get
// the same signed URL the Assets tab shows; files attached to issues stay behind Origin's sign-in, so their url is null
// and `issue.url` opens the issue that has them.

type AssetRow = { id: string; name: string; kind: string; url: string | null; project: string; projectId: string; issue: { id: string; key: string; title: string; url: string } | null; contentType?: string; size?: number; folder?: string; notes?: string; createdAt: string };

async function libraryAsset(ctx: QueryCtx, project: Doc<"projects">, asset: Doc<"designAssets">, notes = false): Promise<AssetRow> {
  return {
    id: asset._id, name: asset.name, kind: asset.type, url: asset.storageId ? await ctx.storage.getUrl(asset.storageId) : asset.url ?? null,
    project: project.name, projectId: project._id, issue: null,
    ...(asset.contentType ? { contentType: asset.contentType } : {}), ...(asset.size !== undefined ? { size: asset.size } : {}), ...(asset.folder ? { folder: asset.folder } : {}),
    ...(notes && asset.notes ? { notes: asset.notes } : {}), createdAt: new Date(asset.createdAt).toISOString(),
  };
}

function issueAsset(slug: string, project: Doc<"projects">, task: Doc<"tasks">, asset: Doc<"taskAssets">, notes = false): AssetRow {
  return {
    id: asset._id, name: asset.name, kind: asset.type, url: asset.localFileId ? null : asset.url || null,
    project: project.name, projectId: project._id, issue: { id: task._id, key: issueKey(task._id), title: task.title, url: `/${slug}?project=${project._id}&issue=${task._id}` },
    ...(asset.contentType ? { contentType: asset.contentType } : {}), ...(asset.size !== undefined ? { size: asset.size } : {}),
    ...(notes && asset.notes ? { notes: asset.notes } : {}), createdAt: new Date(asset.createdAt).toISOString(),
  };
}

export const assets = query({
  args: { ...token, project: v.optional(v.string()), issueId: v.optional(v.string()), limit: v.optional(v.number()) }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const slug = await workspaceSlug(ctx, access.grant.teamId);
    const limit = Math.max(1, Math.min(200, Math.floor(a.limit ?? 50)));
    const rows: AssetRow[] = [];
    if (a.issueId) {
      const { task, project } = await resolveIssue(ctx, access, a.issueId);
      for (const asset of await ctx.db.query("taskAssets").withIndex("by_task", q => q.eq("taskId", task._id)).take(200)) rows.push(issueAsset(slug, project, task, asset));
    } else {
      for (const { project } of a.project ? [await resolveProject(ctx, access, a.project)] : await visibleProjects(ctx, access)) {
        for (const asset of await ctx.db.query("designAssets").withIndex("by_project", q => q.eq("projectId", project._id)).take(500)) rows.push(await libraryAsset(ctx, project, asset));
        const tasks = new Map<Id<"tasks">, Doc<"tasks"> | null>();
        for (const asset of await ctx.db.query("taskAssets").withIndex("by_project", q => q.eq("projectId", project._id)).take(500)) {
          if (!tasks.has(asset.taskId)) tasks.set(asset.taskId, await ctx.db.get(asset.taskId));
          const task = tasks.get(asset.taskId);
          if (task?.projectId === project._id) rows.push(issueAsset(slug, project, task, asset));
        }
      }
    }
    rows.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return json({ assets: rows.slice(0, limit), ...(rows.length > limit ? { more: rows.length - limit } : {}) });
  }),
});

export const asset = query({
  args: { ...token, assetId: v.string() }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const missing = new ConvexError(`Asset not found: ${a.assetId}. Use an id from list_assets.`);
    const libraryId = ctx.db.normalizeId("designAssets", a.assetId.trim());
    const issueAssetId = ctx.db.normalizeId("taskAssets", a.assetId.trim());
    const row = libraryId ? await ctx.db.get(libraryId) : issueAssetId ? await ctx.db.get(issueAssetId) : null;
    const project = row ? await ctx.db.get(row.projectId) : null;
    if (!row || !project || project.teamId !== access.grant.teamId || !await projectMember(ctx, project, access.user)) throw missing;
    if (libraryId) return json(await libraryAsset(ctx, project, row as Doc<"designAssets">, true));
    const attachment = row as Doc<"taskAssets">;
    const task = await ctx.db.get(attachment.taskId);
    if (!task || task.projectId !== project._id) throw missing;
    return json(issueAsset(await workspaceSlug(ctx, access.grant.teamId), project, task, attachment, true));
  }),
});

// Vault: only items a member marked "agents may use" (credentials.setAgentUse) in projects the token owner belongs to,
// and the owner's own personal items marked the same way. Values are end-to-end encrypted with the Vault passphrase:
// Convex returns the sealed envelope only for allowed items, and the MCP route (lib/mcp-vault.ts) opens it with the
// passphrase the agent passes, for that call only. Nothing here ever sees or logs a plaintext value.

type VaultRow = Doc<"credentials"> | Doc<"personalCredentials">;
function vaultSummary(item: VaultRow, project: Doc<"projects"> | null) {
  const service = item.kind === "service" ? vaultService(item.service) : undefined;
  return {
    id: item._id, name: item.title, kind: item.kind ?? "password", service: service?.id ?? null,
    env: service?.fields.map(field => field.env) ?? [], scope: project ? "project" : "personal",
    project: project?.name ?? null, projectId: project?._id ?? null, ...(item.username ? { username: item.username } : {}),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}

export const vaultItems = query({
  args: { ...token, project: v.optional(v.string()) }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const items = [];
    for (const { project } of a.project ? [await resolveProject(ctx, access, a.project)] : await visibleProjects(ctx, access)) {
      for (const item of await ctx.db.query("credentials").withIndex("by_project", q => q.eq("projectId", project._id)).take(500)) if (item.agentUse) items.push(vaultSummary(item, project));
    }
    if (!a.project) for (const item of await ctx.db.query("personalCredentials").withIndex("by_userId", q => q.eq("userId", access.user._id)).take(500)) if (item.agentUse) items.push(vaultSummary(item, null));
    return json({ items, note: "Only items a member allowed agents to use are listed. vault_get needs the Vault passphrase to read a value." });
  }),
});

export const vaultItem = query({
  args: { ...token, itemId: v.string() }, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const projectItemId = ctx.db.normalizeId("credentials", a.itemId.trim());
    const personalItemId = ctx.db.normalizeId("personalCredentials", a.itemId.trim());
    let item: VaultRow | null = null, project: Doc<"projects"> | null = null;
    if (projectItemId) {
      item = await ctx.db.get(projectItemId);
      project = item ? await ctx.db.get((item as Doc<"credentials">).projectId) : null;
      if (!project || project.teamId !== access.grant.teamId || !await projectMember(ctx, project, access.user)) item = null;
    } else if (personalItemId) {
      item = await ctx.db.get(personalItemId);
      if (item && (item as Doc<"personalCredentials">).userId !== access.user._id) item = null;
    }
    if (!item) throw new ConvexError(`Vault item not found: ${a.itemId}. Use an id from vault_list.`);
    if (!item.agentUse) throw new ConvexError(`Agents may not use "${item.title}". A member can allow agent use for it in the Vault.`);
    return json({ ...vaultSummary(item, project), sealed: { ciphertext: item.ciphertext, iv: item.iv, salt: item.salt, iterations: item.iterations, kdf: item.kdf } });
  }),
});

// Repositories and the pull requests linked to their issues (taskPRs.linkedPullRequests, as in the Pull requests tab).

export const repositories = query({
  args: token, returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const rows = (await visibleProjects(ctx, access)).filter(({ project }) => project.repoUrl);
    return json({ repositories: rows.map(({ project }) => ({ project: project.name, projectId: project._id, repo: repositorySlug(project.repoUrl) ?? repoName(project.repoUrl) ?? project.repoUrl, url: project.repoUrl })) });
  }),
});

export const pullRequests = query({
  args: { ...token, project: v.optional(v.string()), state: v.optional(v.union(v.literal("open"), v.literal("merged"), v.literal("closed"), v.literal("all"))), limit: v.optional(v.number()) },
  returns: v.string(),
  handler: (ctx, a) => guard(async () => {
    const access = await authorize(ctx, a.token);
    const slug = await workspaceSlug(ctx, access.grant.teamId);
    const state = a.state ?? "open";
    const limit = Math.max(1, Math.min(100, Math.floor(a.limit ?? 25)));
    const results = [];
    for (const { project } of a.project ? [await resolveProject(ctx, access, a.project)] : await visibleProjects(ctx, access)) {
      for (const pr of await linkedPullRequests(ctx, project._id)) {
        if (state !== "all" && (state === "open" ? pr.state !== "open" && pr.state !== "draft" : pr.state !== state)) continue;
        results.push({
          number: pr.number, title: pr.title, state: pr.state, url: pr.url, repo: pr.repository, branch: pr.branch,
          checks: pr.checks, review: pr.review, ...(pr.mergeable !== null ? { mergeable: pr.mergeable } : {}), ...(pr.author ? { author: pr.author } : {}),
          project: project.name, projectId: project._id, updatedAt: new Date(pr.updatedAt).toISOString(),
          issues: pr.issues.map(issue => ({ id: issue.taskId, key: issue.key, title: issue.title, completed: issue.done, completesOnMerge: issue.completesOnMerge, url: `/${slug}?project=${project._id}&issue=${issue.taskId}` })),
        });
      }
    }
    results.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    return json({ pullRequests: results.slice(0, limit) });
  }),
});

async function issueResult(ctx: MutationCtx, access: Access, taskId: Id<"tasks">) {
  const task = (await ctx.db.get(taskId))!;
  const project = (await ctx.db.get(task.projectId))!;
  const { visible, columnFor } = await boardColumns(ctx, project._id);
  return json(issueSummary(await workspaceSlug(ctx, access.grant.teamId), project, task, visible.find(c => c._id === columnFor(task))));
}

// Personal access tokens: connector grants created from Settings and shown once. OAuth grants are created by the
// consent screen through connectors.createGrant; both are listed and revoked with connectors.listGrants/revoke.
export const createToken = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), name: v.string(), write: v.boolean(), days: v.optional(v.number()) },
  returns: v.object({ token: v.string(), grantId: v.id("connectorGrants"), expiresAt: v.number() }),
  handler: (ctx, a) => guard(async () => {
    const { user, member } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    if (a.write && !canEdit(member)) throw new ConvexError("You have view-only access to this workspace");
    const name = a.name.trim().slice(0, 120);
    if (!name) throw new ConvexError("Name the token");
    const days = [30, 90, 365].includes(a.days ?? 90) ? a.days ?? 90 : 90;
    const active = await ctx.db.query("connectorGrants").withIndex("by_userId_and_teamId_and_runId_and_hostId_and_revoked", q => q.eq("userId", user._id).eq("teamId", a.teamId).eq("runId", undefined).eq("hostId", undefined).eq("revoked", false)).take(51);
    if (active.filter(g => g.expiresAt > Date.now()).length >= 50) throw new ConvexError("Revoke an unused connection first");
    const token = PAT_PREFIX + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = Date.now() + days * 86400000;
    const grantId = await ctx.db.insert("connectorGrants", { teamId: a.teamId, userId: user._id, name, tokenHash: await hashToken(token), write: a.write, expiresAt, createdAt: Date.now(), revoked: false });
    return { token, grantId, expiresAt };
  }),
});

/** Grant behind an OAuth consent (app/api/oauth/consent). Its token is held only by the Next server. */
export const createOAuthGrant = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), name: v.string(), write: v.boolean() },
  returns: v.object({ token: v.string(), grantId: v.id("connectorGrants"), expiresAt: v.number() }),
  handler: (ctx, a) => guard(() => insertConnectorGrant(ctx, a, OAUTH_GRANT_PREFIX)),
});

/** OAuth token revocation (RFC 7009) also ends the underlying grant so it disappears from Settings. */
export const revokeOwnToken = mutation({
  args: token, returns: v.null(),
  handler: (ctx, a) => guard(async () => {
    const tokenHash = await hashToken(a.token);
    const grant = await ctx.db.query("connectorGrants").withIndex("by_tokenHash", q => q.eq("tokenHash", tokenHash)).unique();
    if (grant && !grant.revoked && !grant.hostId && !grant.runId) await ctx.db.patch(grant._id, { revoked: true });
    return null;
  }),
});
