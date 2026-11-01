import * as Y from "yjs";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { canEdit, requireMember, requireTeamMember, visibleProjectRows } from "./lib/permissions";
import { cleanText, workspaceProject } from "./lib/features";
import { wikiTypeValidator } from "./lib/validators";

const scope = { sessionToken: v.string(), teamId: v.id("teams") };
export const backfill = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) }, returns: v.null(),
  handler: async (ctx, args) => {
    const batch = await ctx.db.query("wikiPages").paginate({ cursor: args.cursor, numItems: 100 });
    for (const page of batch.page) {
      const project = await ctx.db.get(page.projectId);
      if (project?.teamId && page.teamId !== project.teamId) await ctx.db.patch(page._id, { teamId: project.teamId });
    }
    if (!batch.isDone) await ctx.scheduler.runAfter(0, internal.documents.backfill, { cursor: batch.continueCursor });
    return null;
  },
});
function state(doc: Y.Doc) { return new Uint8Array(Y.encodeStateAsUpdate(doc)).buffer; }

export const list = query({
  args: { ...scope, projectId: v.optional(v.id("projects")) },
  returns: v.array(v.object({ _id: v.id("wikiPages"), projectId: v.id("projects"), title: v.string(), type: wikiTypeValidator, updatedAt: v.number(), excerpt: v.string() })),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    if (args.projectId) await workspaceProject(ctx, args.teamId, args.projectId);
    if (args.projectId) await requireMember(ctx, args.projectId, args.sessionToken);
    const rows = args.projectId
      ? await ctx.db.query("wikiPages").withIndex("by_project", q => q.eq("projectId", args.projectId!)).order("desc").take(200)
      : await ctx.db.query("wikiPages").withIndex("by_teamId_and_updatedAt", q => q.eq("teamId", args.teamId)).order("desc").take(200);
    return (await visibleProjectRows(ctx, rows, user)).map(row => ({ _id: row._id, projectId: row.projectId, title: row.title, type: row.type, updatedAt: row.updatedAt, excerpt: row.content.slice(0, 180) }));
  },
});

export const get = query({
  args: { sessionToken: v.string(), pageId: v.id("wikiPages") },
  returns: v.union(v.null(), v.object({ _id: v.id("wikiPages"), projectId: v.id("projects"), title: v.string(), content: v.string(), type: wikiTypeValidator, collaborationState: v.optional(v.bytes()), updatedAt: v.number() })),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) return null;
    await requireMember(ctx, page.projectId, args.sessionToken);
    return { _id: page._id, projectId: page.projectId, title: page.title, content: page.content, type: page.type, collaborationState: page.collaborationState, updatedAt: page.updatedAt };
  },
});

export const create = mutation({
  args: { ...scope, projectId: v.id("projects"), title: v.string(), type: wikiTypeValidator, content: v.optional(v.string()) }, returns: v.id("wikiPages"),
  handler: async (ctx, args) => {
    const { member } = await requireMember(ctx, args.projectId, args.sessionToken);
    if (!canEdit(member)) throw new ConvexError("You have view-only access");
    await workspaceProject(ctx, args.teamId, args.projectId);
    const doc = new Y.Doc();
    try {
      const content = args.content?.slice(0, 60000) || "";
      doc.getText("content").insert(0, content);
      return await ctx.db.insert("wikiPages", { teamId: args.teamId, projectId: args.projectId, title: cleanText(args.title, 160, "Title"), content, collaborationState: state(doc), type: args.type, tags: [], createdAt: Date.now(), updatedAt: Date.now() });
    } finally { doc.destroy(); }
  },
});

export const open = mutation({
  args: { sessionToken: v.string(), pageId: v.id("wikiPages") }, returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) throw new ConvexError("Document not found");
    const { member, project } = await requireMember(ctx, page.projectId, args.sessionToken);
    if (!canEdit(member)) return null;
    if (!page.collaborationState) {
      const doc = new Y.Doc();
      try { doc.getText("content").insert(0, page.content); await ctx.db.patch(page._id, { collaborationState: state(doc), teamId: project.teamId }); }
      finally { doc.destroy(); }
    }
    return null;
  },
});

export const applyUpdate = mutation({
  args: { sessionToken: v.string(), pageId: v.id("wikiPages"), update: v.bytes() }, returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) throw new ConvexError("Document not found");
    const { member, project } = await requireMember(ctx, page.projectId, args.sessionToken);
    if (!canEdit(member)) throw new ConvexError("You have view-only access");
    if (!page.collaborationState || args.update.byteLength > 150000) throw new ConvexError("Reload this document before editing");
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, new Uint8Array(page.collaborationState));
      Y.applyUpdate(doc, new Uint8Array(args.update));
      const content = doc.getText("content").toString();
      const collaborationState = state(doc);
      if (content.length > 60000 || collaborationState.byteLength > 700000) throw new ConvexError("Document size limit reached. Split it into smaller documents.");
      await ctx.db.patch(page._id, { content, collaborationState, teamId: project.teamId, updatedAt: Date.now() });
      return null;
    } finally { doc.destroy(); }
  },
});

export const rename = mutation({
  args: { sessionToken: v.string(), pageId: v.id("wikiPages"), title: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) throw new ConvexError("Document not found");
    if (!canEdit((await requireMember(ctx, page.projectId, args.sessionToken)).member)) throw new ConvexError("You have view-only access");
    await ctx.db.patch(page._id, { title: cleanText(args.title, 160, "Title"), updatedAt: Date.now() });
    return null;
  },
});
