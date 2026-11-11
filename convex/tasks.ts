import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { canEdit, changeOpenIssueCount, getActiveTeamMember, projectMember, projectPeople, requireMember, requireTeamMember, touchProject } from "./lib/permissions";
import { priorityValidator, taskAssetTypeValidator } from "./lib/validators";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { recordCompletion } from "./lib/completions";
import { notify } from "./notifications";
import { containsMention, mentionToken } from "../lib/issue-mentions";
import { updateChecklist } from "../lib/comment-checklist";
import { compareStoredColumns, compareWorkflowColumns, DEFAULT_WORKFLOW_COLUMNS, ensureDraftColumn, isDoneColumn, isDraftColumn, normalizeColumnTitle } from "./lib/columns";
import { DRAFT_COLUMN_TITLE, isLegacyIdeaColumn } from "../lib/origin-columns";
import { compareTaskOrder, planTaskMove } from "../lib/task-order";
import schema from "./schema";

const columnDoc = v.object({ ...schema.tables.columns.validator.fields, _id: v.id("columns"), _creationTime: v.number() });
const taskDoc = v.object({ ...schema.tables.tasks.validator.fields, _id: v.id("tasks"), _creationTime: v.number() });
const commentDoc = v.object({ ...schema.tables.taskComments.validator.fields, _id: v.id("taskComments"), _creationTime: v.number() });
const assetDoc = v.object({ ...schema.tables.taskAssets.validator.fields, _id: v.id("taskAssets"), _creationTime: v.number() });
const boardPullRequest = v.object({ taskId: v.id("tasks"), number: v.number(), url: v.string(), state: v.union(v.literal("draft"), v.literal("open"), v.literal("closed"), v.literal("merged")) });
const PR_RANK = { open: 0, draft: 1, merged: 2, closed: 3 } as const;
/** One pull request per issue for the board: an open one first, then the newest merged, then closed. */
function boardPullRequests(rows: Doc<"taskPullRequests">[]) {
  const best = new Map<Id<"tasks">, Doc<"taskPullRequests">>();
  for (const row of rows) {
    const current = best.get(row.taskId);
    if (!current || PR_RANK[row.state] < PR_RANK[current.state] || (PR_RANK[row.state] === PR_RANK[current.state] && row.updatedAt > current.updatedAt)) best.set(row.taskId, row);
  }
  return [...best.values()].map(row => ({ taskId: row.taskId, number: row.number, url: row.url, state: row.state }));
}
const person = {
  email: v.string(), name: v.string(), username: v.optional(v.string()), avatarUrl: v.union(v.string(), v.null()),
};

async function requireEditor(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">, sessionToken: string) {
  const result = await requireMember(ctx, projectId, sessionToken);
  if (!canEdit(result.member)) throw new ConvexError("You have view-only access");
  return result;
}

async function findAssignee(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">, email?: string) {
  if (!email) return null;
  const project = await ctx.db.get(projectId);
  const user = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", email)).unique();
  if (!project || user?.status !== "active" || !await projectMember(ctx, project, user)) return null;
  if (project?.teamId) {
    const teamMember = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", project.teamId!).eq("email", email)).unique();
    return teamMember?.status === "active" ? teamMember : null;
  }
  const member = await ctx.db
    .query("members")
    .withIndex("by_project_email", (q) => q.eq("projectId", projectId).eq("email", email))
    .unique();
  return member?.status === "active" ? member : null;
}

/** A due date is optional; an empty value means none. Anything else must be a real "YYYY-MM-DD" date. */
function optionalDueDate(value?: string) {
  return value?.trim() ? requireDueDate(value.trim()) : undefined;
}

function requireDueDate(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ConvexError("Choose a valid due date");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ConvexError("Choose a valid due date");
  return value;
}

export const board = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  returns: v.object({ columns: v.array(columnDoc), tasks: v.array(taskDoc), assignees: v.array(v.object(person)), pullRequests: v.array(boardPullRequest) }),
  handler: async (ctx, args) => {
    const { project } = await requireMember(ctx, args.projectId, args.sessionToken);
    const [columns, tasks, prs] = await Promise.all([
      ctx.db.query("columns").withIndex("by_project_order", (q) => q.eq("projectId", args.projectId)).collect(),
      ctx.db.query("tasks").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect(),
      ctx.db.query("taskPullRequests").withIndex("by_projectId_and_number", q => q.eq("projectId", args.projectId)).order("desc").take(1000),
    ]);
    const assignees = await Promise.all([...new Set(tasks.flatMap(task => task.assignedToEmail ? [task.assignedToEmail] : []))].map(async email => {
      const user = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", email)).unique();
      const active = user?.status === "active" && (!project.teamId || await getActiveTeamMember(ctx, project.teamId, email));
      return { email, name: active ? user.name : tasks.find(task => task.assignedToEmail === email)?.assignedToName || email,
        username: active ? user.username : undefined, avatarUrl: active && user.avatarStorageId ? await ctx.storage.getUrl(user.avatarStorageId) : null };
    }));
    return {
      columns: columns.sort(compareWorkflowColumns),
      tasks: tasks.sort(compareTaskOrder),
      assignees,
      pullRequests: boardPullRequests(prs),
    };
  },
});

export const inbox = query({
  args: { sessionToken: v.string(), teamId: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    if (args.teamId) {
      await requireTeamMember(ctx, args.teamId, args.sessionToken);
      const projects = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", args.teamId)).take(500);
      const rows = await Promise.all(projects.map(async project => {
        if (project.status !== "active" || !await projectMember(ctx, project, user)) return [];
        const tasks = await ctx.db.query("tasks").withIndex("by_assignee", q => q.eq("projectId", project._id).eq("assignedToEmail", user.email)).take(100);
        return tasks.filter(t => !t.done).map(task => ({ ...task, projectName: project.name, projectAccent: project.accent }));
      }));
      return rows.flat().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
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
          if (!project || project.status !== "active" || !await projectMember(ctx, project, user)) return [];
          if (project.teamId) {
            const workspaceMember = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", project.teamId!).eq("email", user.email)).unique();
            if (workspaceMember?.status !== "active") return [];
          }
          const tasks = await ctx.db
            .query("tasks")
            .withIndex("by_assignee", (q) =>
              q.eq("projectId", membership.projectId).eq("assignedToEmail", user.email),
            )
            .take(50);
          return tasks
            .filter((task) => !task.done)
            .map((task) => ({
              ...task,
              projectName: project.name,
              projectAccent: project.accent,
            }));
        }),
    );

    return rows.flat().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
  },
});

export const assignedToMe = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, args.sessionToken);
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_assignee", (q) => q.eq("projectId", args.projectId).eq("assignedToEmail", user.email))
      .collect();
    return tasks.sort(compareTaskOrder);
  },
});

export const details = query({
  args: { projectId: v.id("projects"), sessionToken: v.string(), taskId: v.id("tasks") },
  returns: v.object({
    task: taskDoc, columns: v.array(columnDoc), comments: v.array(commentDoc), assets: v.array(assetDoc),
    members: v.array(v.object({ ...person, _id: v.union(v.id("members"), v.id("teamMembers")), userId: v.id("users"), role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer")), status: v.literal("active") })),
  }),
  handler: async (ctx, args) => {
    const { project } = await requireMember(ctx, args.projectId, args.sessionToken);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new ConvexError("Issue not found");
    const [comments, assets, members, columns] = await Promise.all([
      ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).collect(),
      ctx.db.query("taskAssets").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).collect(),
      projectPeople(ctx, project),
      ctx.db.query("columns").withIndex("by_project_order", (q) => q.eq("projectId", args.projectId)).collect(),
    ]);
    return {
      task,
      columns: columns.sort(compareWorkflowColumns),
      comments: comments.sort((a, b) => a.createdAt - b.createdAt),
      assets: assets.sort((a, b) => a.createdAt - b.createdAt),
      members: members.filter((member) => member.status === "active"),
    };
  },
});

export const createColumn = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), title: v.string(), isDone: v.optional(v.boolean()) },
  returns: v.id("columns"),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    if (!args.title.trim() || args.title.length > 60) throw new ConvexError("Enter a column name under 60 characters");
    if (normalizeColumnTitle(args.title) !== "draft") await ensureDraftColumn(ctx, args.projectId);
    const now = Date.now();
    const columns = await ctx.db.query("columns").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).take(20);
    const order = columns.length ? Math.max(...columns.map((column) => column.order)) + 1 : 0;
    if (columns.length >= 20) throw new ConvexError("A workflow can have up to 20 columns");
    const id = await ctx.db.insert("columns", { projectId: args.projectId, title: args.title.trim(), isDone: false, ...(normalizeColumnTitle(args.title) === "draft" ? { isDraft: true } : {}), order, createdAt: now, updatedAt: now });
    await ensureDraftColumn(ctx, args.projectId);
    await touchProject(ctx, args.projectId);
    return id;
  },
});

export const ensureDefaultColumns = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const now = Date.now();
    const first = await ctx.db
      .query("columns")
      .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
      .first();
    if (!first) for (const [index, title] of DEFAULT_WORKFLOW_COLUMNS.entries()) {
      await ctx.db.insert("columns", {
        projectId: args.projectId,
        title,
        order: index,
        ...(title === DRAFT_COLUMN_TITLE ? { isDraft: true } : {}),
        isDone: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    const result = await ensureDraftColumn(ctx, args.projectId);
    if (!first || result.changed) await touchProject(ctx, args.projectId);
    return null;
  },
});

export const updateColumn = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), columnId: v.id("columns"), title: v.string(), isDone: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const column = await ctx.db.get(args.columnId);
    if (!column || column.projectId !== args.projectId) throw new ConvexError("Column not found");
    if (!args.title.trim() || args.title.length > 60) throw new ConvexError("Enter a column name under 60 characters");
    await ctx.db.patch(args.columnId, { title: args.title.trim(), isDone: false, ...(isDraftColumn(column) || normalizeColumnTitle(args.title) === "draft" ? { isDraft: true } : {}), updatedAt: Date.now() });
    await ensureDraftColumn(ctx, args.projectId);
    await touchProject(ctx, args.projectId);
    return null;
  },
});

export const deleteColumn = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), columnId: v.id("columns"), moveToColumnId: v.optional(v.id("columns")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const column = await ctx.db.get(args.columnId);
    if (!column || column.projectId !== args.projectId) throw new ConvexError("Column not found");
    const columns = await ctx.db.query("columns").withIndex("by_project", q => q.eq("projectId", args.projectId)).take(21);
    if (columns.length < 2) throw new ConvexError("Keep at least one workflow column");
    const tasks = await ctx.db.query("tasks").withIndex("by_column", (q) => q.eq("columnId", args.columnId)).collect();
    if (tasks.length) {
      const target = args.moveToColumnId ? await ctx.db.get(args.moveToColumnId) : null;
      if (!target || target._id === column._id || target.projectId !== args.projectId) throw new ConvexError("Choose a destination for the issues in this column");
      if (isDoneColumn(target) && tasks.some(task => !task.done)) throw new ConvexError("Complete the open issues before moving them to Done");
      for (const [index, task] of tasks.entries()) await ctx.db.patch(task._id, { columnId: target._id, order: Date.now() + index, updatedAt: Date.now(),
        ...(!task.done && task.githubIssueNumber && isDraftColumn(column) && !isDraftColumn(target) ? { githubIssueReopenRequested: true } : {}) });
    }
    await ctx.db.delete(args.columnId);
    await ensureDraftColumn(ctx, args.projectId);
    await touchProject(ctx, args.projectId);
    return null;
  },
});

export const createTask = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    columnId: v.optional(v.id("columns")),
    title: v.string(),
    description: v.optional(v.string()),
    priority: priorityValidator,
    assignedToEmail: v.optional(v.string()),
    dueDate: v.optional(v.string()),
  },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const { user } = await requireEditor(ctx, args.projectId, args.sessionToken);
    return createTaskRecord(ctx, args, user._id);
  },
});

export async function createTaskRecord(ctx: MutationCtx, args: { projectId: Id<"projects">; columnId?: Id<"columns">; title: string; description?: string; priority: "low" | "medium" | "high"; assignedToEmail?: string; dueDate?: string; }, actorId: Id<"users">) {
  const [column, assignee] = await Promise.all([
      args.columnId ? ctx.db.get(args.columnId) : ensureDraftColumn(ctx, args.projectId).then(result => result.column),
      findAssignee(ctx, args.projectId, args.assignedToEmail),
    ]);
    if (!column || column.projectId !== args.projectId) throw new ConvexError("Column not found");
    if (!args.title.trim() || args.title.length > 250) throw new ConvexError("Enter an issue title under 250 characters");
    // Assignee and due date are optional; a value that is given must still be valid.
    if (!assignee && args.assignedToEmail?.trim()) throw new ConvexError("Choose an active workspace member as assignee");
    const dueDate = optionalDueDate(args.dueDate);
    const now = Date.now();
    if ((args.description?.length || 0) > 60000) throw new ConvexError("Description must be under 60,000 characters");
    if (args.columnId) await ensureDraftColumn(ctx, args.projectId);
    const last = await ctx.db.query("tasks").withIndex("by_column_order", q => q.eq("columnId", column._id)).order("desc").first();
    const order = last ? last.order + 1 : 0;
    const project = await ctx.db.get(args.projectId);
    const done = isDoneColumn(column);
    const taskId = await ctx.db.insert("tasks", {
      teamId: project?.teamId,
      projectId: args.projectId,
      columnId: column._id,
      title: args.title.trim(),
      description: args.description?.trim() || undefined,
      priority: args.priority,
      assignedToEmail: assignee?.email,
      assignedToName: assignee?.name,
      done,
      dueDate,
      order,
      createdAt: now,
      updatedAt: now,
    });
    await changeOpenIssueCount(ctx, args.projectId, done ? 0 : 1);
    await touchProject(ctx, args.projectId);
    if (project?.teamId && assignee) await notify(ctx, { teamId: project.teamId, email: assignee.email, actorId, kind: "assignment", eventId: `created:${taskId}`, projectId: project._id, taskId });
    return taskId;
}

const draftRepairPage = { cursor: v.union(v.string(), v.null()) };
const draftRepairReceipt = v.object({
  phase: v.union(v.literal("columns"), v.literal("legacyIdeas"), v.literal("projects")),
  scanned: v.number(), changed: v.number(), created: v.number(), candidateUpdated: v.number(), adopted: v.number(), cursor: v.string(), isDone: v.boolean(),
});

export const flagDraftColumns = internalMutation({
  args: draftRepairPage,
  returns: draftRepairReceipt,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("columns").paginate({ cursor: args.cursor, numItems: 100 });
    let changed = 0;
    for (const column of page.page) if (isDraftColumn(column) && (column.isDraft !== true || column.isDone !== false)) {
      await ctx.db.patch(column._id, { isDraft: true, isDone: false, updatedAt: Date.now() });
      changed++;
    }
    return { phase: "columns" as const, scanned: page.page.length, changed, created: 0, candidateUpdated: 0, adopted: 0, cursor: page.continueCursor, isDone: page.isDone };
  },
});

export const selectLegacyDraftCandidates = internalMutation({
  args: draftRepairPage,
  returns: draftRepairReceipt,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("columns").paginate({ cursor: args.cursor, numItems: 100 });
    let changed = 0;
    for (const column of page.page) {
      if (!isLegacyIdeaColumn(column)) continue;
      const project = await ctx.db.get(column.projectId);
      if (!project) continue;
      const draft = await ctx.db.query("columns").withIndex("by_projectId_and_isDraft_and_order", q => q.eq("projectId", column.projectId).eq("isDraft", true)).first();
      if (draft) continue;
      const previous = project.draftIdeaCandidateId ? await ctx.db.get(project.draftIdeaCandidateId) : null;
      if (previous?.projectId === project._id && isLegacyIdeaColumn(previous) && compareStoredColumns(previous, column) <= 0) continue;
      await ctx.db.patch(project._id, { draftIdeaCandidateId: column._id });
      changed++;
    }
    return { phase: "legacyIdeas" as const, scanned: page.page.length, changed, created: 0, candidateUpdated: changed, adopted: 0, cursor: page.continueCursor, isDone: page.isDone };
  },
});

export const repairProjectDrafts = internalMutation({
  args: draftRepairPage,
  returns: draftRepairReceipt,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("projects").paginate({ cursor: args.cursor, numItems: 25 });
    let changed = 0;
    let created = 0;
    let adopted = 0;
    for (const project of page.page) {
      const result = await ensureDraftColumn(ctx, project._id, { completeLegacyScan: true });
      if (result.created) created++;
      if (result.adopted) adopted++;
      if (result.changed) {
        changed++;
        await touchProject(ctx, project._id);
      }
    }
    return { phase: "projects" as const, scanned: page.page.length, changed, created, candidateUpdated: 0, adopted, cursor: page.continueCursor, isDone: page.isDone };
  },
});

export const updateTask = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(priorityValidator),
    assignedToEmail: v.optional(v.string()),
    dueDate: v.optional(v.string()),
    done: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireEditor(ctx, args.projectId, args.sessionToken);
    return updateTaskRecord(ctx, args, user._id);
  },
});

export async function updateTaskRecord(ctx: MutationCtx, args: { projectId: Id<"projects">; taskId: Id<"tasks">; title?: string; description?: string; priority?: "low" | "medium" | "high"; assignedToEmail?: string; dueDate?: string; done?: boolean; }, actorId: Id<"users">) {
  const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new ConvexError("Issue not found");
    const patch: Partial<{
      title: string;
      description: string | undefined;
      priority: "low" | "medium" | "high";
      assignedToEmail: string | undefined;
      assignedToName: string | undefined;
      dueDate: string | undefined;
      done: boolean;
      completionPullRequest: Doc<"tasks">["completionPullRequest"];
      githubIssueReopenRequested: boolean | undefined;
      updatedAt: number;
    }> = { updatedAt: Date.now() };
    if (args.title !== undefined) {
      if (!args.title.trim() || args.title.length > 250) throw new ConvexError("Enter an issue title under 250 characters");
      patch.title = args.title.trim();
    }
    if (args.description !== undefined) {
      if (args.description.length > 60000) throw new ConvexError("Description must be under 60,000 characters");
      patch.description = args.description.trim() || undefined;
    }
    if (args.priority !== undefined) patch.priority = args.priority;
    // An empty assignee or due date clears it.
    if (args.assignedToEmail !== undefined) {
      const assignee = args.assignedToEmail.trim() ? await findAssignee(ctx, args.projectId, args.assignedToEmail) : null;
      if (!assignee && args.assignedToEmail.trim()) throw new ConvexError("Choose an active workspace member as assignee");
      patch.assignedToEmail = assignee?.email;
      patch.assignedToName = assignee?.name;
    }
    if (args.dueDate !== undefined) patch.dueDate = optionalDueDate(args.dueDate);
    if (args.done !== undefined) patch.done = args.done;
    if (patch.done === false && task.done) {
      patch.completionPullRequest = undefined;
      if (task.githubIssueNumber) patch.githubIssueReopenRequested = true;
    }
    if (patch.done === true && !task.done) patch.githubIssueReopenRequested = undefined;
    if (patch.done !== undefined) await recordCompletion(ctx, task, patch.done);
    await ctx.db.patch(args.taskId, patch);
    if (patch.assignedToEmail && patch.assignedToEmail !== task.assignedToEmail) {
      const project = await ctx.db.get(args.projectId);
      if (project?.teamId) await notify(ctx, { teamId: project.teamId, email: patch.assignedToEmail, actorId, kind: "assignment", eventId: `assigned:${task._id}:${crypto.randomUUID()}`, projectId: project._id, taskId: task._id });
    }
    if (patch.done !== undefined && patch.done !== task.done) await changeOpenIssueCount(ctx, args.projectId, patch.done ? -1 : 1);
    await touchProject(ctx, args.projectId);
}

export const moveTask = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    taskId: v.id("tasks"),
    columnId: v.id("columns"),
    beforeTaskId: v.optional(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    await moveTaskRecord(ctx, args);
  },
});

export async function moveTaskRecord(ctx: MutationCtx, args: { projectId: Id<"projects">; taskId: Id<"tasks">; columnId: Id<"columns">; beforeTaskId?: Id<"tasks"> }) {
    const [task, column] = await Promise.all([ctx.db.get(args.taskId), ctx.db.get(args.columnId)]);
    if (!task || task.projectId !== args.projectId) throw new ConvexError("Issue not found");
    if (!column || column.projectId !== args.projectId) throw new ConvexError("Column not found");
    if (!task.done && isDoneColumn(column)) throw new ConvexError("Complete this issue before moving it to Done");
    const reopenAsDraft = task.done && isDraftColumn(column);
    const previousColumn = task.githubIssueNumber && !task.done && !isDraftColumn(column) ? await ctx.db.get(task.columnId) : null;
    const reopen = Boolean(previousColumn && isDraftColumn(previousColumn));
    const columnTasks = await ctx.db.query("tasks").withIndex("by_column", (q) => q.eq("columnId", args.columnId)).collect();
    const plan = planTaskMove(columnTasks, args.taskId, args.beforeTaskId);
    if (plan.noop && !reopen && !reopenAsDraft) return;
    for (const item of plan.renumber) await ctx.db.patch(item._id, { order: item.order });
    const order = plan.order;
    await ctx.db.patch(args.taskId, { columnId: args.columnId, order, updatedAt: Date.now(), ...(reopen ? { githubIssueReopenRequested: true } : {}),
      ...(reopenAsDraft ? { done: false, completionPullRequest: undefined } : {}) });
    if (reopenAsDraft) await changeOpenIssueCount(ctx, args.projectId, 1);
    await touchProject(ctx, args.projectId);
}

export const addComment = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), taskId: v.id("tasks"), body: v.string(), mentions: v.optional(v.array(v.object({ userId: v.id("users"), token: v.string() }))),
    references: v.optional(v.array(v.object({ type: v.union(v.literal("project"), v.literal("issue")), id: v.string(), projectId: v.id("projects"), label: v.string() }))),
    attachments: v.optional(v.array(v.object({ id: v.string(), name: v.string(), size: v.number(), contentType: v.string() }))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, project } = await requireEditor(ctx, args.projectId, args.sessionToken);
    await addCommentRecord(ctx, args, user, project);
    return null;
  },
});

export async function addCommentRecord(ctx: MutationCtx, args: { projectId: Id<"projects">; taskId: Id<"tasks">; body: string; mentions?: { userId: Id<"users">; token: string }[]; references?: { type: "project" | "issue"; id: string; projectId: Id<"projects">; label: string }[]; attachments?: { id: string; name: string; size: number; contentType: string }[] }, user: Doc<"users">, project: Doc<"projects">) {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new ConvexError("Issue not found");
    if ((!args.body.trim() && !args.attachments?.length) || args.body.length > 8000) throw new ConvexError("Enter a comment under 8,000 characters or attach a file");
    if ((args.references?.length || 0) > 12 || (args.attachments?.length || 0) > 8) throw new ConvexError("Add up to 12 references and 8 files per comment");
    if ((args.mentions?.length || 0) > 20) throw new ConvexError("Mention up to 20 people per comment");
    const mentions = [];
    for (const candidate of new Map((args.mentions || []).map(item => [item.userId, item])).values()) {
      if (!containsMention(args.body, candidate.token)) continue;
      const person = await ctx.db.get(candidate.userId);
      if (person?.status !== "active" || !await projectMember(ctx, project, person) || mentionToken(person) !== candidate.token) throw new ConvexError("Mention someone with access to this project");
      mentions.push({ userId: person._id, name: person.name, email: person.email, token: candidate.token });
    }
    const references = [];
    for (const reference of new Map((args.references || []).map(item => [item.id, item])).values()) {
      if (!containsMention(args.body, `#${reference.label}`)) continue;
      const target = await ctx.db.get(reference.projectId);
      if (!target || target.teamId !== project.teamId || !await projectMember(ctx, target, user)) throw new ConvexError("Reference a project you can access in this workspace");
      const issueId = reference.type === "issue" ? ctx.db.normalizeId("tasks", reference.id) : null;
      const issue = issueId ? await ctx.db.get(issueId) : null;
      if (reference.type === "issue" ? !issue || issue.projectId !== target._id : reference.id !== target._id) throw new ConvexError("Reference not found");
      if (!reference.label.trim() || reference.label.length > 250) throw new ConvexError("Invalid reference label");
      references.push(reference);
    }
    for (const file of args.attachments || []) {
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(file.id) || !file.name.trim() || file.name.length > 200 || !Number.isInteger(file.size) || file.size <= 0 || file.size > 15 * 1024 * 1024 || file.contentType.length > 150) throw new ConvexError("Invalid attachment");
    }
    const commentId = await ctx.db.insert("taskComments", {
      projectId: args.projectId,
      taskId: args.taskId,
      authorUserId: user._id,
      authorName: user.name,
      authorEmail: user.email,
      body: args.body.trim(),
      mentions,
      references,
      createdAt: Date.now(),
    });
    for (const file of args.attachments || []) await ctx.db.insert("taskAssets", {
      projectId: project._id, taskId: task._id, commentId, authorUserId: user._id,
      type: /^image\/(png|jpeg|gif|webp)$/.test(file.contentType) ? "image" : "file", name: file.name,
      localFileId: file.id, size: file.size, contentType: file.contentType, url: "", createdAt: Date.now(),
    });
    if (project.teamId) {
      const previous = await ctx.db.query("taskComments").withIndex("by_task", q => q.eq("taskId", task._id)).order("desc").take(100);
      const mentioned = new Set(mentions.map(m => m.email));
      const recipients = new Set([task.assignedToEmail, ...previous.map(c => c.authorEmail), ...mentioned].filter((email): email is string => Boolean(email)));
      for (const email of recipients) await notify(ctx, { teamId: project.teamId, email, actorId: user._id, kind: mentioned.has(email) ? "mention" : "comment", eventId: `comment:${commentId}`, projectId: project._id, taskId: task._id, preview: args.body.trim().slice(0, 180) });
    }
    await touchProject(ctx, args.projectId);
    return commentId;
}

export const checkCommentItem = mutation({
  args: { sessionToken: v.string(), projectId: v.id("projects"), commentId: v.id("taskComments"), line: v.number(), text: v.string(), checked: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const comment = await ctx.db.get(args.commentId);
    if (!comment || comment.projectId !== args.projectId) throw new ConvexError("Comment not found");
    await ctx.db.patch(comment._id, { body: updateChecklist(comment.body, args.line, args.text, args.checked) });
    await touchProject(ctx, args.projectId);
    return null;
  },
});

export const addAsset = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    taskId: v.id("tasks"),
    type: taskAssetTypeValidator,
    name: v.string(),
    url: v.optional(v.string()),
    localFileId: v.optional(v.string()),
    contentType: v.optional(v.string()),
    size: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireEditor(ctx, args.projectId, args.sessionToken);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new ConvexError("Issue not found");
    if (!args.name.trim() || args.name.length > 200) throw new ConvexError("Enter an attachment name under 200 characters");
    if (args.localFileId) {
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args.localFileId) || args.size === undefined || !Number.isInteger(args.size) || args.size <= 0 || args.size > 15 * 1024 * 1024) throw new ConvexError("Invalid attachment");
    } else {
      let link: URL;
      try { link = new URL(args.url?.trim() || ""); } catch { throw new ConvexError("Use an http or https link"); }
      if (!["http:", "https:"].includes(link.protocol) || link.username || link.password) throw new ConvexError("Use an http or https link without credentials");
    }
    await ctx.db.insert("taskAssets", {
      projectId: args.projectId,
      taskId: args.taskId,
      type: args.type,
      name: args.name.trim(),
      url: args.localFileId ? "" : args.url!.trim(),
      localFileId: args.localFileId,
      contentType: args.contentType?.slice(0, 150),
      size: args.size,
      notes: args.notes?.trim() || undefined,
      authorUserId: user._id,
      createdAt: Date.now(),
    });
    await touchProject(ctx, args.projectId);
    return null;
  },
});

export const deleteTask = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    await deleteTaskRecord(ctx, args);
  },
});

export const authorizeLocalFile = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), fileId: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const assets = await ctx.db.query("taskAssets").withIndex("by_localFileId", q => q.eq("localFileId", args.fileId)).take(100);
    if (!assets.length) return null;
    for (const asset of assets) {
      const project = await ctx.db.get(asset.projectId);
      if (project?.teamId !== args.teamId || !await projectMember(ctx, project, user)) throw new ConvexError("You don't have access to this project");
    }
    return null;
  },
});

export async function deleteTaskRecord(ctx: MutationCtx, args: { projectId: Id<"projects">; taskId: Id<"tasks"> }) {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new ConvexError("Issue not found");
    const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).collect();
    const assets = await ctx.db.query("taskAssets").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).collect();
    for (const comment of comments) await ctx.db.delete(comment._id);
    for (const asset of assets) await ctx.db.delete(asset._id);
    const outgoing = await ctx.db.query("taskRelations").withIndex("by_fromTaskId", q => q.eq("fromTaskId", args.taskId)).take(31);
    const incoming = await ctx.db.query("taskRelations").withIndex("by_toTaskId", q => q.eq("toTaskId", args.taskId)).take(31);
    for (const relation of [...outgoing, ...incoming]) await ctx.db.delete(relation._id);
    await ctx.db.delete(args.taskId);
    await changeOpenIssueCount(ctx, args.projectId, task.done ? 0 : -1);
    await touchProject(ctx, args.projectId);
}
