import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canEdit, requireMember, requireTeamMember } from "./lib/permissions";
import { admitStorageReference, issueUpload, type StorageScope } from "./lib/storage";

// Excalidraw drawings: one scene per workspace (no canvasId) plus named canvases per project.
// Canvases with a `kind` belong to the retired desktop Studio and are not Excalidraw scenes.
const MAX_CANVASES = 50;
const MAX_ELEMENTS = 5000;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_FILES = 500;
const ELEMENT_TYPES = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "image", "frame", "magicframe", "embeddable", "iframe"]);
const DRAWING_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

const scope = { sessionToken: v.string(), teamId: v.id("teams"), canvasId: v.optional(v.id("canvases")) };
type SceneArgs = { sessionToken: string; teamId: Id<"teams">; canvasId?: Id<"canvases"> };

const isDrawing = (canvas: Doc<"canvases">) => canvas.kind === undefined && !canvas.archived;

async function sceneAccess(ctx: QueryCtx | MutationCtx, args: SceneArgs) {
  if (args.canvasId) {
    const canvas = await ctx.db.get(args.canvasId);
    if (!canvas || canvas.teamId !== args.teamId || !isDrawing(canvas)) throw new ConvexError("Canvas not found");
    const access = await requireMember(ctx, canvas.projectId, args.sessionToken);
    if (access.project.teamId !== args.teamId) throw new ConvexError("Canvas not found");
    return { ...access, container: canvas as Doc<"canvases"> | Doc<"teams">, storageScope: { kind: "project", projectId: canvas.projectId } as StorageScope };
  }
  const access = await requireTeamMember(ctx, args.teamId, args.sessionToken);
  const team = await ctx.db.get(args.teamId);
  if (!team) throw new ConvexError("Workspace not found");
  return { ...access, container: team as Doc<"canvases"> | Doc<"teams">, storageScope: { kind: "workspace", teamId: args.teamId } as StorageScope };
}

async function editableScene(ctx: MutationCtx, args: SceneArgs) {
  const access = await sceneAccess(ctx, args);
  if (!canEdit(access.member)) throw new ConvexError("You have view-only access");
  return access;
}

const sceneElements = (ctx: QueryCtx, args: SceneArgs) => ctx.db.query("drawingElements").withIndex("by_scene", q => q.eq("teamId", args.teamId).eq("canvasId", args.canvasId));
const sceneFiles = (ctx: QueryCtx, args: SceneArgs) => ctx.db.query("drawingFiles").withIndex("by_scene", q => q.eq("teamId", args.teamId).eq("canvasId", args.canvasId));
const scenePresence = (ctx: QueryCtx, args: SceneArgs) => ctx.db.query("drawingPresence").withIndex("by_scene", q => q.eq("teamId", args.teamId).eq("canvasId", args.canvasId));

function canvasName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new ConvexError("Enter a canvas name under 80 characters");
  return trimmed;
}

export const canvases = query({
  args: { sessionToken: v.string(), projectId: v.id("projects") },
  returns: v.array(v.object({ _id: v.id("canvases"), name: v.string() })),
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const rows = await ctx.db.query("canvases").withIndex("by_project", q => q.eq("projectId", args.projectId).eq("archived", false)).take(200);
    return rows.filter(isDrawing).slice(0, MAX_CANVASES).map(({ _id, name }) => ({ _id, name }));
  },
});

export const createCanvas = mutation({
  args: { sessionToken: v.string(), projectId: v.id("projects"), name: v.string() },
  returns: v.id("canvases"),
  handler: async (ctx, args) => {
    const { member, project } = await requireMember(ctx, args.projectId, args.sessionToken);
    if (!canEdit(member) || !project.teamId) throw new ConvexError("You have view-only access");
    const name = canvasName(args.name);
    const existing = await ctx.db.query("canvases").withIndex("by_project", q => q.eq("projectId", project._id).eq("archived", false)).take(200);
    if (existing.filter(isDrawing).length >= MAX_CANVASES) throw new ConvexError(`A project can have up to ${MAX_CANVASES} canvases`);
    const now = Date.now();
    return ctx.db.insert("canvases", { teamId: project.teamId, projectId: project._id, name, archived: false, drawingElementCount: 0, drawingBytes: 0, createdAt: now, updatedAt: now });
  },
});

export const renameCanvas = mutation({
  args: { ...scope, canvasId: v.id("canvases"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await editableScene(ctx, args);
    await ctx.db.patch(args.canvasId, { name: canvasName(args.name), updatedAt: Date.now() });
    return null;
  },
});

export const scene = query({
  args: scope,
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    await sceneAccess(ctx, args);
    return (await sceneElements(ctx, args).take(MAX_ELEMENTS)).map(row => row.data);
  },
});

type DrawingElement = { id: unknown; version: unknown; versionNonce: unknown; type: unknown; x: unknown; y: unknown; width: unknown; height: unknown };

function parseElement(data: string) {
  if (data.length > 64000) throw new ConvexError("Drawing element is too large");
  let element: DrawingElement;
  try { element = JSON.parse(data) as DrawingElement; } catch { throw new ConvexError("Invalid drawing element"); }
  if (!element || typeof element !== "object" || typeof element.id !== "string" || !element.id || element.id.length > 100
    || !Number.isSafeInteger(element.version) || (element.version as number) < 1 || !Number.isSafeInteger(element.versionNonce)
    || ![element.x, element.y, element.width, element.height].every(Number.isFinite)
    || typeof element.type !== "string" || !ELEMENT_TYPES.has(element.type)) throw new ConvexError("Invalid drawing element");
  return { id: element.id, version: element.version as number, nonce: element.versionNonce as number };
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

export const updateElements = mutation({
  args: { ...scope, elements: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { container } = await editableScene(ctx, args);
    if (args.elements.length > 200) throw new ConvexError("Drawing update too large");
    const counted = container.drawingElementCount !== undefined && container.drawingBytes !== undefined;
    const rows = counted ? [] : await sceneElements(ctx, args).take(MAX_ELEMENTS + 1);
    let count = counted ? container.drawingElementCount! : rows.length;
    let bytes = counted ? container.drawingBytes! : rows.reduce((sum, row) => sum + byteLength(row.data), 0);
    const now = Date.now();
    for (const data of args.elements) {
      const element = parseElement(data);
      const existing = await ctx.db.query("drawingElements").withIndex("by_scene", q => q.eq("teamId", args.teamId).eq("canvasId", args.canvasId).eq("elementId", element.id)).unique();
      // Excalidraw's version, then its nonce as a tie-break, decides which concurrent edit wins.
      if (existing && (existing.version > element.version || (existing.version === element.version && existing.nonce <= element.nonce))) continue;
      count += existing ? 0 : 1;
      bytes += byteLength(data) - (existing ? byteLength(existing.data) : 0);
      if (count > MAX_ELEMENTS || bytes > MAX_BYTES) throw new ConvexError("Canvas is full. Export your drawing before starting a new one");
      const update = { version: element.version, nonce: element.nonce, data, updatedAt: now };
      if (existing) await ctx.db.patch(existing._id, update);
      else await ctx.db.insert("drawingElements", { teamId: args.teamId, canvasId: args.canvasId, elementId: element.id, ...update });
    }
    await ctx.db.patch(container._id, { drawingElementCount: count, drawingBytes: bytes, ...(args.canvasId ? { updatedAt: now } : {}) });
    return null;
  },
});

export const presence = query({
  args: scope,
  returns: v.array(v.object({ _id: v.id("drawingPresence"), userId: v.id("users"), name: v.string(), x: v.number(), y: v.number(), button: v.string(), updatedAt: v.number() })),
  handler: async (ctx, args) => {
    await sceneAccess(ctx, args);
    const rows = await scenePresence(ctx, args).take(100);
    return rows.filter(row => !row.agentId).map(({ _id, userId, name, x, y, button, updatedAt }) => ({ _id, userId, name, x, y, button, updatedAt }));
  },
});

export const setPresence = mutation({
  args: { ...scope, x: v.number(), y: v.number(), button: v.union(v.literal("up"), v.literal("down")), leave: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await sceneAccess(ctx, args);
    const row = await ctx.db.query("drawingPresence").withIndex("by_scene", q => q.eq("teamId", args.teamId).eq("canvasId", args.canvasId).eq("userId", user._id)).first();
    if (args.leave) { if (row) await ctx.db.delete(row._id); return null; }
    if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw new ConvexError("Invalid pointer");
    const patch = { name: user.name, x: args.x, y: args.y, button: args.button, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("drawingPresence", { teamId: args.teamId, canvasId: args.canvasId, userId: user._id, ...patch });
    return null;
  },
});

export const files = query({
  args: scope,
  returns: v.array(v.object({ fileId: v.string(), mimeType: v.string(), url: v.union(v.string(), v.null()) })),
  handler: async (ctx, args) => {
    await sceneAccess(ctx, args);
    const rows = await sceneFiles(ctx, args).take(MAX_FILES);
    return Promise.all(rows.map(async row => ({ fileId: row.fileId, mimeType: row.mimeType, url: await ctx.storage.getUrl(row.storageId) })));
  },
});

export const uploadUrl = mutation({
  args: scope,
  returns: v.string(),
  handler: async (ctx, args) => {
    await editableScene(ctx, args);
    return issueUpload(ctx, args.sessionToken, { kind: "drawing", teamId: args.teamId, ...(args.canvasId ? { canvasId: args.canvasId } : {}) });
  },
});

export const saveFile = mutation({
  args: { ...scope, fileId: v.string(), storageId: v.id("_storage"), mimeType: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, storageScope } = await editableScene(ctx, args);
    const metadata = await ctx.db.system.get(args.storageId);
    if (!metadata || metadata.size > 15 * 1024 * 1024 || !DRAWING_IMAGE_TYPES.has(args.mimeType) || !args.fileId || args.fileId.length > 100) throw new ConvexError("Choose an image under 15 MB");
    await admitStorageReference(ctx, args.storageId, user, storageScope);
    const existing = await ctx.db.query("drawingFiles").withIndex("by_scene", q => q.eq("teamId", args.teamId).eq("canvasId", args.canvasId).eq("fileId", args.fileId)).first();
    if (existing) return null;
    if ((await sceneFiles(ctx, args).take(MAX_FILES + 1)).length >= MAX_FILES) throw new ConvexError("This canvas has reached its image limit");
    await ctx.db.insert("drawingFiles", { teamId: args.teamId, canvasId: args.canvasId, fileId: args.fileId, storageId: args.storageId, mimeType: args.mimeType });
    return null;
  },
});
