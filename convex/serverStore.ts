import { v } from "convex/values";
import { internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { seal, unseal } from "./lib/sealing";
import { hashToken } from "./lib/auth";
import { countRequest, requestLimitReached } from "./lib/rateLimit";
import { localStoreOperation } from "./localStoreImport";

// Server-side state for the stateless Next frontend, reached only through the signed /integrations HTTP action
// (operations prefixed "store." and "mcp."). Secrets are sealed and unsealed here, in the HTTP action, with
// ORIGIN_SEALING_KEY; the mutations below only ever see ciphertext. Writes that must not race (job leases, token
// refreshes) are compare-and-set mutations, so any number of frontend instances can run at once.

const GITHUB_APP = "github-app";
const projectPurpose = (projectId: string, repo: string) => `github-connection:${projectId}:${repo}`;
const teamPurpose = (teamId: string) => `github-team:${teamId}`;
const statePurpose = (stateHash: string) => `github-state:${stateHash}`;
const JOB_LEASE_MS = 90000;

// ---- Rate limits and leases ----

export const limit = internalMutation({
  args: { key: v.string(), maximum: v.number(), durationMs: v.number() }, returns: v.boolean(),
  handler: (ctx, a) => countRequest(ctx, a.key.slice(0, 300), a.maximum, a.durationMs),
});

export const limitReached = internalQuery({
  args: { key: v.string(), maximum: v.number() }, returns: v.boolean(),
  handler: (ctx, a) => requestLimitReached(ctx, a.key.slice(0, 300), a.maximum),
});

export const leaseAcquire = internalMutation({
  args: { name: v.string(), owner: v.string(), durationMs: v.number() }, returns: v.boolean(),
  handler: async (ctx, a) => {
    const now = Date.now();
    const row = await ctx.db.query("serverLeases").withIndex("by_name", q => q.eq("name", a.name)).unique();
    if (row && row.expiresAt >= now && row.owner !== a.owner) return false;
    if (row) await ctx.db.patch(row._id, { owner: a.owner, expiresAt: now + a.durationMs });
    else await ctx.db.insert("serverLeases", { name: a.name, owner: a.owner, expiresAt: now + a.durationMs });
    return true;
  },
});

export const leaseRelease = internalMutation({
  args: { name: v.string(), owner: v.string() }, returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("serverLeases").withIndex("by_name", q => q.eq("name", a.name)).unique();
    if (row?.owner === a.owner) await ctx.db.delete(row._id);
    return null;
  },
});

/** Cron: drops expired rate-limit windows, leases and GitHub OAuth states in bounded batches. */
export const sweep = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const now = Date.now();
    for (const row of await ctx.db.query("requestLimits").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(500)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("serverLeases").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(200)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("githubOAuthStates").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(200)) await ctx.db.delete(row._id);
    return null;
  },
});

// ---- GitHub App registration ----

export const githubAppRow = internalQuery({
  args: {}, returns: v.union(v.null(), v.string()),
  handler: async ctx => (await ctx.db.query("githubAppRegistrations").withIndex("by_slot", q => q.eq("slot", "default")).unique())?.sealed ?? null,
});

/** Stores the App registered by the manifest flow. Returns false when another admin registered one first. */
export const githubAppInsert = internalMutation({
  args: { sealed: v.string() }, returns: v.boolean(),
  handler: async (ctx, a) => {
    if (await ctx.db.query("githubAppRegistrations").withIndex("by_slot", q => q.eq("slot", "default")).unique()) return false;
    await ctx.db.insert("githubAppRegistrations", { slot: "default", sealed: a.sealed, createdAt: Date.now() });
    return true;
  },
});

// ---- Project GitHub tokens ----

export const githubProjectRow = internalQuery({
  args: { projectId: v.id("projects"), repo: v.string() },
  returns: v.union(v.null(), v.object({ login: v.string(), updatedAt: v.number(), connectedBy: v.id("users"), sealed: v.string() })),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubProjectConnections").withIndex("by_projectId", q => q.eq("projectId", a.projectId)).unique();
    return row && row.repo === a.repo ? { login: row.login, updatedAt: row.updatedAt, connectedBy: row.connectedBy, sealed: row.sealed } : null;
  },
});

export const githubProjectUpsert = internalMutation({
  args: { projectId: v.id("projects"), repo: v.string(), login: v.string(), sealed: v.string(), connectedBy: v.id("users"), updatedAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubProjectConnections").withIndex("by_projectId", q => q.eq("projectId", a.projectId)).unique();
    const value = { repo: a.repo, login: a.login, sealed: a.sealed, connectedBy: a.connectedBy, updatedAt: a.updatedAt ?? Date.now() };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("githubProjectConnections", { projectId: a.projectId, ...value });
    return null;
  },
});

export const githubProjectDelete = internalMutation({
  args: { projectId: v.id("projects") }, returns: v.null(),
  handler: async (ctx, a) => {
    for (const row of await ctx.db.query("githubProjectConnections").withIndex("by_projectId", q => q.eq("projectId", a.projectId)).take(10)) await ctx.db.delete(row._id);
    return null;
  },
});

// ---- Workspace GitHub connections ----

const workspaceRow = v.object({ login: v.string(), accountId: v.number(), connectedBy: v.id("users"), sealed: v.string(), version: v.number() });

export const githubWorkspaceRow = internalQuery({
  args: { teamId: v.id("teams") }, returns: v.union(v.null(), workspaceRow),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubWorkspaceConnections").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    return row ? { login: row.login, accountId: row.accountId, connectedBy: row.connectedBy, sealed: row.sealed, version: row.version } : null;
  },
});

/** Saves a workspace connection. With `expectedVersion` (a token refresh) it writes only if nobody reconnected meanwhile. */
export const githubWorkspaceUpsert = internalMutation({
  args: { teamId: v.id("teams"), login: v.string(), accountId: v.number(), connectedBy: v.id("users"), sealed: v.string(), expectedVersion: v.optional(v.number()) },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubWorkspaceConnections").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    if (a.expectedVersion !== undefined && (!row || row.version !== a.expectedVersion || row.connectedBy !== a.connectedBy)) return false;
    const value = { login: a.login, accountId: a.accountId, connectedBy: a.connectedBy, sealed: a.sealed, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, { ...value, version: row.version + 1 });
    else await ctx.db.insert("githubWorkspaceConnections", { teamId: a.teamId, ...value, version: 1 });
    return true;
  },
});

export const githubWorkspaceDelete = internalMutation({
  args: { teamId: v.id("teams") }, returns: v.null(),
  handler: async (ctx, a) => {
    for (const row of await ctx.db.query("githubWorkspaceConnections").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).take(10)) await ctx.db.delete(row._id);
    return null;
  },
});

// ---- GitHub OAuth states ----

export const githubStateInsert = internalMutation({
  args: { stateHash: v.string(), browserHash: v.string(), sealed: v.string(), expiresAt: v.number() }, returns: v.null(),
  handler: async (ctx, a) => { await ctx.db.insert("githubOAuthStates", a); return null; },
});

/** The sealed state for a live (state, browser) pair; `consume` deletes it in the same transaction. */
export const githubStateTake = internalMutation({
  args: { stateHash: v.string(), browserHash: v.string(), consume: v.boolean() }, returns: v.union(v.null(), v.string()),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubOAuthStates").withIndex("by_stateHash", q => q.eq("stateHash", a.stateHash)).unique();
    if (!row || row.browserHash !== a.browserHash || row.expiresAt <= Date.now()) return null;
    if (a.consume) await ctx.db.delete(row._id);
    return row.sealed;
  },
});

// ---- GitHub jobs ----

const job = v.object({ state: v.string(), payload: v.union(v.string(), v.null()), updated: v.number() });

export const githubJobRead = internalQuery({
  args: { key: v.string() }, returns: v.union(v.null(), job),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubJobs").withIndex("by_key", q => q.eq("key", a.key)).unique();
    return row ? { state: row.state, payload: row.payload ?? null, updated: row.updatedAt } : null;
  },
});

export const githubJobSave = internalMutation({
  args: { key: v.string(), state: v.string(), payload: v.union(v.string(), v.null()), updatedAt: v.optional(v.number()) }, returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubJobs").withIndex("by_key", q => q.eq("key", a.key)).unique();
    const value = { state: a.state, payload: a.payload ?? undefined, updatedAt: a.updatedAt ?? Date.now() };
    if (row) await ctx.db.replace(row._id, { key: a.key, ...value });
    else await ctx.db.insert("githubJobs", { key: a.key, ...value });
    return null;
  },
});

/** Takes the job's lease unless another instance holds a fresh one (90 s). */
export const githubJobLock = internalMutation({
  args: { key: v.string() }, returns: v.boolean(),
  handler: async (ctx, a) => {
    const now = Date.now();
    const row = await ctx.db.query("githubJobs").withIndex("by_key", q => q.eq("key", a.key)).unique();
    if (!row) { await ctx.db.insert("githubJobs", { key: a.key, state: "working", updatedAt: now }); return true; }
    if (row.state === "working" && row.updatedAt >= now - JOB_LEASE_MS) return false;
    await ctx.db.patch(row._id, { state: "working", updatedAt: now });
    return true;
  },
});

// ---- Invitation emails ----

export const inviteClaim = internalMutation({
  args: { deliveryId: v.string() }, returns: v.object({ claimed: v.boolean(), sent: v.boolean() }),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("inviteDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", a.deliveryId)).unique();
    if (row) return { claimed: false, sent: row.sent };
    await ctx.db.insert("inviteDeliveries", { deliveryId: a.deliveryId, sent: false, createdAt: Date.now() });
    return { claimed: true, sent: false };
  },
});

export const inviteSent = internalMutation({
  args: { deliveryId: v.string() }, returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("inviteDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", a.deliveryId)).unique();
    if (row) await ctx.db.patch(row._id, { sent: true });
    return null;
  },
});

// ---- Signed bridge dispatch ----

type Args = Record<string, unknown>;
const str = (value: unknown) => typeof value === "string" ? value : "";
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Runs one signed bridge operation from the frontend. Returns undefined for an unknown operation. Inputs are
 * re-validated by the internal functions' validators; sealing purposes bind each ciphertext to its row.
 */
export async function storeOperation(ctx: ActionCtx, operation: string, a: Args): Promise<{ result: unknown } | undefined> {
  const done = (result: unknown) => ({ result: result === undefined ? null : result });
  switch (operation) {
    case "store.limit": return done(await ctx.runMutation(internal.serverStore.limit, { key: str(a.key), maximum: num(a.maximum), durationMs: num(a.durationMs) }));
    case "store.limitReached": return done(await ctx.runQuery(internal.serverStore.limitReached, { key: str(a.key), maximum: num(a.maximum) }));
    case "store.leaseAcquire": {
      const owner = crypto.randomUUID();
      return done(await ctx.runMutation(internal.serverStore.leaseAcquire, { name: str(a.name), owner, durationMs: num(a.durationMs) }) ? owner : null);
    }
    case "store.leaseRelease": return done(await ctx.runMutation(internal.serverStore.leaseRelease, { name: str(a.name), owner: str(a.owner) }));

    case "store.githubApp": {
      const sealed = await ctx.runQuery(internal.serverStore.githubAppRow, {});
      return done(sealed ? await unseal(sealed, GITHUB_APP) : null);
    }
    case "store.githubAppSave": return done(await ctx.runMutation(internal.serverStore.githubAppInsert, { sealed: await seal(str(a.config), GITHUB_APP) }));

    case "store.githubProjectInfo": {
      const row = await ctx.runQuery(internal.serverStore.githubProjectRow, { projectId: str(a.projectId) as Id<"projects">, repo: str(a.repo) });
      return done(row ? { login: row.login, updatedAt: row.updatedAt, connectedBy: row.connectedBy } : null);
    }
    case "store.githubProjectToken": {
      const row = await ctx.runQuery(internal.serverStore.githubProjectRow, { projectId: str(a.projectId) as Id<"projects">, repo: str(a.repo) });
      return done(row ? await unseal(row.sealed, projectPurpose(str(a.projectId), str(a.repo))) : null);
    }
    case "store.githubProjectSave": return done(await ctx.runMutation(internal.serverStore.githubProjectUpsert, {
      projectId: str(a.projectId) as Id<"projects">, repo: str(a.repo), login: str(a.login), connectedBy: str(a.connectedBy) as Id<"users">,
      sealed: await seal(str(a.token), projectPurpose(str(a.projectId), str(a.repo))),
    }));
    case "store.githubProjectDelete": return done(await ctx.runMutation(internal.serverStore.githubProjectDelete, { projectId: str(a.projectId) as Id<"projects"> }));

    case "store.githubWorkspaceInfo": {
      const row = await ctx.runQuery(internal.serverStore.githubWorkspaceRow, { teamId: str(a.teamId) as Id<"teams"> });
      return done(row ? { login: row.login, accountId: row.accountId, connectedBy: row.connectedBy } : null);
    }
    case "store.githubWorkspaceToken": {
      const row = await ctx.runQuery(internal.serverStore.githubWorkspaceRow, { teamId: str(a.teamId) as Id<"teams"> });
      if (!row || row.connectedBy !== str(a.connectedBy)) return done(null);
      return done({ login: row.login, accountId: row.accountId, version: row.version, token: JSON.parse(await unseal(row.sealed, teamPurpose(str(a.teamId)))) });
    }
    case "store.githubWorkspaceSave": return done(await ctx.runMutation(internal.serverStore.githubWorkspaceUpsert, {
      teamId: str(a.teamId) as Id<"teams">, login: str(a.login), accountId: num(a.accountId), connectedBy: str(a.connectedBy) as Id<"users">,
      sealed: await seal(JSON.stringify(a.token ?? null), teamPurpose(str(a.teamId))),
      ...(typeof a.expectedVersion === "number" ? { expectedVersion: a.expectedVersion } : {}),
    }));
    case "store.githubWorkspaceDelete": return done(await ctx.runMutation(internal.serverStore.githubWorkspaceDelete, { teamId: str(a.teamId) as Id<"teams"> }));

    case "store.githubStateCreate": return done(await ctx.runMutation(internal.serverStore.githubStateInsert, {
      stateHash: str(a.stateHash), browserHash: str(a.browserHash), expiresAt: num(a.expiresAt), sealed: await seal(str(a.value), statePurpose(str(a.stateHash))),
    }));
    case "store.githubStateTake": {
      const sealed = await ctx.runMutation(internal.serverStore.githubStateTake, { stateHash: str(a.stateHash), browserHash: str(a.browserHash), consume: a.consume === true });
      return done(sealed ? await unseal(sealed, statePurpose(str(a.stateHash))) : null);
    }

    case "store.githubJobRead": return done(await ctx.runQuery(internal.serverStore.githubJobRead, { key: str(a.key) }));
    case "store.githubJobSave": return done(await ctx.runMutation(internal.serverStore.githubJobSave, { key: str(a.key), state: str(a.state), payload: typeof a.payload === "string" ? a.payload : null }));
    case "store.githubJobLock": return done(await ctx.runMutation(internal.serverStore.githubJobLock, { key: str(a.key) }));

    case "store.inviteClaim": return done(await ctx.runMutation(internal.serverStore.inviteClaim, { deliveryId: str(a.deliveryId) }));
    case "store.inviteSent": return done(await ctx.runMutation(internal.serverStore.inviteSent, { deliveryId: str(a.deliveryId) }));

    case "mcp.registerClient": return done(await ctx.runMutation(internal.mcpOAuth.registerClient, { candidateId: str(a.candidateId), name: str(a.name), redirects: str(a.redirects), limitKey: str(a.limitKey), limitMaximum: num(a.limitMaximum) }));
    case "mcp.client": return done(await ctx.runQuery(internal.mcpOAuth.client, { clientId: str(a.clientId) }));
    case "mcp.issueCode": {
      const grantId = str(a.grantId), connectorToken = str(a.connectorToken);
      return done(await ctx.runMutation(internal.mcpOAuth.issueCode, {
        grantId, clientId: str(a.clientId), scope: str(a.scope), resource: str(a.resource), expiresAt: num(a.expiresAt),
        sealed: await seal(connectorToken, `mcp:${grantId}`), connectorTokenHash: await hashToken(connectorToken),
        codeHash: str(a.codeHash), redirect: str(a.redirect), challenge: str(a.challenge), codeExpiresAt: num(a.codeExpiresAt),
      }));
    }
    case "mcp.exchangeCode": return done(await ctx.runMutation(internal.mcpOAuth.exchangeCode, {
      clientId: str(a.clientId), codeHash: str(a.codeHash), redirect: str(a.redirect), verifierChallenge: str(a.verifierChallenge),
      accessHash: str(a.accessHash), refreshHash: str(a.refreshHash), accessTtl: num(a.accessTtl),
    }));
    case "mcp.exchangeRefresh": return done(await ctx.runMutation(internal.mcpOAuth.exchangeRefresh, {
      clientId: str(a.clientId), presentedHash: str(a.presentedHash), requestedScope: typeof a.requestedScope === "string" ? a.requestedScope : null,
      accessHash: str(a.accessHash), refreshHash: str(a.refreshHash), accessTtl: num(a.accessTtl),
    }));
    case "mcp.resolve": {
      const grant = await ctx.runQuery(internal.mcpOAuth.resolve, { accessHash: str(a.accessHash), resource: str(a.resource) });
      if (!grant) return done(null);
      try { return done({ grantId: grant.grantId, write: grant.write, connectorToken: await unseal(grant.sealed, `mcp:${grant.grantId}`) }); }
      catch { return done(null); }
    }
    case "mcp.revoke": return done(await ctx.runMutation(internal.mcpOAuth.revoke, { tokenHash: str(a.tokenHash), clientId: str(a.clientId) }));
  }
  return localStoreOperation(ctx, operation, a);
}
