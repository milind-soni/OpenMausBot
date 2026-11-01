import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { canEdit, projectMember } from "./lib/permissions";
import { requireUser } from "./lib/auth";
import { seal, unseal } from "./lib/sealing";
import { github, githubWebOrigin, installationToken, parseRepository, revokeInstallationToken, type GitHubAppSecrets } from "./lib/githubApi";
import { connection, NOT_SHARED, type Connection } from "./teamGitHub";

const FLOW_PURPOSE = (userId: Id<"users">) => `github-device:${userId}`;
const REPOS_MAX = 50;
const REVIEW_RETRIES = 24;
const REVIEW_RETRY_MS = 60 * 60_000;

export const flow = internalQuery({
  args: { userId: v.id("users"), teamId: v.id("teams") },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubDeviceFlows").withIndex("by_userId", q => q.eq("userId", a.userId)).unique();
    return row && row.teamId === a.teamId && row.expiresAt > Date.now() ? row : null;
  },
});

export const saveFlow = internalMutation({
  args: { userId: v.id("users"), teamId: v.id("teams"), sealed: v.optional(v.string()), expiresAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const existing = await ctx.db.query("githubDeviceFlows").withIndex("by_userId", q => q.eq("userId", a.userId)).unique();
    if (existing) await ctx.db.delete(existing._id);
    if (a.sealed && a.expiresAt) await ctx.db.insert("githubDeviceFlows", { userId: a.userId, teamId: a.teamId, sealed: a.sealed, expiresAt: a.expiresAt });
    return null;
  },
});

export const saveLink = internalMutation({
  args: { userId: v.id("users"), login: v.string(), githubId: v.number(), sealed: v.string(), clientId: v.string() },
  returns: v.union(v.null(), v.object({ sealed: v.string(), clientId: v.string() })),
  handler: async (ctx, a) => {
    const other = await ctx.db.query("githubUserLinks").withIndex("by_githubId", q => q.eq("githubId", a.githubId)).unique();
    if (other && other.userId !== a.userId) throw new ConvexError(`@${a.login} is already linked to another Origin account`);
    const mine = await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", a.userId)).unique();
    if (mine) await ctx.db.patch(mine._id, { login: a.login, githubId: a.githubId, sealed: a.sealed, clientId: a.clientId, linkedAt: Date.now() });
    else await ctx.db.insert("githubUserLinks", { ...a, linkedAt: Date.now() });
    return mine?.sealed && mine.clientId ? { sealed: mine.sealed, clientId: mine.clientId } : null;
  },
});

export const userTokenRow = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", a.userId)).unique();
    return row?.sealed && row.clientId ? { login: row.login, githubId: row.githubId, sealed: row.sealed, clientId: row.clientId, linkedAt: row.linkedAt } : null;
  },
});

export const saveUserToken = internalMutation({
  args: { userId: v.id("users"), linkedAt: v.number(), sealed: v.string() },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", a.userId)).unique();
    if (!row || row.linkedAt !== a.linkedAt) return false;
    await ctx.db.patch(row._id, { sealed: a.sealed });
    return true;
  },
});

/** The repositories of a workspace's projects this person may push to: editor of an active project whose repository the workspace authorized. */
export const editableRepositories = internalQuery({
  args: { userId: v.id("users"), teamId: v.id("teams") },
  returns: v.array(v.string()),
  handler: async (ctx, a) => {
    const user = await ctx.db.get(a.userId);
    if (!user) return [];
    const repos: string[] = [];
    for (const project of await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", a.teamId)).take(500)) {
      if (repos.length >= REPOS_MAX || project.status !== "active" || !project.repoUrl || !project.githubWorkspaceAccess) continue;
      const access = await projectMember(ctx, project, user);
      if (access && canEdit(access)) repos.push(project.repoUrl);
    }
    return repos;
  },
});

export const caller = internalQuery({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.object({ userId: v.id("users"), link: v.union(v.null(), v.object({ login: v.string() })) }),
  handler: async (ctx, a) => {
    const user = await requireUser(ctx, a.sessionToken);
    const member = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", a.teamId).eq("email", user.email)).unique();
    if (!member || member.status !== "active" || (member.userId && member.userId !== user._id)) throw new ConvexError("You don't have access to this workspace");
    const link = await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", user._id)).unique();
    return { userId: user._id, link: link ? { login: link.login } : null };
  },
});

async function oauth<T>(path: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(`${githubWebOrigin()}${path}`, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "origin-backend" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) throw new ConvexError("GitHub sign-in from Origin needs Device Flow. The GitHub App's owner turns on \"Enable Device Flow\" in the App's settings.");
  return await response.json() as T;
}

export const userTokenPurpose = (userId: Id<"users">) => `github-user:${userId}`;

/** Revokes a user token Origin kept, when it belongs to this App; one from another App expires on GitHub's schedule. */
async function revokeKept(app: GitHubAppSecrets, userId: Id<"users">, kept: { sealed: string; clientId: string } | null) {
  if (!kept || kept.clientId !== app.clientId) return;
  const token = await unseal(kept.sealed, userTokenPurpose(userId)).then((text) => (JSON.parse(text) as { access_token: string }).access_token).catch(() => null);
  if (token) await revokeUserToken(app, token);
}

export async function revokeUserToken(app: GitHubAppSecrets, token: string) {
  await fetch(`${githubWebOrigin() === "https://github.com" ? "https://api.github.com" : githubWebOrigin()}/applications/${app.clientId}/token`, {
    method: "DELETE", body: JSON.stringify({ access_token: token }), signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "origin-backend", Authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}` },
  }).catch(() => undefined);
}

export const recordCollaborator = internalMutation({
  args: { userId: v.id("users"), repoUrl: v.string(), login: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("githubCollaborators").withIndex("by_userId", q => q.eq("userId", a.userId)).take(200);
    if (!rows.some((row) => row.repoUrl === a.repoUrl && row.login === a.login)) await ctx.db.insert("githubCollaborators", a);
    return null;
  },
});

export const collaborators = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, a) => ctx.db.query("githubCollaborators").withIndex("by_userId", q => q.eq("userId", a.userId)).take(200),
});

export const forget = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, a) => {
    for (const row of await ctx.db.query("githubCollaborators").withIndex("by_userId", q => q.eq("userId", a.userId)).take(200)) await ctx.db.delete(row._id);
    const link = await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", a.userId)).unique();
    if (link) await ctx.db.delete(link._id);
    return null;
  },
});

/** Adds a person as a collaborator with push access on each repository, which GitHub turns into an invitation they accept. */
async function invite(ctx: ActionCtx, userId: Id<"users">, found: Connection, repos: readonly string[], login: string): Promise<number> {
  let invited = 0;
  for (const url of repos) {
    const repo = parseRepository(url);
    if (!repo || repo.owner.toLowerCase() !== found.row.accountLogin.toLowerCase()) continue;
    try {
      const minted = await installationToken(found.secrets.app, found.row.installationId, { administration: "write" }, repo);
      try {
        await github(`/repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(login)}`, minted.token, { method: "PUT", body: { permission: "push" } });
        await ctx.runMutation(internal.githubLinks.recordCollaborator, { userId, repoUrl: `https://github.com/${repo.owner}/${repo.repo}`, login });
        invited += 1;
      } finally { await revokeInstallationToken(minted.token); }
    } catch (error) {
      console.warn("GitHub collaborator invitation skipped", `${repo.owner}/${repo.repo}`, error instanceof Error ? error.message : error);
    }
  }
  return invited;
}

async function requireShared(ctx: ActionCtx, teamId: Id<"teams">): Promise<Connection> {
  const found = await connection(ctx, teamId);
  if (!found) throw new ConvexError(NOT_SHARED);
  return found;
}

/** Starts GitHub's device sign-in so a member proves which GitHub account is theirs; Origin keeps only the login. */
export const startLink = action({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.object({ userCode: v.string(), verificationUri: v.string(), interval: v.number(), expiresAt: v.number() }),
  handler: async (ctx, a) => {
    const me = await ctx.runQuery(internal.githubLinks.caller, a);
    const found = await requireShared(ctx, a.teamId);
    const started = await oauth<{ device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string }>("/login/device/code", { client_id: found.secrets.app.clientId });
    if (!started.device_code || !started.user_code || !started.verification_uri) throw new ConvexError(started.error === "device_flow_disabled" ? "GitHub sign-in from Origin needs Device Flow. The GitHub App's owner turns on \"Enable Device Flow\" in the App's settings." : "GitHub did not start the sign-in. Try again.");
    const expiresAt = Date.now() + (started.expires_in ?? 900) * 1000;
    await ctx.runMutation(internal.githubLinks.saveFlow, { userId: me.userId, teamId: a.teamId, sealed: await seal(started.device_code, FLOW_PURPOSE(me.userId)), expiresAt });
    return { userCode: started.user_code, verificationUri: started.verification_uri, interval: Math.max(5, started.interval ?? 5), expiresAt };
  },
});

export const finishLink = action({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.union(v.object({ state: v.literal("pending") }), v.object({ state: v.literal("linked"), login: v.string(), invited: v.number() })),
  handler: async (ctx, a): Promise<{ state: "pending" } | { state: "linked"; login: string; invited: number }> => {
    const me = await ctx.runQuery(internal.githubLinks.caller, a);
    const row = await ctx.runQuery(internal.githubLinks.flow, { userId: me.userId, teamId: a.teamId });
    if (!row) throw new ConvexError("The GitHub sign-in expired. Start again.");
    const found = await requireShared(ctx, a.teamId);
    const answer = await oauth<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string }>("/login/oauth/access_token", {
      client_id: found.secrets.app.clientId, device_code: await unseal(row.sealed, FLOW_PURPOSE(me.userId)), grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (answer.error === "authorization_pending" || answer.error === "slow_down") return { state: "pending" };
    await ctx.runMutation(internal.githubLinks.saveFlow, { userId: me.userId, teamId: a.teamId });
    if (!answer.access_token) throw new ConvexError(answer.error === "access_denied" ? "The GitHub sign-in was cancelled" : "The GitHub sign-in expired. Start again.");
    let replaced: { sealed: string; clientId: string } | null;
    let account: { id: number; login: string };
    try {
      account = await github<{ id: number; login: string }>("/user", answer.access_token);
      const sealed = await seal(JSON.stringify({ access_token: answer.access_token, refresh_token: answer.refresh_token, expires_at: answer.expires_in ? Date.now() + answer.expires_in * 1000 : undefined }), userTokenPurpose(me.userId));
      replaced = await ctx.runMutation(internal.githubLinks.saveLink, { userId: me.userId, login: account.login, githubId: account.id, sealed, clientId: found.secrets.app.clientId });
    } catch (error) {
      await revokeUserToken(found.secrets.app, answer.access_token);
      throw error;
    }
    await revokeKept(found.secrets.app, me.userId, replaced);
    const repos = await ctx.runQuery(internal.githubLinks.editableRepositories, { userId: me.userId, teamId: a.teamId });
    return { state: "linked", login: account.login, invited: await invite(ctx, me.userId, found, repos, account.login) };
  },
});

export const me = internalQuery({
  args: { sessionToken: v.string() },
  returns: v.id("users"),
  handler: async (ctx, a) => (await requireUser(ctx, a.sessionToken))._id,
});

type Grant = { _id: Id<"githubCollaborators">; repoUrl: string; login: string };

/** Takes back the push access and pending invitation Origin gave each grant's account; a grant GitHub kept stays recorded. */
async function withdraw(ctx: ActionCtx, found: Connection, grants: readonly Grant[]): Promise<number> {
  let removed = 0;
  for (const grant of grants) {
    const repo = parseRepository(grant.repoUrl);
    if (!repo || repo.owner.toLowerCase() !== found.row.accountLogin.toLowerCase()) continue;
    try {
      const minted = await installationToken(found.secrets.app, found.row.installationId, { administration: "write" }, repo);
      try {
        const path = `/repos/${repo.owner}/${repo.repo}`;
        const pending = await github<{ id: number; invitee?: { login?: string } | null }[]>(`${path}/invitations?per_page=100`, minted.token).catch(() => []);
        for (const invitation of pending) if (invitation.invitee?.login?.toLowerCase() === grant.login.toLowerCase()) await github(`${path}/invitations/${invitation.id}`, minted.token, { method: "DELETE" });
        await github(`${path}/collaborators/${encodeURIComponent(grant.login)}`, minted.token, { method: "DELETE" });
        await ctx.runMutation(internal.githubLinks.forgetGrant, { id: grant._id });
        removed += 1;
      } finally { await revokeInstallationToken(minted.token); }
    } catch (error) {
      console.warn("GitHub collaborator removal skipped", grant.repoUrl, error instanceof Error ? error.message : error);
    }
  }
  return removed;
}

export const forgetGrant = internalMutation({
  args: { id: v.id("githubCollaborators") },
  returns: v.null(),
  handler: async (ctx, a) => {
    if (await ctx.db.get(a.id)) await ctx.db.delete(a.id);
    return null;
  },
});

/** Removes the person's GitHub link, revokes the token Origin kept for it, and takes back the push access Origin gave that account. */
export const unlink = action({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.number(),
  handler: async (ctx, a): Promise<number> => {
    const userId: Id<"users"> = await ctx.runQuery(internal.githubLinks.me, { sessionToken: a.sessionToken });
    const rows = await ctx.runQuery(internal.githubLinks.collaborators, { userId });
    const found = await connection(ctx, a.teamId);
    const removed = found ? await withdraw(ctx, found, rows) : 0;
    if (found) await revokeKept(found.secrets.app, userId, await ctx.runQuery(internal.githubLinks.userTokenRow, { userId }));
    await ctx.runMutation(internal.githubLinks.forget, { userId });
    return removed;
  },
});

type AccessReview = { userId: Id<"users">; login: string | null; stale: Grant[]; missing: string[] };

export const accessReview = internalQuery({
  args: { teamId: v.id("teams"), email: v.string() },
  handler: async (ctx, a) => {
    const user = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", a.email)).unique();
    if (!user) return null;
    const link = await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", user._id)).unique();
    const grants = await ctx.db.query("githubCollaborators").withIndex("by_userId", q => q.eq("userId", user._id)).take(200);
    const teamRepos = new Set<string>();
    const editable = new Map<string, string>();
    for (const project of await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", a.teamId)).take(500)) {
      if (!project.repoUrl) continue;
      teamRepos.add(project.repoUrl.toLowerCase());
      if (user.status !== "active" || project.status !== "active" || !project.githubWorkspaceAccess) continue;
      const access = await projectMember(ctx, project, user);
      if (access && canEdit(access)) editable.set(project.repoUrl.toLowerCase(), project.repoUrl);
    }
    const stale = grants.filter((grant) => teamRepos.has(grant.repoUrl.toLowerCase()) && !editable.has(grant.repoUrl.toLowerCase()));
    const granted = new Set(grants.map((grant) => grant.repoUrl.toLowerCase()));
    const missing = link ? [...editable].filter(([key]) => !granted.has(key)).map(([, url]) => url).slice(0, REPOS_MAX) : [];
    return { userId: user._id, login: link?.login ?? null, stale: stale.map(({ _id, repoUrl, login }) => ({ _id, repoUrl, login })), missing };
  },
});

/**
 * Security: brings the push access Origin gave a person's linked GitHub in line with their current roles, after a
 * workspace or project role change or removal. Viewers and people who left lose it; editors who linked GitHub get it.
 */
export const reviewAccess = internalAction({
  args: { teamId: v.id("teams"), email: v.string(), attempt: v.optional(v.number()) },
  returns: v.object({ removed: v.number(), invited: v.number() }),
  handler: async (ctx, a): Promise<{ removed: number; invited: number }> => {
    const { attempt = 0, ...target } = a;
    const review: AccessReview | null = await ctx.runQuery(internal.githubLinks.accessReview, target);
    if (!review || (!review.stale.length && !review.missing.length)) return { removed: 0, invited: 0 };
    const found = await connection(ctx, a.teamId);
    let removed = 0, invited = 0;
    if (found) {
      removed = await withdraw(ctx, found, review.stale);
      invited = review.login ? await invite(ctx, review.userId, found, review.missing, review.login) : 0;
      const after: AccessReview | null = await ctx.runQuery(internal.githubLinks.accessReview, target);
      removed += after ? await withdraw(ctx, found, after.stale) : 0;
      if (!after?.stale.length) return { removed, invited };
    }
    if (attempt < REVIEW_RETRIES) await ctx.scheduler.runAfter(REVIEW_RETRY_MS, internal.githubLinks.reviewAccess, { ...target, attempt: attempt + 1 });
    return { removed, invited };
  },
});

/** The name and address git records for this person's commits: their linked GitHub account's private address when they linked one. */
export const gitIdentity = query({
  args: { sessionToken: v.string() },
  returns: v.object({ name: v.string(), email: v.string(), login: v.union(v.string(), v.null()) }),
  handler: async (ctx, a) => {
    const user = await requireUser(ctx, a.sessionToken);
    const link = await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", user._id)).unique();
    return link
      ? { name: user.name.trim() || link.login, email: `${link.githubId}+${link.login}@users.noreply.github.com`, login: link.login }
      : { name: user.name.trim() || user.email, email: user.email, login: null };
  },
});

export const linkedLogin = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, a) => (await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", a.userId)).unique())?.login ?? null,
});

/** Invites the person who asked for a new repository, when they linked their GitHub. */
export async function inviteCreator(ctx: ActionCtx, found: Connection, userId: Id<"users">, repoUrl: string): Promise<void> {
  const login = await ctx.runQuery(internal.githubLinks.linkedLogin, { userId });
  if (login && login.toLowerCase() !== found.row.connectorLogin.toLowerCase()) await invite(ctx, userId, found, [repoUrl], login);
}
