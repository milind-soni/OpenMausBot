import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { canEdit, requireMember, requireTeamMember } from "./lib/permissions";
import {
  MAX_LABEL_DESCRIPTION, MAX_WORKSPACE_LABELS, cleanLabelColor, cleanLabelName, colorForLabel, ensureDefaultLabels, labelKey,
  missingDefaultLabels, projectLabels, workspaceLabelRows,
} from "./lib/labels";

const labelRow = v.object({
  _id: v.union(v.id("issueLabels"), v.null()),
  name: v.string(),
  color: v.string(),
  description: v.optional(v.string()),
  groupId: v.optional(v.id("issueLabelGroups")),
  archived: v.boolean(),
});
const groupRow = v.object({ _id: v.id("issueLabelGroups"), name: v.string() });

async function requireLabelEditor(ctx: QueryCtx | MutationCtx, teamId: Id<"teams">, sessionToken: string) {
  const access = await requireTeamMember(ctx, teamId, sessionToken);
  if (!canEdit(access.member)) throw new ConvexError("You have view-only access");
  return access;
}

async function groupRows(ctx: QueryCtx, teamId: Id<"teams">) {
  return ctx.db.query("issueLabelGroups").withIndex("by_teamId_and_key", q => q.eq("teamId", teamId)).take(100);
}

function cleanDescription(value?: string) {
  const description = value?.trim();
  if (description && description.length > MAX_LABEL_DESCRIPTION) throw new ConvexError(`Keep the description under ${MAX_LABEL_DESCRIPTION} characters`);
  return description || undefined;
}

async function requireGroup(ctx: QueryCtx, teamId: Id<"teams">, groupId?: Id<"issueLabelGroups"> | null) {
  if (!groupId) return undefined;
  const group = await ctx.db.get(groupId);
  if (!group || group.teamId !== teamId || group.archived) throw new ConvexError("Label group not found");
  return group._id;
}

/**
 * The workspace's labels for pickers, filters and settings. Defaults the registry has not stored yet and names already
 * on the project's issues but not in the registry are listed too (with `_id: null`), so nothing typed earlier vanishes.
 */
export const list = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), projectId: v.optional(v.id("projects")) },
  returns: v.object({ labels: v.array(labelRow), groups: v.array(groupRow) }),
  handler: async (ctx, args) => {
    await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const rows = await workspaceLabelRows(ctx, args.teamId);
    const labels: (typeof labelRow.type)[] = rows.map(row => ({ _id: row._id, name: row.name, color: row.color, archived: row.archived, ...(row.description ? { description: row.description } : {}), ...(row.groupId ? { groupId: row.groupId } : {}) }));
    const known = new Set(rows.map(row => row.key));
    for (const label of missingDefaultLabels(rows.map(row => row.name))) { labels.push({ _id: null, name: label.name, color: label.color, archived: false }); known.add(labelKey(label.name)); }
    if (args.projectId) {
      const { project } = await requireMember(ctx, args.projectId, args.sessionToken);
      if (project.teamId !== args.teamId) throw new ConvexError("Project not found");
      for (const name of await projectLabels(ctx, project._id)) if (!known.has(labelKey(name))) { known.add(labelKey(name)); labels.push({ _id: null, name, color: colorForLabel(name), archived: false }); }
    }
    const groups = (await groupRows(ctx, args.teamId)).filter(group => !group.archived).map(group => ({ _id: group._id, name: group.name }));
    return { labels: labels.sort((a, b) => a.name.localeCompare(b.name)), groups: groups.sort((a, b) => a.name.localeCompare(b.name)) };
  },
});

/** How many issues carry each label (by lowercased name), for the labels settings table. */
export const usage = query({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.array(v.object({ key: v.string(), count: v.number(), lastUsedAt: v.number() })),
  handler: async (ctx, args) => {
    await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const usage = new Map<string, { count: number; lastUsedAt: number }>();
    for (const task of await ctx.db.query("tasks").withIndex("by_teamId_and_done", q => q.eq("teamId", args.teamId)).take(5000)) {
      for (const label of task.labels ?? []) {
        const key = labelKey(label), current = usage.get(key);
        usage.set(key, { count: (current?.count ?? 0) + 1, lastUsedAt: Math.max(current?.lastUsedAt ?? 0, task.updatedAt) });
      }
    }
    return [...usage].map(([key, value]) => ({ key, ...value }));
  },
});

/** Stores Feature, Bug and Improvement for a workspace that lacks them. Idempotent; viewers get a no-op. */
export const ensureDefaults = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { member } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    return canEdit(member) ? ensureDefaultLabels(ctx, args.teamId) : 0;
  },
});

/** One-time backfill: `npx convex run labels:backfillDefaults '{}'` seeds every workspace, a page at a time. */
export const backfillDefaults = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ seeded: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("teams").paginate({ numItems: 50, cursor: args.cursor ?? null });
    let seeded = 0;
    for (const team of page.page) seeded += await ensureDefaultLabels(ctx, team._id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.labels.backfillDefaults, { cursor: page.continueCursor });
    return { seeded, isDone: page.isDone };
  },
});

export const create = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), name: v.string(), color: v.optional(v.string()), description: v.optional(v.string()), groupId: v.optional(v.id("issueLabelGroups")) },
  returns: v.id("issueLabels"),
  handler: async (ctx, args) => {
    await requireLabelEditor(ctx, args.teamId, args.sessionToken);
    const name = cleanLabelName(args.name), key = labelKey(name);
    const color = args.color ? cleanLabelColor(args.color) : colorForLabel(name);
    const description = cleanDescription(args.description);
    const groupId = await requireGroup(ctx, args.teamId, args.groupId);
    const now = Date.now();
    const existing = await ctx.db.query("issueLabels").withIndex("by_teamId_and_key", q => q.eq("teamId", args.teamId).eq("key", key)).unique();
    if (existing && !existing.archived) throw new ConvexError(`A label named ${existing.name} already exists`);
    if (existing) { await ctx.db.patch(existing._id, { name, color, description, groupId, archived: false, updatedAt: now }); return existing._id; }
    if ((await workspaceLabelRows(ctx, args.teamId)).length >= MAX_WORKSPACE_LABELS) throw new ConvexError(`A workspace can have up to ${MAX_WORKSPACE_LABELS} labels`);
    return ctx.db.insert("issueLabels", { teamId: args.teamId, name, key, color, description, groupId, archived: false, createdAt: now, updatedAt: now });
  },
});

/** Renames carry over to every issue that has the label, so `tasks.labels` keeps matching the registry. */
async function renameOnIssues(ctx: MutationCtx, teamId: Id<"teams">, from: string, to: string) {
  const key = labelKey(from);
  for (const task of await ctx.db.query("tasks").withIndex("by_teamId_and_done", q => q.eq("teamId", teamId)).take(4000)) {
    if (!task.labels?.some(label => labelKey(label) === key)) continue;
    const labels = task.labels.map(label => labelKey(label) === key ? to : label);
    await ctx.db.patch(task._id, { labels: labels.filter((label, index) => labels.findIndex(other => labelKey(other) === labelKey(label)) === index) });
  }
}

export const update = mutation({
  args: {
    sessionToken: v.string(), teamId: v.id("teams"),
    /** A stored label, or a listed one that is not stored yet (a default or a name only found on issues). */
    labelId: v.union(v.id("issueLabels"), v.null()), currentName: v.string(),
    name: v.optional(v.string()), color: v.optional(v.string()), description: v.optional(v.string()),
    groupId: v.optional(v.union(v.id("issueLabelGroups"), v.null())), archived: v.optional(v.boolean()),
  },
  returns: v.id("issueLabels"),
  handler: async (ctx, args) => {
    await requireLabelEditor(ctx, args.teamId, args.sessionToken);
    let label: Doc<"issueLabels"> | null = args.labelId ? await ctx.db.get(args.labelId) : await ctx.db.query("issueLabels").withIndex("by_teamId_and_key", q => q.eq("teamId", args.teamId).eq("key", labelKey(args.currentName))).unique();
    if (args.labelId && (!label || label.teamId !== args.teamId)) throw new ConvexError("Label not found");
    const now = Date.now();
    if (!label) {
      const name = cleanLabelName(args.currentName);
      const id = await ctx.db.insert("issueLabels", { teamId: args.teamId, name, key: labelKey(name), color: colorForLabel(name), archived: false, createdAt: now, updatedAt: now });
      label = (await ctx.db.get(id))!;
    }
    const patch: Partial<Doc<"issueLabels">> = { updatedAt: now };
    if (args.name !== undefined) {
      const name = cleanLabelName(args.name), key = labelKey(name);
      if (key !== label.key) {
        const clash = await ctx.db.query("issueLabels").withIndex("by_teamId_and_key", q => q.eq("teamId", args.teamId).eq("key", key)).unique();
        if (clash) throw new ConvexError(`A label named ${clash.name} already exists`);
      }
      if (name !== label.name) { Object.assign(patch, { name, key }); await renameOnIssues(ctx, args.teamId, label.name, name); }
    }
    if (args.color !== undefined) patch.color = cleanLabelColor(args.color);
    if (args.description !== undefined) patch.description = cleanDescription(args.description);
    if (args.groupId !== undefined) patch.groupId = await requireGroup(ctx, args.teamId, args.groupId);
    if (args.archived !== undefined) patch.archived = args.archived;
    await ctx.db.patch(label._id, patch);
    return label._id;
  },
});

export const createGroup = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), name: v.string() },
  returns: v.id("issueLabelGroups"),
  handler: async (ctx, args) => {
    await requireLabelEditor(ctx, args.teamId, args.sessionToken);
    const name = cleanLabelName(args.name), key = labelKey(name), now = Date.now();
    const existing = await ctx.db.query("issueLabelGroups").withIndex("by_teamId_and_key", q => q.eq("teamId", args.teamId).eq("key", key)).unique();
    if (existing && !existing.archived) throw new ConvexError(`A group named ${existing.name} already exists`);
    if (existing) { await ctx.db.patch(existing._id, { name, archived: false, updatedAt: now }); return existing._id; }
    if ((await groupRows(ctx, args.teamId)).length >= 100) throw new ConvexError("A workspace can have up to 100 label groups");
    return ctx.db.insert("issueLabelGroups", { teamId: args.teamId, name, key, archived: false, createdAt: now, updatedAt: now });
  },
});

export const updateGroup = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), groupId: v.id("issueLabelGroups"), name: v.optional(v.string()), archived: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireLabelEditor(ctx, args.teamId, args.sessionToken);
    const group = await ctx.db.get(args.groupId);
    if (!group || group.teamId !== args.teamId) throw new ConvexError("Label group not found");
    const patch: Partial<Doc<"issueLabelGroups">> = { updatedAt: Date.now() };
    if (args.name !== undefined) {
      const name = cleanLabelName(args.name), key = labelKey(name);
      const clash = key !== group.key && await ctx.db.query("issueLabelGroups").withIndex("by_teamId_and_key", q => q.eq("teamId", args.teamId).eq("key", key)).unique();
      if (clash) throw new ConvexError(`A group named ${clash.name} already exists`);
      Object.assign(patch, { name, key });
    }
    if (args.archived !== undefined) patch.archived = args.archived;
    await ctx.db.patch(group._id, patch);
    // Labels of an archived group stay, ungrouped.
    if (args.archived) for (const label of await workspaceLabelRows(ctx, args.teamId)) if (label.groupId === group._id) await ctx.db.patch(label._id, { groupId: undefined });
    return null;
  },
});
