import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { agentAccess } from "./agentAccess";
import { getSessionUser, hashToken } from "./auth";
import { canEdit, getActiveTeamMember, projectMember } from "./permissions";
import { isConversationMember } from "./chatAccess";
export type StorageScope = Doc<"storageAdmissions">["scope"];
export type UploadTarget = Doc<"storageUploadIntents">["target"];
type Ctx = QueryCtx | MutationCtx;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DRAWING_TYPES = new Set([...IMAGE_TYPES, "image/svg+xml"]);

export function scopeKey(scope: StorageScope) {
  return scope.kind === "user" ? `user:${scope.userId}` : scope.kind === "project" ? `project:${scope.projectId}` : `workspace:${scope.teamId}`;
}

export async function canReadStorageScope(ctx: Ctx, user: Doc<"users">, scope: StorageScope) {
  if (scope.kind === "user") return scope.userId === user._id;
  if (scope.kind === "project") {
    const project = await ctx.db.get(scope.projectId);
    return Boolean(project && await projectMember(ctx, project, user));
  }
  if (!await ctx.db.get(scope.teamId)) return false;
  const member = await getActiveTeamMember(ctx, scope.teamId, user.email);
  return Boolean(member && (!member.userId || member.userId === user._id));
}

export async function writableUploadScope(ctx: Ctx, user: Doc<"users">, target: UploadTarget): Promise<StorageScope> {
  if (target.kind === "profile") {
    if (target.userId !== user._id) throw new ConvexError("No upload access");
    return { kind: "user", userId: user._id };
  }
  if (target.kind === "agent") {
    const agent = await ctx.db.get(target.agentId);
    if (!agent || agent.archivedAt !== undefined || !(await agentAccess(ctx, agent, user))?.canEdit) throw new ConvexError("No upload access");
    return agent.projectId ? { kind: "project", projectId: agent.projectId } : { kind: "workspace", teamId: agent.teamId };
  }
  if (target.kind === "chat") {
    const member = await getActiveTeamMember(ctx, target.teamId, user.email);
    if (!member || (member.userId && member.userId !== user._id) || !canEdit(member)) throw new ConvexError("No upload access");
    if (target.conversation && !await isConversationMember(ctx, target.teamId, target.conversation, user._id)) throw new ConvexError("No upload access");
    if (!target.projectId) return { kind: "workspace", teamId: target.teamId };
    const project = await ctx.db.get(target.projectId);
    const projectRole = project?.teamId === target.teamId ? await projectMember(ctx, project, user) : null;
    if (!projectRole || !canEdit(projectRole)) throw new ConvexError("No upload access");
    return { kind: "project", projectId: target.projectId };
  }
  if (target.kind === "drawing") {
    if (target.canvasId) {
      const canvas = await ctx.db.get(target.canvasId);
      const project = canvas && canvas.teamId === target.teamId && canvas.kind === undefined && !canvas.archived ? await ctx.db.get(canvas.projectId) : null;
      const member = project ? await projectMember(ctx, project, user) : null;
      if (!canvas || !member || !canEdit(member)) throw new ConvexError("No upload access");
      return { kind: "project", projectId: canvas.projectId };
    }
    const member = await getActiveTeamMember(ctx, target.teamId, user.email);
    if (!member || (member.userId && member.userId !== user._id) || !canEdit(member)) throw new ConvexError("No upload access");
    return { kind: "workspace", teamId: target.teamId };
  }
  const project = await ctx.db.get(target.projectId);
  const member = project ? await projectMember(ctx, project, user) : null;
  if (!member || !canEdit(member) || (target.kind === "icon" && member.role !== "owner" && member.role !== "admin")) throw new ConvexError("No upload access");
  return { kind: "project", projectId: target.projectId };
}

export function uploadLimit(target: UploadTarget) {
  return ["profile", "icon", "agent"].includes(target.kind) ? 5 * 1024 * 1024 : 15 * 1024 * 1024;
}

export function validateUpload(target: UploadTarget, size: number, contentType: string | undefined) {
  if (size > uploadLimit(target)) throw new ConvexError("Upload too large");
  if (target.kind === "profile" && !IMAGE_TYPES.has(contentType ?? "")) throw new ConvexError("Choose a PNG, JPEG, WebP or GIF under 5 MB");
  if ((target.kind === "icon" || target.kind === "agent") && !contentType?.startsWith("image/")) throw new ConvexError("Choose an image under 5 MB");
  if (target.kind === "drawing" && !DRAWING_TYPES.has(contentType ?? "")) throw new ConvexError("Choose an image under 15 MB");
}

export async function storageMetadata(ctx: Ctx, storageId: Id<"_storage">) {
  const metadata = await ctx.db.system.get(storageId);
  if (!metadata || metadata.contentType) return metadata;
  const admission = await ctx.db.query("storageAdmissions").withIndex("by_storageId_and_scopeKey", q => q.eq("storageId", storageId)).first();
  return { ...metadata, contentType: admission?.contentType };
}

export async function addStorageScope(ctx: MutationCtx, storageId: Id<"_storage">, scope: StorageScope, contentType?: string) {
  const key = scopeKey(scope);
  if (await ctx.db.query("storageAdmissions").withIndex("by_storageId_and_scopeKey", q => q.eq("storageId", storageId).eq("scopeKey", key)).unique()) return;
  await ctx.db.insert("storageAdmissions", { storageId, scopeKey: key, scope, contentType, createdAt: Date.now() });
}

async function canReadLegacyReference(ctx: Ctx, storageId: Id<"_storage">, user: Doc<"users">) {
  if (user.avatarStorageId === storageId) return true;
  const [projects, assets, agents] = await Promise.all([
    ctx.db.query("projects").withIndex("by_iconStorageId", q => q.eq("iconStorageId", storageId)).take(100),
    ctx.db.query("designAssets").withIndex("by_storageId", q => q.eq("storageId", storageId)).take(100),
    ctx.db.query("workspaceAgents").withIndex("by_avatarStorageId", q => q.eq("avatarStorageId", storageId)).take(100),
  ]);
  for (const project of projects) if (await projectMember(ctx, project, user)) return true;
  for (const asset of assets) if (await canReadStorageScope(ctx, user, { kind: "project", projectId: asset.projectId })) return true;
  for (const agent of agents) if (await agentAccess(ctx, agent, user)) return true;
  return false;
}

export async function admitStorageReference(ctx: MutationCtx, storageId: Id<"_storage">, user: Doc<"users">, destination: StorageScope) {
  if (!await ctx.db.system.get(storageId)) throw new ConvexError("File not found");
  const existing = await ctx.db.query("storageAdmissions").withIndex("by_storageId_and_scopeKey", q => q.eq("storageId", storageId).eq("scopeKey", scopeKey(destination))).unique();
  if (existing && await canReadStorageScope(ctx, user, destination)) return;
  const scopes = await ctx.db.query("storageAdmissions").withIndex("by_storageId_and_scopeKey", q => q.eq("storageId", storageId)).take(100);
  let allowed = false;
  for (const admission of scopes) if (await canReadStorageScope(ctx, user, admission.scope)) { allowed = true; break; }
  if (!allowed) allowed = await canReadLegacyReference(ctx, storageId, user);
  if (!allowed) throw new ConvexError("No access to this file. Upload it again.");
  await addStorageScope(ctx, storageId, destination, (await storageMetadata(ctx, storageId))?.contentType);
}

export async function issueUpload(ctx: MutationCtx, sessionToken: string, target: UploadTarget) {
  const session = await getSessionUser(ctx, sessionToken);
  if (!session) throw new ConvexError("Your session has expired. Sign in again.");
  await writableUploadScope(ctx, session.user, target);
  if ((await ctx.db.query("storageUploadIntents").withIndex("by_userId_and_expiresAt", q => q.eq("userId", session.user._id).gte("expiresAt", Date.now())).take(100)).length >= 100) throw new ConvexError("Too many uploads. Try again in ten minutes");
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!siteUrl || !/^https?:\/\//.test(siteUrl)) throw new ConvexError("Upload service is unavailable");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  await ctx.db.insert("storageUploadIntents", { tokenHash: await hashToken(token), sessionId: session.session._id, userId: session.user._id, target, state: "issued", expiresAt: Date.now() + 10 * 60 * 1000 });
  return `${siteUrl.replace(/\/+$/, "")}/uploads?token=${token}`;
}
