import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { canEdit, requireMember, touchProject } from "./lib/permissions";
import { credentialKindValidator } from "./lib/validators";
import { serviceOf } from "./lib/vaultService";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

async function requireEditor(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">, sessionToken: string) {
  const { member } = await requireMember(ctx, projectId, sessionToken);
  if (!canEdit(member)) throw new ConvexError("You have view-only access");
}


export const list = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const rows = await ctx.db
      .query("credentials")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    kind: v.optional(credentialKindValidator),
    service: v.optional(v.string()),
    title: v.string(),
    username: v.optional(v.string()),
    url: v.optional(v.string()),
    notes: v.optional(v.string()),
    ciphertext: v.string(),
    iv: v.string(),
    salt: v.string(),
    iterations: v.number(),
    kdf: v.string(),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const now = Date.now();
    const kind = args.kind ?? "password";
    const id = await ctx.db.insert("credentials", {
      projectId: args.projectId,
      kind,
      service: serviceOf(kind, args.service),
      title: args.title.trim(),
      username: args.username?.trim() || undefined,
      url: args.url?.trim() || undefined,
      notes: args.notes?.trim() || undefined,
      ciphertext: args.ciphertext,
      iv: args.iv,
      salt: args.salt,
      iterations: args.iterations,
      kdf: args.kdf,
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
    credentialId: v.id("credentials"),
    kind: v.optional(credentialKindValidator),
    service: v.optional(v.string()),
    title: v.optional(v.string()),
    username: v.optional(v.string()),
    url: v.optional(v.string()),
    notes: v.optional(v.string()),
    ciphertext: v.optional(v.string()),
    iv: v.optional(v.string()),
    salt: v.optional(v.string()),
    iterations: v.optional(v.number()),
    kdf: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const item = await ctx.db.get(args.credentialId);
    if (!item || item.projectId !== args.projectId) throw new ConvexError("Credential not found");
    const patch: Partial<{
      kind: Doc<"credentials">["kind"];
      service: string | undefined;
      title: string;
      username: string | undefined;
      url: string | undefined;
      notes: string | undefined;
      ciphertext: string;
      iv: string;
      salt: string;
      iterations: number;
      kdf: string;
      updatedAt: number;
    }> = { updatedAt: Date.now() };
    if (args.kind !== undefined || args.service !== undefined) {
      patch.kind = args.kind ?? item.kind;
      patch.service = serviceOf(patch.kind ?? "password", args.service ?? item.service);
    }
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.username !== undefined) patch.username = args.username.trim() || undefined;
    if (args.url !== undefined) patch.url = args.url.trim() || undefined;
    if (args.notes !== undefined) patch.notes = args.notes.trim() || undefined;
    if (args.ciphertext !== undefined) patch.ciphertext = args.ciphertext;
    if (args.iv !== undefined) patch.iv = args.iv;
    if (args.salt !== undefined) patch.salt = args.salt;
    if (args.iterations !== undefined) patch.iterations = args.iterations;
    if (args.kdf !== undefined) patch.kdf = args.kdf;
    await ctx.db.patch(args.credentialId, patch);
    await touchProject(ctx, args.projectId);
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), credentialId: v.id("credentials") },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const item = await ctx.db.get(args.credentialId);
    if (!item || item.projectId !== args.projectId) throw new ConvexError("Credential not found");
    await ctx.db.delete(args.credentialId);
    await touchProject(ctx, args.projectId);
  },
});

/** Whether the project's agents may use this item while a member has the vault unlocked on their computer. */
export const setAgentUse = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), credentialId: v.id("credentials"), agentUse: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const item = await ctx.db.get(args.credentialId);
    if (!item || item.projectId !== args.projectId) throw new ConvexError("Credential not found");
    await ctx.db.patch(args.credentialId, { agentUse: args.agentUse || undefined, updatedAt: Date.now() });
    return null;
  },
});
