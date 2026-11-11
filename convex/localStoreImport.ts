import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { seal } from "./lib/sealing";
import { hashToken } from "./lib/auth";

// One-time import of the retired ORIGIN_LOCAL_DATA_DIR store (scripts/migrate-local-store-to-convex.ts), through the
// signed /integrations action. "migrate.inspect" and "migrate.chatMessageIds" only read (the script's dry run uses
// nothing else); "migrate.apply" upserts by natural key, so re-running an import inserts nothing twice. Secrets arrive
// decrypted from the old integrations.key and are sealed here with ORIGIN_SEALING_KEY under their original purpose;
// no plaintext secret is ever written to a document.

type Ctx = QueryCtx | MutationCtx;
type Item = Record<string, unknown>;
export type ImportStatus = "absent" | "same" | "different";

const s = (item: Item, key: string) => {
  const value = item[key];
  if (typeof value !== "string") throw new ConvexError(`Import field ${key} must be a string`);
  return value;
};
const n = (item: Item, key: string) => {
  const value = item[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ConvexError(`Import field ${key} must be a number`);
  return value;
};
const optionalString = (item: Item, key: string) => typeof item[key] === "string" ? item[key] as string : undefined;
const team = (ctx: Ctx, value: string) => {
  const id = ctx.db.normalizeId("teams", value);
  if (!id) throw new ConvexError("Import row has an invalid workspace id");
  return id;
};
const asId = <T extends "projects" | "users">(ctx: Ctx, table: T, value: string) => {
  const id = ctx.db.normalizeId(table, value);
  if (!id) throw new ConvexError(`Import row has an invalid ${table} id`);
  return id as Id<T>;
};

/** Finds the existing document for one import item, by the same natural key the old sqlite primary key used. */
async function existing(ctx: Ctx, kind: string, item: Item) {
  switch (kind) {
    case "chatMessage": return ctx.db.query("teamChatMessages").withIndex("by_team_conversation_message", q => q.eq("teamId", team(ctx, s(item, "teamId"))).eq("conversation", s(item, "conversation")).eq("messageId", s(item, "messageId"))).first();
    case "chatDirect": return ctx.db.query("teamDirectConversations").withIndex("by_team_conversation", q => q.eq("teamId", team(ctx, s(item, "teamId"))).eq("conversation", s(item, "conversation"))).first();
    case "chatRead": return ctx.db.query("teamChatReads").withIndex("by_team_conversation_user", q => q.eq("teamId", team(ctx, s(item, "teamId"))).eq("conversation", s(item, "conversation")).eq("userId", s(item, "userId"))).first();
    case "chatFile": return ctx.db.query("teamChatFiles").withIndex("by_team_conversation_file", q => q.eq("teamId", team(ctx, s(item, "teamId"))).eq("conversation", s(item, "conversation")).eq("fileId", s(item, "fileId"))).first();
    case "marker": return ctx.db.query("localStoreMarkers").withIndex("by_name", q => q.eq("name", s(item, "name"))).unique();
    case "requestLimit": return ctx.db.query("requestLimits").withIndex("by_key", q => q.eq("key", s(item, "key"))).unique();
    case "lease": return ctx.db.query("serverLeases").withIndex("by_name", q => q.eq("name", s(item, "name"))).unique();
    case "githubApp": return ctx.db.query("githubAppRegistrations").withIndex("by_slot", q => q.eq("slot", "default")).unique();
    case "githubProject": return ctx.db.query("githubProjectConnections").withIndex("by_projectId", q => q.eq("projectId", asId(ctx, "projects", s(item, "projectId")))).unique();
    case "githubWorkspace": return ctx.db.query("githubWorkspaceConnections").withIndex("by_teamId", q => q.eq("teamId", team(ctx, s(item, "teamId")))).unique();
    case "githubState": return ctx.db.query("githubOAuthStates").withIndex("by_stateHash", q => q.eq("stateHash", s(item, "stateHash"))).unique();
    case "githubJob": return ctx.db.query("githubJobs").withIndex("by_key", q => q.eq("key", s(item, "key"))).unique();
    case "mcpClient": return ctx.db.query("mcpOAuthClients").withIndex("by_clientId", q => q.eq("clientId", s(item, "clientId"))).unique();
    case "mcpGrant": return ctx.db.query("mcpOAuthGrants").withIndex("by_grantId", q => q.eq("grantId", s(item, "grantId"))).unique();
    case "mcpCode": return ctx.db.query("mcpOAuthCodes").withIndex("by_codeHash", q => q.eq("codeHash", s(item, "codeHash"))).unique();
    case "mcpToken": return ctx.db.query("mcpOAuthTokens").withIndex("by_tokenHash", q => q.eq("tokenHash", s(item, "tokenHash"))).unique();
    case "invite": return ctx.db.query("inviteDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", s(item, "deliveryId"))).unique();
    case "archive": return ctx.db.query("localStoreArchive").withIndex("by_source_and_key", q => q.eq("source", s(item, "source")).eq("key", s(item, "key"))).unique();
  }
  throw new ConvexError(`Unknown import kind ${kind}`);
}

function status(kind: string, item: Item, row: Record<string, unknown> | null): ImportStatus {
  if (!row) return "absent";
  if (kind === "chatMessage") return row.payload === item.payload ? "same" : "different";
  if (kind === "chatRead") return (row.seen as number) >= n(item, "seen") ? "same" : "different";
  return "same";
}

/** Read-only: how each item compares with what Convex already holds. */
export const inspect = internalQuery({
  args: { kind: v.string(), items: v.array(v.record(v.string(), v.any())) },
  returns: v.array(v.union(v.literal("absent"), v.literal("same"), v.literal("different"))),
  handler: async (ctx, a) => {
    const result: ImportStatus[] = [];
    for (const item of a.items) result.push(status(a.kind, item, await existing(ctx, a.kind, item) as Record<string, unknown> | null));
    return result;
  },
});

/** Read-only: message ids Convex holds for one conversation, so the script can plan deletions made in the local store. */
export const chatMessageIds = internalQuery({
  args: { teamId: v.string(), conversation: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ ids: v.array(v.string()), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, a) => {
    // A marker can name a workspace id that is not valid here; it has no messages to compare.
    const teamId = ctx.db.normalizeId("teams", a.teamId);
    if (!teamId) return { ids: [], isDone: true, continueCursor: "" };
    const page = await ctx.db.query("teamChatMessages").withIndex("by_team_conversation_created", q => q.eq("teamId", teamId).eq("conversation", a.conversation)).paginate({ numItems: 500, cursor: a.cursor });
    return { ids: page.page.map(row => row.messageId), isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

async function applyOne(ctx: MutationCtx, kind: string, item: Item): Promise<"inserted" | "updated" | "skipped"> {
  const row = await existing(ctx, kind, item) as Record<string, unknown> & { _id: never } | null;
  const now = Date.now();
  if (kind === "chatMessage") {
    const value = { created: n(item, "created"), payload: s(item, "payload") };
    if (!row) { await ctx.db.insert("teamChatMessages", { teamId: team(ctx, s(item, "teamId")), conversation: s(item, "conversation"), messageId: s(item, "messageId"), ...value }); return "inserted"; }
    // The local store was the live copy: its edits, reactions and pins win.
    if (row.payload === value.payload) return "skipped";
    await ctx.db.patch(row._id, value);
    return "updated";
  }
  if (kind === "chatRead") {
    if (!row) { await ctx.db.insert("teamChatReads", { teamId: team(ctx, s(item, "teamId")), conversation: s(item, "conversation"), userId: s(item, "userId"), seen: n(item, "seen") }); return "inserted"; }
    if ((row.seen as number) >= n(item, "seen")) return "skipped";
    await ctx.db.patch(row._id, { seen: n(item, "seen") });
    return "updated";
  }
  if (row) return "skipped";
  switch (kind) {
    case "chatDirect": await ctx.db.insert("teamDirectConversations", { teamId: team(ctx, s(item, "teamId")), conversation: s(item, "conversation"), userA: s(item, "userA"), userB: s(item, "userB") }); break;
    case "chatFile": {
      const storageId = ctx.db.system.normalizeId("_storage", s(item, "storageId"));
      if (!storageId || !await ctx.db.system.get(storageId)) throw new ConvexError("Import file was not uploaded");
      await ctx.db.insert("teamChatFiles", { teamId: team(ctx, s(item, "teamId")), conversation: s(item, "conversation"), fileId: s(item, "fileId"), author: s(item, "author"), storageId, payload: s(item, "payload") });
      break;
    }
    case "marker": await ctx.db.insert("localStoreMarkers", { name: s(item, "name"), createdAt: now }); break;
    case "requestLimit":
      if (n(item, "expiresAt") < now) return "skipped";
      await ctx.db.insert("requestLimits", { key: s(item, "key"), count: n(item, "count"), expiresAt: n(item, "expiresAt") });
      break;
    case "lease":
      if (n(item, "expiresAt") < now) return "skipped";
      await ctx.db.insert("serverLeases", { name: s(item, "name"), owner: s(item, "owner"), expiresAt: n(item, "expiresAt") });
      break;
    case "githubApp": await ctx.db.insert("githubAppRegistrations", { slot: "default", sealed: s(item, "sealed"), createdAt: now }); break;
    case "githubProject": await ctx.db.insert("githubProjectConnections", { projectId: asId(ctx, "projects", s(item, "projectId")), repo: s(item, "repo"), login: s(item, "login"), sealed: s(item, "sealed"), connectedBy: asId(ctx, "users", s(item, "connectedBy")), updatedAt: n(item, "updatedAt") }); break;
    case "githubWorkspace": await ctx.db.insert("githubWorkspaceConnections", { teamId: team(ctx, s(item, "teamId")), login: s(item, "login"), accountId: n(item, "accountId"), connectedBy: asId(ctx, "users", s(item, "connectedBy")), sealed: s(item, "sealed"), version: 1, updatedAt: now }); break;
    case "githubState":
      if (n(item, "expiresAt") <= now) return "skipped";
      await ctx.db.insert("githubOAuthStates", { stateHash: s(item, "stateHash"), browserHash: s(item, "browserHash"), sealed: s(item, "sealed"), expiresAt: n(item, "expiresAt") });
      break;
    case "githubJob": await ctx.db.insert("githubJobs", { key: s(item, "key"), state: s(item, "state"), ...(optionalString(item, "payload") !== undefined ? { payload: optionalString(item, "payload") } : {}), updatedAt: n(item, "updatedAt") }); break;
    case "mcpClient": await ctx.db.insert("mcpOAuthClients", { clientId: s(item, "clientId"), name: s(item, "name"), redirects: s(item, "redirects"), createdAt: n(item, "createdAt") }); break;
    case "mcpGrant": await ctx.db.insert("mcpOAuthGrants", { grantId: s(item, "grantId"), clientId: s(item, "clientId"), sealed: s(item, "sealed"), connectorTokenHash: s(item, "connectorTokenHash"), scope: s(item, "scope"), resource: s(item, "resource"), expiresAt: n(item, "expiresAt"), revoked: item.revoked === true }); break;
    case "mcpCode": await ctx.db.insert("mcpOAuthCodes", { codeHash: s(item, "codeHash"), grantId: s(item, "grantId"), redirect: s(item, "redirect"), challenge: s(item, "challenge"), expiresAt: n(item, "expiresAt"), used: item.used === true }); break;
    case "mcpToken": {
      const kindValue = s(item, "kind");
      if (kindValue !== "access" && kindValue !== "refresh") throw new ConvexError("Import token kind must be access or refresh");
      await ctx.db.insert("mcpOAuthTokens", { tokenHash: s(item, "tokenHash"), grantId: s(item, "grantId"), kind: kindValue, expiresAt: n(item, "expiresAt"), used: item.used === true, ...(optionalString(item, "scope") !== undefined ? { scope: optionalString(item, "scope") } : {}) });
      break;
    }
    case "invite": await ctx.db.insert("inviteDeliveries", { deliveryId: s(item, "deliveryId"), sent: item.sent === true, createdAt: now }); break;
    case "archive": await ctx.db.insert("localStoreArchive", { source: s(item, "source"), key: s(item, "key"), ...(optionalString(item, "teamId") ? { teamId: optionalString(item, "teamId") } : {}), payload: s(item, "payload"), importedAt: now }); break;
    default: throw new ConvexError(`Unknown import kind ${kind}`);
  }
  return "inserted";
}

export const apply = internalMutation({
  args: { kind: v.string(), items: v.array(v.record(v.string(), v.any())) },
  returns: v.object({ inserted: v.number(), updated: v.number(), skipped: v.number() }),
  handler: async (ctx, a) => {
    const counts = { inserted: 0, updated: 0, skipped: 0 };
    for (const item of a.items) counts[await applyOne(ctx, a.kind, item)] += 1;
    return counts;
  },
});

/** Deletes messages the local store had deleted after copying them from Convex. Returns how many existed. */
export const deleteChatMessages = internalMutation({
  args: { teamId: v.id("teams"), conversation: v.string(), messageIds: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, a) => {
    let deleted = 0;
    for (const messageId of a.messageIds) {
      const row = await ctx.db.query("teamChatMessages").withIndex("by_team_conversation_message", q => q.eq("teamId", a.teamId).eq("conversation", a.conversation).eq("messageId", messageId)).first();
      if (row) { await ctx.db.delete(row._id); deleted += 1; }
    }
    return deleted;
  },
});

/** Delivers mentions still queued in the old notification_outbox. Notifications are de-duplicated per message. */
export const notifyMentions = internalMutation({
  args: { items: v.array(v.object({ teamId: v.id("teams"), actorId: v.id("users"), messageId: v.string(), userIds: v.array(v.id("users")) })) },
  returns: v.null(),
  handler: async (ctx, a) => {
    for (const item of a.items) await ctx.scheduler.runAfter(0, internal.notifications.chatMentions, item);
    return null;
  },
});

/** A pending revocation from mcp_revocations: revokes the Convex connector grant behind it. */
export const revokeConnector = internalMutation({
  args: { tokenHash: v.string() }, returns: v.null(),
  handler: async (ctx, a) => {
    const grant = await ctx.db.query("connectorGrants").withIndex("by_tokenHash", q => q.eq("tokenHash", a.tokenHash)).unique();
    if (grant && !grant.revoked && !grant.hostId && !grant.runId) await ctx.db.patch(grant._id, { revoked: true });
    return null;
  },
});

type Secret = { path: string[]; purpose: string; plain: string };

function setPath(target: Record<string, unknown>, path: string[], value: string) {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new ConvexError("Import secret path does not exist");
    node = next as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (!last || !(last in node)) throw new ConvexError("Import secret path does not exist");
  node[last] = value;
}

/** Seals every plaintext secret in a batch with ORIGIN_SEALING_KEY and drops the plaintext before anything is stored. */
async function sealItems(kind: string, items: Item[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const item of items) {
    const { plain, secrets, ...rest } = item as Item & { plain?: unknown; secrets?: Secret[] };
    if (kind === "githubApp") out.push({ ...rest, sealed: await seal(String(plain), "github-app") });
    else if (kind === "githubProject") out.push({ ...rest, sealed: await seal(String(plain), `github-connection:${s(rest, "projectId")}:${s(rest, "repo")}`) });
    else if (kind === "githubWorkspace") out.push({ ...rest, sealed: await seal(String(plain), `github-team:${s(rest, "teamId")}`) });
    else if (kind === "githubState") out.push({ ...rest, sealed: await seal(String(plain), `github-state:${s(rest, "stateHash")}`) });
    else if (kind === "mcpGrant") out.push({ ...rest, sealed: await seal(String(plain), `mcp:${s(rest, "grantId")}`), connectorTokenHash: await hashToken(String(plain)) });
    else if (kind === "archive") {
      const payload = JSON.parse(s(rest, "payload")) as Record<string, unknown>;
      for (const secret of secrets ?? []) setPath(payload, secret.path, await seal(secret.plain, secret.purpose));
      out.push({ ...rest, payload: JSON.stringify(payload) });
    } else {
      if (plain !== undefined || secrets !== undefined) throw new ConvexError(`Import kind ${kind} takes no secrets`);
      out.push(rest);
    }
  }
  return out;
}

const SEALED_KINDS = new Set(["githubApp", "githubProject", "githubWorkspace", "githubState", "mcpGrant"]);

export async function localStoreOperation(ctx: ActionCtx, operation: string, a: Record<string, unknown>): Promise<{ result: unknown } | undefined> {
  const kind = typeof a.kind === "string" ? a.kind : "";
  const items = Array.isArray(a.items) ? a.items as Item[] : [];
  switch (operation) {
    case "migrate.inspect":
      // Sealed rows are compared by key only; never send their secrets just to inspect them.
      if (items.some(item => "plain" in item || "secrets" in item)) throw new ConvexError("Inspect takes keys, not secrets");
      return { result: await ctx.runQuery(internal.localStoreImport.inspect, { kind, items }) };
    case "migrate.chatMessageIds":
      return { result: await ctx.runQuery(internal.localStoreImport.chatMessageIds, { teamId: String(a.teamId ?? ""), conversation: String(a.conversation ?? ""), cursor: typeof a.cursor === "string" ? a.cursor : null }) };
    case "migrate.apply": {
      if (SEALED_KINDS.has(kind) && items.some(item => typeof item.plain !== "string")) throw new ConvexError(`Import kind ${kind} needs its secret`);
      return { result: await ctx.runMutation(internal.localStoreImport.apply, { kind, items: await sealItems(kind, items) }) };
    }
    case "migrate.deleteChatMessages":
      return { result: await ctx.runMutation(internal.localStoreImport.deleteChatMessages, { teamId: a.teamId as Id<"teams">, conversation: String(a.conversation ?? ""), messageIds: (a.messageIds as string[]) ?? [] }) };
    case "migrate.notifyMentions":
      return { result: await ctx.runMutation(internal.localStoreImport.notifyMentions, { items: items as never }) };
    case "migrate.revokeConnector":
      return { result: await ctx.runMutation(internal.localStoreImport.revokeConnector, { tokenHash: await hashToken(String(a.connectorToken ?? "")) }) };
    case "migrate.uploadUrl":
      return { result: await ctx.storage.generateUploadUrl() };
  }
  return undefined;
}
