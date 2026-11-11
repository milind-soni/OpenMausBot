import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { countRequest } from "./lib/rateLimit";

// Storage for the MCP OAuth 2.1 authorization server in lib/mcp-oauth.ts (was integrations.sqlite mcp_* tables).
// The frontend generates every code and token and sends only SHA-256 hashes; connector tokens arrive through the
// signed bridge and are sealed there (serverStore.ts) before they reach these mutations. Each exchange is one
// transaction, and a grant revoked here revokes its Convex connector grant in the same transaction.

const UNUSED_CLIENT_TTL = 86400000;
const BATCH = 100;

async function grantRow(ctx: MutationCtx, grantId: string) {
  return ctx.db.query("mcpOAuthGrants").withIndex("by_grantId", q => q.eq("grantId", grantId)).unique();
}

/** Marks a grant revoked, deletes its tokens and revokes the Convex connector grant behind it. */
export async function revokeGrant(ctx: MutationCtx, grantId: string) {
  const grant = await grantRow(ctx, grantId);
  if (grant && !grant.revoked) {
    await ctx.db.patch(grant._id, { revoked: true });
    const connector = await ctx.db.query("connectorGrants").withIndex("by_tokenHash", q => q.eq("tokenHash", grant.connectorTokenHash)).unique();
    if (connector && !connector.revoked && !connector.hostId && !connector.runId) await ctx.db.patch(connector._id, { revoked: true });
  }
  for (const token of await ctx.db.query("mcpOAuthTokens").withIndex("by_grantId", q => q.eq("grantId", grantId)).take(500)) await ctx.db.delete(token._id);
}

async function activeGrant(ctx: MutationCtx, grantId: string, clientId?: string) {
  const grant = await grantRow(ctx, grantId);
  if (!grant || grant.revoked || grant.expiresAt <= Date.now() || (clientId !== undefined && grant.clientId !== clientId)) return null;
  return grant;
}

const scopeList = (scope: string) => scope.split(" ").filter(Boolean);

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const minted = { accessHash: v.string(), refreshHash: v.string(), accessTtl: v.number() };
const outcome = v.union(
  v.object({ scope: v.string(), accessExpiresAt: v.number() }),
  v.object({ error: v.string(), description: v.optional(v.string()) }),
);

async function mint(ctx: MutationCtx, grant: { grantId: string; expiresAt: number }, scope: string, a: { accessHash: string; refreshHash: string; accessTtl: number }) {
  const accessExpiresAt = Math.min(Date.now() + a.accessTtl, grant.expiresAt);
  await ctx.db.insert("mcpOAuthTokens", { tokenHash: a.accessHash, grantId: grant.grantId, kind: "access", expiresAt: accessExpiresAt, used: false, scope });
  await ctx.db.insert("mcpOAuthTokens", { tokenHash: a.refreshHash, grantId: grant.grantId, kind: "refresh", expiresAt: grant.expiresAt, used: false, scope });
  return { scope, accessExpiresAt };
}

/**
 * RFC 7591 registration: an identical registration (same name and redirect URIs) returns the existing client and keeps
 * it alive; a new one counts against `limitKey` first and is refused when that budget is spent.
 */
export const registerClient = internalMutation({
  args: { candidateId: v.string(), name: v.string(), redirects: v.string(), limitKey: v.string(), limitMaximum: v.number() },
  returns: v.union(v.object({ clientId: v.string(), createdAt: v.number() }), v.object({ error: v.literal("rate_limited") })),
  handler: async (ctx, a) => {
    const now = Date.now();
    const existing = await ctx.db.query("mcpOAuthClients").withIndex("by_name_and_redirects", q => q.eq("name", a.name).eq("redirects", a.redirects)).order("desc").first();
    if (existing) {
      await ctx.db.patch(existing._id, { createdAt: now });
      return { clientId: existing.clientId, createdAt: now };
    }
    if (!await countRequest(ctx, a.limitKey, a.limitMaximum, 60000)) return { error: "rate_limited" as const };
    await ctx.db.insert("mcpOAuthClients", { clientId: a.candidateId, name: a.name, redirects: a.redirects, createdAt: now });
    return { clientId: a.candidateId, createdAt: now };
  },
});

export const client = internalQuery({
  args: { clientId: v.string() },
  returns: v.union(v.null(), v.object({ name: v.string(), redirects: v.string() })),
  handler: async (ctx, a) => {
    if (!a.clientId) return null;
    const row = await ctx.db.query("mcpOAuthClients").withIndex("by_clientId", q => q.eq("clientId", a.clientId)).unique();
    return row ? { name: row.name, redirects: row.redirects } : null;
  },
});

export const issueCode = internalMutation({
  args: {
    grantId: v.string(), clientId: v.string(), sealed: v.string(), connectorTokenHash: v.string(), scope: v.string(), resource: v.string(), expiresAt: v.number(),
    codeHash: v.string(), redirect: v.string(), challenge: v.string(), codeExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    await ctx.db.insert("mcpOAuthGrants", { grantId: a.grantId, clientId: a.clientId, sealed: a.sealed, connectorTokenHash: a.connectorTokenHash, scope: a.scope, resource: a.resource, expiresAt: a.expiresAt, revoked: false });
    await ctx.db.insert("mcpOAuthCodes", { codeHash: a.codeHash, grantId: a.grantId, redirect: a.redirect, challenge: a.challenge, expiresAt: a.codeExpiresAt, used: false });
    return null;
  },
});

/** Authorization code exchange. Never throws for protocol errors, so revocations it makes always commit. */
export const exchangeCode = internalMutation({
  args: { clientId: v.string(), codeHash: v.string(), redirect: v.string(), verifierChallenge: v.string(), ...minted },
  returns: outcome,
  handler: async (ctx, a) => {
    const row = await ctx.db.query("mcpOAuthCodes").withIndex("by_codeHash", q => q.eq("codeHash", a.codeHash)).unique();
    if (!row) return { error: "invalid_grant" };
    // A code is single use. A second use revokes everything issued from it (OAuth 2.1 section 4.1.3); the used row
    // stays as a tombstone until it expires.
    if (row.used) { await revokeGrant(ctx, row.grantId); return { error: "invalid_grant", description: "Authorization code already used" }; }
    await ctx.db.patch(row._id, { used: true });
    const grant = await activeGrant(ctx, row.grantId, a.clientId);
    const fail = async (description?: string) => { await revokeGrant(ctx, row.grantId); return { error: "invalid_grant", ...(description ? { description } : {}) }; };
    if (!grant || row.expiresAt <= Date.now() || row.redirect !== a.redirect) return fail();
    if (!a.verifierChallenge || !constantTimeEqual(a.verifierChallenge, row.challenge)) return fail("PKCE verification failed");
    return mint(ctx, grant, grant.scope, a);
  },
});

/** Refresh token rotation with reuse detection: replaying a used refresh token revokes the whole grant. */
export const exchangeRefresh = internalMutation({
  args: { clientId: v.string(), presentedHash: v.string(), requestedScope: v.union(v.string(), v.null()), ...minted },
  returns: outcome,
  handler: async (ctx, a) => {
    const row = await ctx.db.query("mcpOAuthTokens").withIndex("by_tokenHash", q => q.eq("tokenHash", a.presentedHash)).unique();
    if (!row || row.kind !== "refresh" || row.expiresAt <= Date.now()) return { error: "invalid_grant" };
    const grant = await activeGrant(ctx, row.grantId, a.clientId);
    if (!grant) return { error: "invalid_grant" };
    if (row.used) { await revokeGrant(ctx, grant.grantId); return { error: "invalid_grant", description: "Refresh token reused" }; }
    const current = scopeList(row.scope ?? grant.scope);
    let scope = current.join(" ");
    if (a.requestedScope !== null) {
      if (scopeList(a.requestedScope).some(s => !current.includes(s))) return { error: "invalid_scope" };
      scope = a.requestedScope;
    }
    await ctx.db.patch(row._id, { used: true });
    return mint(ctx, grant, scope, a);
  },
});

/** The grant behind a live access token for `resource`; the bridge unseals its connector token. */
export const resolve = internalQuery({
  args: { accessHash: v.string(), resource: v.string() },
  returns: v.union(v.null(), v.object({ grantId: v.string(), sealed: v.string(), write: v.boolean() })),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("mcpOAuthTokens").withIndex("by_tokenHash", q => q.eq("tokenHash", a.accessHash)).unique();
    if (!row || row.kind !== "access" || row.expiresAt <= Date.now()) return null;
    const grant = await ctx.db.query("mcpOAuthGrants").withIndex("by_grantId", q => q.eq("grantId", row.grantId)).unique();
    if (!grant || grant.revoked || grant.expiresAt <= Date.now() || grant.resource !== a.resource) return null;
    return { grantId: grant.grantId, sealed: grant.sealed, write: scopeList(row.scope ?? grant.scope).includes("origin:write") };
  },
});

/** RFC 7009: revokes the whole grant behind an access or refresh token. Unknown tokens report false. */
export const revoke = internalMutation({
  args: { tokenHash: v.string(), clientId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("mcpOAuthTokens").withIndex("by_tokenHash", q => q.eq("tokenHash", a.tokenHash)).unique();
    const grant = row ? await grantRow(ctx, row.grantId) : null;
    if (!grant || (a.clientId && grant.clientId !== a.clientId)) return false;
    await revokeGrant(ctx, grant.grantId);
    return true;
  },
});

/**
 * Cron (every minute): revokes grants whose codes expired unused (abandoned consents, so they leave Settings > Agents),
 * then deletes expired codes and tokens, dead grants and clients that never obtained a grant within a day.
 */
export const maintain = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const now = Date.now();
    let busy = false;
    const codes = await ctx.db.query("mcpOAuthCodes").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(BATCH);
    for (const code of codes) {
      if (!code.used) await revokeGrant(ctx, code.grantId);
      await ctx.db.delete(code._id);
    }
    const tokens = await ctx.db.query("mcpOAuthTokens").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(BATCH);
    for (const token of tokens) await ctx.db.delete(token._id);
    const expired = await ctx.db.query("mcpOAuthGrants").withIndex("by_revoked_and_expiresAt", q => q.eq("revoked", false).lt("expiresAt", now)).take(BATCH);
    for (const grant of expired) await revokeGrant(ctx, grant.grantId);
    const dead = await ctx.db.query("mcpOAuthGrants").withIndex("by_revoked_and_expiresAt", q => q.eq("revoked", true)).take(BATCH);
    for (const grant of dead) {
      if (await ctx.db.query("mcpOAuthCodes").withIndex("by_grantId", q => q.eq("grantId", grant.grantId)).first()) continue;
      await ctx.db.delete(grant._id);
    }
    const clients = await ctx.db.query("mcpOAuthClients").withIndex("by_createdAt", q => q.lt("createdAt", now - UNUSED_CLIENT_TTL)).take(BATCH);
    for (const client of clients) {
      if (!await ctx.db.query("mcpOAuthGrants").withIndex("by_clientId", q => q.eq("clientId", client.clientId)).first()) await ctx.db.delete(client._id);
    }
    busy = [codes, tokens, expired, clients].some(rows => rows.length === BATCH);
    if (busy) await ctx.scheduler.runAfter(0, internal.mcpOAuth.maintain, {});
    return null;
  },
});
