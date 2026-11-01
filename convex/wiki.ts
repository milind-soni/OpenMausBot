import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { canEdit, requireMember, touchProject } from "./lib/permissions";
import { wikiTypeValidator } from "./lib/validators";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import * as Y from "yjs";
import { cleanText } from "./lib/features";

async function requireEditor(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">, sessionToken: string) {
  const { member } = await requireMember(ctx, projectId, sessionToken);
  if (!canEdit(member)) throw new ConvexError("You have view-only access");
}

export const list = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const pages = await ctx.db
      .query("wikiPages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);
    return pages.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    title: v.string(),
    content: v.string(),
    type: wikiTypeValidator,
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    if (args.content.length > 60000 || args.tags.length > 30) throw new ConvexError("Document is too large");
    const project = await ctx.db.get(args.projectId);
    const now = Date.now();
    const id = await ctx.db.insert("wikiPages", {
      projectId: args.projectId,
      teamId: project?.teamId,
      title: cleanText(args.title, 160, "Title"),
      content: args.content,
      type: args.type,
      tags: args.tags.map((tag) => cleanText(tag, 60, "Tag")),
      createdAt: now,
      updatedAt: now,
    });
    await touchProject(ctx, args.projectId);
    return id;
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    pageId: v.id("wikiPages"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    type: v.optional(wikiTypeValidator),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.projectId !== args.projectId) throw new ConvexError("Page not found");
    const patch: Partial<{
      title: string;
      content: string;
      type: "wiki" | "credential_note" | "process" | "decision";
      tags: string[];
      updatedAt: number;
      collaborationState: ArrayBuffer;
    }> = { updatedAt: Date.now() };
    if (args.title !== undefined) patch.title = cleanText(args.title, 160, "Title");
    if (args.content !== undefined) {
      if (args.content.length > 60000) throw new ConvexError("Document is too large");
      patch.content = args.content;
      if (page.collaborationState) {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, new Uint8Array(page.collaborationState));
          const text = doc.getText("content");
          doc.transact(() => { text.delete(0, text.length); text.insert(0, args.content!); });
          const state = new Uint8Array(Y.encodeStateAsUpdate(doc)).buffer;
          patch.collaborationState = state;
          if (state.byteLength > 700000) throw new ConvexError("Document size limit reached");
        } finally { doc.destroy(); }
      }
    }
    if (args.type !== undefined) patch.type = args.type;
    if (args.tags !== undefined) {
      if (args.tags.length > 30) throw new ConvexError("Too many tags");
      patch.tags = args.tags.map(tag => cleanText(tag, 60, "Tag"));
    }
    await ctx.db.patch(args.pageId, patch);
    await touchProject(ctx, args.projectId);
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), pageId: v.id("wikiPages") },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.projectId !== args.projectId) throw new ConvexError("Page not found");
    await ctx.db.delete(args.pageId);
    await touchProject(ctx, args.projectId);
  },
});
