import { ConvexError, v } from "convex/values";
import { httpAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { hashToken } from "./lib/auth";
import { addStorageScope, uploadLimit, validateUpload, writableUploadScope } from "./lib/storage";
import { recordChatFile } from "./lib/chatAccess";
import { BodyTooLarge, readBoundedBytes } from "../lib/http-body";

async function uploadUser(ctx: MutationCtx, intent: Doc<"storageUploadIntents">) {
  const session = await ctx.db.get(intent.sessionId);
  const user = await ctx.db.get(intent.userId);
  if (!session || session.userId !== intent.userId || session.expiresAt < Date.now() || !user || user.status !== "active" || (session.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) throw new ConvexError("No upload access");
  return user;
}

export const beginUpload = internalMutation({
  args: { token: v.string() },
  returns: v.object({ intentId: v.id("storageUploadIntents"), maxBytes: v.number() }),
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/.test(args.token)) throw new ConvexError("No upload access");
    const tokenHash = await hashToken(args.token);
    const found = await ctx.db.query("storageUploadIntents").withIndex("by_tokenHash", q => q.eq("tokenHash", tokenHash)).unique();
    if (!found || found.state !== "issued" || found.expiresAt < Date.now()) throw new ConvexError("No upload access");
    await writableUploadScope(ctx, await uploadUser(ctx, found), found.target);
    await ctx.db.patch(found._id, { state: "uploading" });
    return { intentId: found._id, maxBytes: uploadLimit(found.target) };
  },
});

const uploadHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export const uploadOptions = httpAction(async () => new Response(null, {
  status: 204,
  headers: { ...uploadHeaders, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" },
}));

export const upload = httpAction(async (ctx, request) => {
  let storageId;
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const intent = await ctx.runMutation(internal.storage.beginUpload, { token });
    const contentLength = request.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > intent.maxBytes)) throw new BodyTooLarge();
    const bytes = await readBoundedBytes(request, intent.maxBytes);
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
    storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: contentType }));
    await ctx.runMutation(internal.storage.completeUpload, { intentId: intent.intentId, storageId, contentType });
    return Response.json({ storageId }, { headers: uploadHeaders });
  } catch (error) {
    if (storageId) await ctx.storage.delete(storageId);
    return new Response(error instanceof BodyTooLarge ? "Upload too large" : "Upload rejected. Request a new upload and try again.", { status: error instanceof BodyTooLarge ? 413 : 400, headers: uploadHeaders });
  }
});

export const migrateReferences = internalMutation({
  args: { table: v.union(v.literal("users"), v.literal("projects"), v.literal("workspaceAgents"), v.literal("designAssets")), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.string(), done: v.boolean(), admitted: v.number() }),
  handler: async (ctx, args) => {
    const result = await ctx.db.query(args.table).paginate({ cursor: args.cursor, numItems: 100 });
    let admitted = 0;
    for (const row of result.page) {
      const storageId = "avatarStorageId" in row ? row.avatarStorageId : "iconStorageId" in row ? row.iconStorageId : "storageId" in row ? row.storageId : undefined;
      if (!storageId || !await ctx.db.system.get(storageId)) continue;
      if ("avatarStorageId" in row && row.avatarStorageId) {
        if ("email" in row) await addStorageScope(ctx, row.avatarStorageId, { kind: "user", userId: row._id as Doc<"users">["_id"] });
        else if ("teamId" in row) await addStorageScope(ctx, row.avatarStorageId, row.projectId ? { kind: "project", projectId: row.projectId } : { kind: "workspace", teamId: row.teamId });
        admitted += 1;
      } else if ("iconStorageId" in row && row.iconStorageId) {
        await addStorageScope(ctx, row.iconStorageId, { kind: "project", projectId: row._id as Doc<"projects">["_id"] });
        admitted += 1;
      } else if ("storageId" in row && row.storageId) {
        await addStorageScope(ctx, row.storageId, { kind: "project", projectId: row.projectId });
        admitted += 1;
      }
    }
    return { cursor: result.continueCursor, done: result.isDone, admitted };
  },
});

export const completeUpload = internalMutation({
  args: { intentId: v.id("storageUploadIntents"), storageId: v.id("_storage"), contentType: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.state !== "uploading" || intent.expiresAt < Date.now()) throw new ConvexError("No upload access");
    const scope = await writableUploadScope(ctx, await uploadUser(ctx, intent), intent.target);
    const metadata = await ctx.db.system.get(args.storageId);
    if (!metadata) throw new ConvexError("File not found");
    validateUpload(intent.target, metadata.size, metadata.contentType ?? args.contentType);
    await addStorageScope(ctx, args.storageId, scope, metadata.contentType ?? args.contentType);
    if (intent.target.kind === "chat") await recordChatFile(ctx, intent.target, intent.userId, args.storageId, metadata.size, metadata.contentType ?? args.contentType);
    await ctx.db.patch(intent._id, { state: "complete", storageId: args.storageId });
    return null;
  },
});

export const expireUploads = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const expired = await ctx.db.query("storageUploadIntents").withIndex("by_expiresAt", q => q.lt("expiresAt", Date.now())).take(100);
    for (const intent of expired) await ctx.db.delete(intent._id);
    if (expired.length === 100) await ctx.scheduler.runAfter(0, internal.storage.expireUploads, {});
    return null;
  },
});
