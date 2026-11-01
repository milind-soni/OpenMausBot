import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { canEdit, getActiveTeamMember, projectMember, requireTeamAdmin, requireTeamMember } from "./lib/permissions";
import { requireUser } from "./lib/auth";
import { seal, sealingConfigured, SEALING_MISSING, unseal } from "./lib/sealing";
import {
  appJwt, github, GitHubError, installationToken, parseRepository, refreshUserToken, revokeInstallationToken,
  type GitHubAppSecrets, type GitHubUserToken, type ParsedRepository,
} from "./lib/githubApi";
import { githubAccountType, repoVisibility } from "./integrationTables";
import { inviteCreator } from "./githubLinks";
import { protectCreated } from "./githubProtection";
import { githubPR, checksSummary, toSnapshot, type PRSnapshot } from "../lib/github-pr-snapshot";
import { isRepositoryName, repositoryNameFor } from "../lib/github-repo-name";

export const NOT_SHARED = "GitHub isn't set up for this workspace yet. A workspace owner or admin connects it once in Settings > Integrations; then every member can use it.";
const ADMIN_ROLES = new Set(["owner", "admin"]);
const REPO_LEASE_MS = 90_000;

type Secrets = { app: GitHubAppSecrets; token: GitHubUserToken };
export type Connection = { row: Doc<"teamGitHub">; secrets: Secrets };
type Access = "read" | "write" | "push";
type ProjectView = Pick<Doc<"projects">, "_id" | "teamId" | "name" | "description" | "repoUrl" | "status" | "githubWorkspaceAccess" | "githubRepoVisibility">;
type ProjectAccess = { userId: Id<"users">; role: "owner" | "admin" | "member" | "viewer"; project: ProjectView };
export type RepositoryResult = { state: "ready"; repoUrl: string } | { state: "working" | "awaiting_connection" } | { state: "error"; error: string };

const PERMISSIONS: Record<Access, Record<string, string>> = {
  read: { metadata: "read", contents: "read", issues: "read", pull_requests: "read", checks: "read" },
  write: { contents: "write", issues: "write", pull_requests: "write", checks: "read" },
  push: { contents: "write" },
};

const purpose = (teamId: Id<"teams">) => `team-github:${teamId}`;
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

async function activeRow(ctx: QueryCtx, teamId: Id<"teams">) {
  const row = await ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", teamId)).unique();
  if (!row) return null;
  const by = await ctx.db.get(row.sharedBy);
  const member = by?.status === "active" ? await getActiveTeamMember(ctx, teamId, by.email) : null;
  return { row, by, valid: Boolean(member && ADMIN_ROLES.has(member.role)) };
}

export const status = query({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.object({
    shared: v.union(v.null(), v.object({ accountLogin: v.string(), accountType: githubAccountType, connectorLogin: v.string(), sharedByName: v.string(), updatedAt: v.number() })),
    stale: v.boolean(), canManage: v.boolean(), sealing: v.boolean(), linkedLogin: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, a) => {
    const { member, user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const found = await activeRow(ctx, a.teamId);
    const link = await ctx.db.query("githubUserLinks").withIndex("by_userId", q => q.eq("userId", user._id)).unique();
    const shared = found?.valid ? {
      accountLogin: found.row.accountLogin, accountType: found.row.accountType, connectorLogin: found.row.connectorLogin,
      sharedByName: found.by?.name || found.by?.email || "A workspace admin", updatedAt: found.row.updatedAt,
    } : null;
    return { shared, stale: Boolean(found && !found.valid), canManage: ADMIN_ROLES.has(member.role), sealing: sealingConfigured(), linkedLogin: link?.login ?? null };
  },
});

export const teamAccess = internalQuery({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  handler: async (ctx, a) => {
    const { member, user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    return { userId: user._id, role: member.role };
  },
});

export const projectAccess = internalQuery({
  args: { sessionToken: v.string(), projectId: v.id("projects") },
  handler: async (ctx, a): Promise<ProjectAccess> => {
    const user = await requireUser(ctx, a.sessionToken);
    const project = await ctx.db.get(a.projectId);
    if (!project) throw new ConvexError("Project not found");
    const member = await projectMember(ctx, project, user);
    if (!member) throw new ConvexError("You don't have access to this project");
    const { _id, teamId, name, description, repoUrl, status, githubWorkspaceAccess, githubRepoVisibility } = project;
    return { userId: user._id, role: member.role, project: { _id, teamId, name, description, repoUrl, status, githubWorkspaceAccess, githubRepoVisibility } };
  },
});

export const projectView = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, a): Promise<ProjectView> => {
    const project = await ctx.db.get(a.projectId);
    if (!project) throw new ConvexError("Project not found");
    const { _id, teamId, name, description, repoUrl, status, githubWorkspaceAccess, githubRepoVisibility } = project;
    return { _id, teamId, name, description, repoUrl, status, githubWorkspaceAccess, githubRepoVisibility };
  },
});

export const connectionRow = internalQuery({
  args: { teamId: v.id("teams") },
  handler: async (ctx, a) => {
    const found = await activeRow(ctx, a.teamId);
    const team = await ctx.db.get(a.teamId);
    return found?.valid ? { row: found.row, autoCreate: team?.githubAutoCreate !== false } : null;
  },
});

export const store = internalMutation({
  args: {
    teamId: v.id("teams"), sealed: v.string(), accountLogin: v.string(), accountId: v.number(), accountType: githubAccountType, installationId: v.number(),
    connectorLogin: v.string(), connectorId: v.number(), sharedBy: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const existing = await ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    const fields = { ...a, version: (existing?.version ?? 0) + 1, updatedAt: Date.now() };
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert("teamGitHub", fields);
    const team = await ctx.db.get(a.teamId);
    await ctx.db.patch(a.teamId, { githubLogin: a.connectorLogin, githubConnectedBy: a.sharedBy, githubAutoCreate: team?.githubAutoCreate ?? true });
    const waiting = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", a.teamId)).take(500);
    for (const project of waiting) {
      if (!project.repoUrl && project.status === "active" && project.githubRepoState === "awaiting_connection") await ctx.scheduler.runAfter(0, internal.teamGitHub.autoCreate, { projectId: project._id });
    }
    return null;
  },
});

export const saveToken = internalMutation({
  args: { teamId: v.id("teams"), version: v.number(), sealed: v.string() },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    if (!row || row.version !== a.version) return false;
    await ctx.db.patch(row._id, { sealed: a.sealed, version: row.version + 1, updatedAt: Date.now() });
    return true;
  },
});

export const useInstallation = internalMutation({
  args: { teamId: v.id("teams"), version: v.number(), accountLogin: v.string(), accountId: v.number(), accountType: githubAccountType, installationId: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    if (!row || row.version !== a.version) throw new ConvexError("The workspace's GitHub connection changed. Reload and try again.");
    await ctx.db.patch(row._id, { accountLogin: a.accountLogin, accountId: a.accountId, accountType: a.accountType, installationId: a.installationId, version: row.version + 1, updatedAt: Date.now() });
    return null;
  },
});

export const unshare = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, a) => {
    await requireTeamAdmin(ctx, a.teamId, a.sessionToken);
    const row = await ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    if (row) await ctx.db.delete(row._id);
    await ctx.db.patch(a.teamId, { githubLogin: undefined, githubConnectedBy: undefined });
    return null;
  },
});

/** The workspace's shared GitHub connection, opened, or null while none is shared. */
export async function connection(ctx: ActionCtx, teamId: Id<"teams">): Promise<(Connection & { autoCreate: boolean }) | null> {
  const found = await ctx.runQuery(internal.teamGitHub.connectionRow, { teamId });
  if (!found) return null;
  const secrets = JSON.parse(await unseal(found.row.sealed, purpose(teamId))) as Secrets;
  return { row: found.row, secrets, autoCreate: found.autoCreate };
}

async function requireConnection(ctx: ActionCtx, teamId: Id<"teams"> | undefined): Promise<Connection> {
  const found = teamId ? await connection(ctx, teamId) : null;
  if (!found) throw new ConvexError(NOT_SHARED);
  return found;
}

/** The connecting admin's own user token, refreshed when it is about to expire; only repository creation and listing need it. */
async function userToken(ctx: ActionCtx, found: Connection): Promise<string> {
  const { token } = found.secrets;
  if (!token.expires_at || token.expires_at > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new ConvexError("The workspace's GitHub connection expired. A workspace admin reconnects GitHub in Settings > Integrations.");
  const next = await refreshUserToken(found.secrets.app, token.refresh_token);
  const saved = await ctx.runMutation(internal.teamGitHub.saveToken, { teamId: found.row.teamId, version: found.row.version, sealed: await seal(JSON.stringify({ ...found.secrets, token: next }), purpose(found.row.teamId)) });
  if (!saved) {
    const current = await requireConnection(ctx, found.row.teamId);
    return current.secrets.token.access_token;
  }
  return next.access_token;
}

function repositoryOf(project: ProjectView): ParsedRepository {
  const repo = parseRepository(project.repoUrl);
  if (!repo) throw new ConvexError("Link a GitHub repository to this project first");
  return repo;
}

const repoUrlOf = (repo: ParsedRepository) => `https://github.com/${repo.owner}/${repo.repo}`;

/** Security: only a repository an admin approved (or Origin created) for this project, in the workspace's own GitHub account, gets a token. */
async function projectToken(ctx: ActionCtx, project: ProjectView, access: Access, extra: Record<string, string> = {}) {
  if (project.status && project.status !== "active") throw new ConvexError("Reactivate the project before using GitHub");
  const repo = repositoryOf(project);
  if (!project.githubWorkspaceAccess) throw new ConvexError("A workspace admin approves this repository in the project's Repo tab before the workspace's GitHub connection works on it");
  const found = await requireConnection(ctx, project.teamId);
  if (repo.owner.toLowerCase() !== found.row.accountLogin.toLowerCase()) throw new ConvexError(`${repo.owner}/${repo.repo} is outside ${found.row.accountLogin}, the GitHub account this workspace is connected to`);
  const minted = await installationToken(found.secrets.app, found.row.installationId, { ...PERMISSIONS[access], ...extra }, repo);
  return { token: minted.token, expiresAt: new Date(minted.expiresAt).toISOString(), repoUrl: repoUrlOf(repo), repo };
}

function accessOf(value: unknown): Access {
  if (value === "read" || value === "write" || value === "push") return value;
  throw new ConvexError("access must be read, write or push");
}

function extraOf(value: unknown): Record<string, string> {
  const extra = record(value);
  for (const [name, level] of Object.entries(extra)) if (name !== "actions" || (level !== "read" && level !== "write")) throw new ConvexError("Only Actions permissions may be added");
  return extra as Record<string, string>;
}

async function requireProject(ctx: ActionCtx, sessionToken: string, projectId: unknown, need: "member" | "editor" | "admin" = "member"): Promise<ProjectAccess> {
  if (typeof projectId !== "string") throw new ConvexError("Project required");
  const found = await ctx.runQuery(internal.teamGitHub.projectAccess, { sessionToken, projectId: projectId as Id<"projects"> });
  if (need === "editor" && !canEdit(found)) throw new ConvexError("You have view-only access");
  if (need === "admin" && !ADMIN_ROLES.has(found.role)) throw new ConvexError("A project admin approves and merges pull requests");
  return found;
}

type InstallationRow = { id: number; app_slug?: string; suspended_at?: string | null; account: { id: number; login: string; type: string } };

const usableInstallations = (rows: InstallationRow[], app: GitHubAppSecrets) =>
  rows.filter((row) => !row.suspended_at && (!app.slug || row.app_slug === app.slug) && ["User", "Organization"].includes(row.account.type));

export const sharedAccount = internalQuery({
  args: { teamId: v.id("teams") },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("teamGitHub").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    return row ? { accountType: row.accountType, installationId: row.installationId } : null;
  },
});

/** The organization a workspace already works in, when the reconnecting admin can still reach the App's installation there. */
type SharedAccount = { accountLogin: string; accountId: number; accountType: "User" | "Organization"; installationId: number };

async function keptOrganization(ctx: ActionCtx, teamId: Id<"teams">, app: GitHubAppSecrets, token: string): Promise<SharedAccount | null> {
  const previous: { accountType: "User" | "Organization"; installationId: number } | null = await ctx.runQuery(internal.teamGitHub.sharedAccount, { teamId });
  if (previous?.accountType !== "Organization") return null;
  const reachable: InstallationRow[] = await github<{ installations: InstallationRow[] }>("/user/installations?per_page=100", token).then((reply) => usableInstallations(reply.installations, app)).catch(() => []);
  const kept = reachable.find((row) => row.id === previous.installationId && row.account.type === "Organization");
  return kept ? { accountLogin: kept.account.login, accountId: kept.account.id, accountType: "Organization" as const, installationId: kept.id } : null;
}

export const share = action({
  args: {
    sessionToken: v.string(), teamId: v.id("teams"),
    app: v.object({ appId: v.number(), privateKey: v.string(), clientId: v.string(), clientSecret: v.string(), slug: v.optional(v.string()), webhookSecret: v.optional(v.string()) }),
    token: v.object({ access_token: v.string(), refresh_token: v.optional(v.string()), expires_at: v.optional(v.number()) }),
  },
  returns: v.object({ accountLogin: v.string() }),
  handler: async (ctx, a) => {
    const admin = await ctx.runQuery(internal.teamGitHub.teamAccess, { sessionToken: a.sessionToken, teamId: a.teamId });
    if (!ADMIN_ROLES.has(admin.role)) throw new ConvexError("A workspace owner or admin shares GitHub with the workspace");
    if (!sealingConfigured()) throw new ConvexError(SEALING_MISSING);
    const user = await github<{ id: number; login: string }>("/user", a.token.access_token);
    const jwt = await appJwt(a.app);
    const installation = await github<{ id: number; account: { id: number; login: string }; suspended_at?: string | null }>(`/users/${encodeURIComponent(user.login)}/installation`, jwt).catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 404) throw new ConvexError(`Install the Origin GitHub App on ${user.login} first, then share again`);
      throw error;
    });
    if (installation.suspended_at || installation.account.id !== user.id) throw new ConvexError("The Origin GitHub App's installation on your account is suspended or belongs to someone else");
    const sealed = await seal(JSON.stringify({ app: a.app, token: a.token } satisfies Secrets), purpose(a.teamId));
    const account: SharedAccount = await keptOrganization(ctx, a.teamId, a.app, a.token.access_token) ?? { accountLogin: user.login, accountId: user.id, accountType: "User", installationId: installation.id };
    await ctx.runMutation(internal.teamGitHub.store, { teamId: a.teamId, sealed, ...account, connectorLogin: user.login, connectorId: user.id, sharedBy: admin.userId });
    return { accountLogin: account.accountLogin };
  },
});


async function installations(ctx: ActionCtx, found: Connection): Promise<InstallationRow[]> {
  const result = await github<{ installations: InstallationRow[] }>("/user/installations?per_page=100", await userToken(ctx, found));
  return usableInstallations(result.installations, found.secrets.app);
}

export const accounts = action({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.array(v.object({ installationId: v.number(), login: v.string(), type: githubAccountType, current: v.boolean() })),
  handler: async (ctx, a) => {
    const admin = await ctx.runQuery(internal.teamGitHub.teamAccess, a);
    if (!ADMIN_ROLES.has(admin.role)) throw new ConvexError("A workspace owner or admin chooses the GitHub account");
    const found = await requireConnection(ctx, a.teamId);
    return (await installations(ctx, found)).map((row) => ({ installationId: row.id, login: row.account.login, type: row.account.type as "User" | "Organization", current: row.id === found.row.installationId }));
  },
});

export const chooseAccount = action({
  args: { sessionToken: v.string(), teamId: v.id("teams"), installationId: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const admin = await ctx.runQuery(internal.teamGitHub.teamAccess, { sessionToken: a.sessionToken, teamId: a.teamId });
    if (!ADMIN_ROLES.has(admin.role)) throw new ConvexError("A workspace owner or admin chooses the GitHub account");
    const found = await requireConnection(ctx, a.teamId);
    const chosen = (await installations(ctx, found)).find((row) => row.id === a.installationId);
    if (!chosen) throw new ConvexError("The Origin GitHub App is not installed on that account, or you cannot reach it");
    await ctx.runMutation(internal.teamGitHub.useInstallation, {
      teamId: a.teamId, version: found.row.version, accountLogin: chosen.account.login, accountId: chosen.account.id, accountType: chosen.account.type as "User" | "Organization", installationId: chosen.id,
    });
    return null;
  },
});

export const beginRepository = internalMutation({
  args: { projectId: v.id("projects"), visibility: v.optional(repoVisibility) },
  handler: async (ctx, a): Promise<{ state: "ready"; repoUrl: string } | { state: "working" } | { state: "start"; teamId: Id<"teams">; name: string; description: string; visibility: "private" | "public" }> => {
    const project = await ctx.db.get(a.projectId);
    if (!project?.teamId) throw new ConvexError("Project not found");
    if (project.repoUrl) return { state: "ready", repoUrl: project.repoUrl };
    if (project.status && project.status !== "active") throw new ConvexError("Reactivate the project before creating a repository");
    const job = await ctx.db.query("githubRepoJobs").withIndex("by_projectId", q => q.eq("projectId", a.projectId)).unique();
    if (job?.state === "working" && job.startedAt > Date.now() - REPO_LEASE_MS) return { state: "working" };
    if (job) await ctx.db.patch(job._id, { state: "working", startedAt: Date.now() });
    else await ctx.db.insert("githubRepoJobs", { projectId: a.projectId, state: "working", startedAt: Date.now() });
    if (a.visibility && a.visibility !== project.githubRepoVisibility) await ctx.db.patch(project._id, { githubRepoVisibility: a.visibility });
    return { state: "start", teamId: project.teamId, name: project.name, description: project.description ?? "", visibility: a.visibility ?? project.githubRepoVisibility ?? "private" };
  },
});

export const finishRepository = internalMutation({
  args: { projectId: v.id("projects"), state: v.union(v.literal("done"), v.literal("error")) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const job = await ctx.db.query("githubRepoJobs").withIndex("by_projectId", q => q.eq("projectId", a.projectId)).unique();
    if (job) await ctx.db.patch(job._id, { state: a.state });
    return null;
  },
});

type Repository = { id: number; html_url: string; description: string | null; owner: { login: string }; private: boolean };

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);
const withoutControlCharacters = (text: string) => Array.from(text, (char) => (isControl(char.charCodeAt(0)) ? " " : char)).join("");

async function createRepositoryFor(ctx: ActionCtx, projectId: Id<"projects">, request: { name?: string; visibility?: "private" | "public"; manual: boolean; requestedBy?: Id<"users"> }): Promise<RepositoryResult> {
  if (request.name !== undefined && !isRepositoryName(request.name)) return { state: "error", error: "Use a repository name of up to 100 letters, digits, dots, dashes or underscores" };
  const begun = await ctx.runMutation(internal.teamGitHub.beginRepository, { projectId, ...(request.visibility ? { visibility: request.visibility } : {}) });
  if (begun.state !== "start") return begun;
  let orgToken: string | undefined;
  try {
    const found = await connection(ctx, begun.teamId);
    if (!found || (!request.manual && !found.autoCreate)) {
      await ctx.runMutation(internal.integrations.repoResult, { projectId, state: "awaiting_connection" });
      await ctx.runMutation(internal.teamGitHub.finishRepository, { projectId, state: "done" });
      return { state: "awaiting_connection" };
    }
    const owner = found.row.accountLogin;
    const organization = found.row.accountType === "Organization";
    const token = organization
      ? (orgToken = (await installationToken(found.secrets.app, found.row.installationId, { administration: "write", metadata: "read" })).token)
      : await userToken(ctx, found);
    const name = request.name ?? repositoryNameFor(begun.name);
    const marker = `Origin project: ${projectId}`;
    let repo = await github<Repository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token).catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    });
    if (repo && !repo.description?.includes(marker)) throw new ConvexError(`${owner}/${name} already exists on GitHub. Choose another repository name.`);
    if (!repo) {
      const description = [withoutControlCharacters(begun.description).trim().slice(0, 200), marker].filter(Boolean).join(" | ");
      repo = await github<Repository>(organization ? `/orgs/${encodeURIComponent(owner)}/repos` : "/user/repos", token, {
        method: "POST", body: { name, description, private: begun.visibility !== "public", has_issues: true, auto_init: true },
      });
    }
    if (repo.owner.login.toLowerCase() !== owner.toLowerCase() || repo.private !== (begun.visibility !== "public")) throw new ConvexError("GitHub returned an unexpected repository owner or visibility. Review it on GitHub before linking.");
    await ctx.runMutation(internal.integrations.repoResult, { projectId, state: "ready", repoUrl: repo.html_url, repoId: repo.id });
    await ctx.runMutation(internal.teamGitHub.finishRepository, { projectId, state: "done" });
    await protectCreated(ctx, found, projectId, repo.html_url);
    if (request.requestedBy) await inviteCreator(ctx, found, request.requestedBy, repo.html_url).catch(() => undefined);
    return { state: "ready", repoUrl: repo.html_url };
  } catch (error) {
    const reason = message(error, "Repository creation failed");
    await ctx.runMutation(internal.integrations.repoResult, { projectId, state: "error", error: reason }).catch(() => undefined);
    await ctx.runMutation(internal.teamGitHub.finishRepository, { projectId, state: "error" });
    return { state: "error", error: reason };
  } finally {
    if (orgToken) await revokeInstallationToken(orgToken);
  }
}

const visibilityOf = (value: unknown) => (value === "public" || value === "private" ? value : undefined);
const nameOf = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export const createRepository = action({
  args: { sessionToken: v.string(), projectId: v.id("projects"), name: v.optional(v.string()), visibility: v.optional(repoVisibility) },
  handler: async (ctx, a): Promise<RepositoryResult> => {
    const { userId } = await requireProject(ctx, a.sessionToken, a.projectId, "editor");
    return createRepositoryFor(ctx, a.projectId, { name: nameOf(a.name), visibility: a.visibility, manual: true, requestedBy: userId });
  },
});

export const autoCreate = internalAction({
  args: { projectId: v.id("projects"), manual: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    await createRepositoryFor(ctx, a.projectId, { manual: a.manual === true });
    return null;
  },
});

async function readSnapshot(repo: ParsedRepository, number: number, token: string): Promise<PRSnapshot> {
  const path = `/repos/${repo.owner}/${repo.repo}`;
  const pr = githubPR.parse(await github(`${path}/pulls/${number}`, token));
  const [checks, review] = await Promise.all([
    github<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>(`${path}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100`, token).catch(() => ({ total_count: 1, check_runs: [] })),
    github<{ data?: { node?: { reviewDecision?: string | null } }; errors?: unknown[] }>("/graphql", token, { method: "POST", body: { query: "query($id:ID!){node(id:$id){... on PullRequest{reviewDecision}}}", variables: { id: pr.node_id } } }).catch(() => null),
  ]);
  const decision = !review || review.errors?.length ? "unknown" : review.data?.node?.reviewDecision?.toLowerCase() ?? "review_required";
  return toSnapshot(pr, `${repo.owner}/${repo.repo}`, checksSummary(checks.check_runs, [], checks.total_count > checks.check_runs.length), decision);
}

/** The issues of the same repository a pull request closes, as GitHub links them. */
async function closingIssues(repo: ParsedRepository, number: number, token: string): Promise<number[]> {
  const reply = await github<{ data?: { repository?: { pullRequest?: { closingIssuesReferences?: { nodes?: ({ number: number; repository: { nameWithOwner: string } } | null)[] } } | null } | null } }>("/graphql", token, {
    method: "POST", body: { query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}}}}}}", variables: { owner: repo.owner, name: repo.repo, number } },
  });
  const nodes = reply.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
  return nodes.flatMap((node) => (node && node.repository.nameWithOwner.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase() ? [node.number] : []));
}

export const taskBranch = internalQuery({
  args: { projectId: v.id("projects"), taskId: v.id("tasks") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, a) => {
    const task = await ctx.db.get(a.taskId);
    return task && task.projectId === a.projectId ? task.githubTaskBranch ?? null : null;
  },
});

async function withReadToken<T>(ctx: ActionCtx, project: ProjectView, fn: (token: string, repo: ParsedRepository) => Promise<T>): Promise<T> {
  const minted = await projectToken(ctx, project, "read");
  try { return await fn(minted.token, minted.repo); }
  finally { await revokeInstallationToken(minted.token); }
}

const numberOf = (value: unknown, what: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ConvexError(`${what} required`);
  return Number(value);
};

export const visibleProjects = internalQuery({
  args: { sessionToken: v.string(), projectIds: v.array(v.id("projects")) },
  returns: v.array(v.id("projects")),
  handler: async (ctx, a) => {
    const user = await requireUser(ctx, a.sessionToken);
    const allowed: Id<"projects">[] = [];
    for (const id of new Set(a.projectIds)) {
      const project = await ctx.db.get(id);
      if (project && await projectMember(ctx, project, user)) allowed.push(id);
    }
    return allowed;
  },
});

export const pullRequestProject = internalQuery({
  args: { id: v.id("taskPullRequests") },
  returns: v.union(v.null(), v.object({ projectId: v.id("projects"), url: v.string(), number: v.number() })),
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    return row ? { projectId: row.projectId, url: row.url, number: row.number } : null;
  },
});

async function visibleOnly<T extends { projectId: string }>(ctx: ActionCtx, sessionToken: string, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const allowed = new Set<string>(await ctx.runQuery(internal.teamGitHub.visibleProjects, { sessionToken, projectIds: rows.map((row) => row.projectId as Id<"projects">) }));
  return rows.filter((row) => allowed.has(row.projectId));
}

/**
 * The operations a member's own Origin server needs from the integration bridge, authorized by the member's Origin
 * session instead of the deployment's integration secret. Security: every write is re-read from GitHub here, so a
 * member's server can only report what GitHub says; it never supplies issue states, merge receipts or PR snapshots.
 */
async function sessionOperation(ctx: ActionCtx, sessionToken: string, operation: string, args: Record<string, unknown>): Promise<unknown> {
  switch (operation) {
    case "context": {
      await requireProject(ctx, sessionToken, args.projectId);
      return JSON.parse(await ctx.runQuery(internal.integrations.context, {
        projectId: args.projectId as Id<"projects">, ...(typeof args.taskId === "string" ? { taskId: args.taskId as Id<"tasks"> } : {}),
        ...(typeof args.credentialOwner === "string" ? { credentialOwner: args.credentialOwner as Id<"users"> } : {}),
      }));
    }
    case "githubToken": {
      const access = accessOf(args.access);
      const extra = extraOf(args.extra);
      const writes = access !== "read" || Object.values(extra).includes("write");
      const { project } = await requireProject(ctx, sessionToken, args.projectId, writes ? "editor" : "member");
      const { token, expiresAt, repoUrl } = await projectToken(ctx, project, access, extra);
      return { token, expiresAt, repoUrl };
    }
    case "createRepository": {
      const { project, userId } = await requireProject(ctx, sessionToken, args.projectId, "editor");
      return createRepositoryFor(ctx, project._id, { name: nameOf(args.name), visibility: visibilityOf(args.visibility), manual: true, requestedBy: userId });
    }
    case "repositories": {
      if (typeof args.teamId !== "string") throw new ConvexError("Workspace required");
      const admin = await ctx.runQuery(internal.teamGitHub.teamAccess, { sessionToken, teamId: args.teamId as Id<"teams"> });
      if (!ADMIN_ROLES.has(admin.role)) throw new ConvexError("A workspace admin chooses the repository");
      const found = await requireConnection(ctx, args.teamId as Id<"teams">);
      const rows = await github<{ full_name: string; html_url: string; private: boolean }[]>("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", await userToken(ctx, found));
      return { login: found.row.accountLogin, repositories: rows.map((row) => ({ fullName: row.full_name, url: row.html_url, private: row.private })) };
    }
    case "linkIssue": {
      const { project } = await requireProject(ctx, sessionToken, args.projectId, "editor");
      const number = numberOf(args.number, "Issue number");
      if (typeof args.taskId !== "string") throw new ConvexError("Issue required");
      const taskId = args.taskId as Id<"tasks">;
      const context = JSON.parse(await ctx.runQuery(internal.integrations.context, { projectId: project._id, taskId })) as { task: { githubIssueNumber?: number } | null };
      if (!context.task) throw new ConvexError("Issue not found");
      await withReadToken(ctx, project, async (token, repo) => {
        const issue = await github<{ number: number; state: "open" | "closed"; updated_at: string; body?: string | null; pull_request?: unknown }>(`/repos/${repo.owner}/${repo.repo}/issues/${number}`, token);
        const ours = context.task!.githubIssueNumber ? context.task!.githubIssueNumber === number : Boolean(issue.body?.includes(`<!-- origin-task:${taskId} -->`));
        if (issue.pull_request || issue.number !== number || !ours) throw new ConvexError("That GitHub issue does not belong to this Origin issue");
        const repoUrl = repoUrlOf(repo);
        await ctx.runMutation(internal.integrations.linkIssue, { projectId: project._id, taskId, repoUrl, number, issueUrl: `${repoUrl}/issues/${number}`, state: issue.state, updatedAt: Date.parse(issue.updated_at) });
      });
      return null;
    }
    case "unlinkIssue": {
      const { project } = await requireProject(ctx, sessionToken, args.projectId, "editor");
      if (typeof args.taskId !== "string") throw new ConvexError("Issue required");
      const number = numberOf(args.number, "Issue number");
      const removed = await withReadToken(ctx, project, (token, repo) => github<{ state: "open" | "closed" }>(`/repos/${repo.owner}/${repo.repo}/issues/${number}`, token).then(
        (issue) => issue.state === "closed",
        (error: unknown) => { if (error instanceof GitHubError && [404, 410].includes(error.status)) return true; throw error; },
      ));
      if (!removed) throw new ConvexError("That GitHub issue is still open");
      await ctx.runMutation(internal.integrations.unlinkIssue, { projectId: project._id, taskId: args.taskId as Id<"tasks">, number });
      return null;
    }
    case "webhookTargets": {
      if (typeof args.repoUrl !== "string") throw new ConvexError("Repository required");
      const rows = JSON.parse(await ctx.runQuery(internal.integrations.webhookTargets, { repoUrl: args.repoUrl, number: numberOf(args.number, "Issue number") })) as { projectId: string }[];
      return visibleOnly(ctx, sessionToken, rows);
    }
    case "prHumanContext": {
      if (typeof args.projectId !== "string" || typeof args.taskId !== "string") throw new ConvexError("Project and task required");
      return JSON.parse(await ctx.runMutation(internal.taskPRs.humanContext, { sessionToken, projectId: args.projectId as Id<"projects">, taskId: args.taskId as Id<"tasks">, ...(args.choosePR === true ? { choosePR: true } : {}) }));
    }
    case "prFinalize": {
      const { project } = await requireProject(ctx, sessionToken, args.projectId, "editor");
      if (typeof args.taskId !== "string") throw new ConvexError("Task required");
      const number = numberOf(record(args.snapshot).number, "Pull request number");
      const branch = await ctx.runQuery(internal.teamGitHub.taskBranch, { projectId: project._id, taskId: args.taskId as Id<"tasks"> });
      const snapshot = await withReadToken(ctx, project, (token, repo) => readSnapshot(repo, number, token));
      if (!branch || snapshot.branch !== branch) throw new ConvexError("That pull request is not on this issue's branch");
      return JSON.parse(await ctx.runMutation(internal.taskPRs.finalize, { sessionToken, projectId: project._id, taskId: args.taskId as Id<"tasks">, snapshot }));
    }
    case "prEventTargets": {
      if (typeof args.repoUrl !== "string" || !Array.isArray(args.numbers)) throw new ConvexError("Repository and pull requests required");
      const numbers = args.numbers.map((value) => numberOf(value, "Pull request number")).slice(0, 100);
      const rows = await ctx.runQuery(internal.taskPRs.eventTargets, { repoUrl: args.repoUrl, numbers, ...(typeof args.headSha === "string" ? { headSha: args.headSha } : {}) });
      return visibleOnly(ctx, sessionToken, rows);
    }
    case "prBeginSync":
    case "prSync": {
      if (typeof args.id !== "string") throw new ConvexError("Pull request required");
      const id = args.id as Id<"taskPullRequests">;
      const row = await ctx.runQuery(internal.teamGitHub.pullRequestProject, { id });
      if (!row) return null;
      const { project } = await requireProject(ctx, sessionToken, row.projectId, "editor");
      if (operation === "prBeginSync") return ctx.runMutation(internal.taskPRs.beginSync, { id });
      const snapshot = await withReadToken(ctx, project, async (token, repo) => {
        if (`${repoUrlOf(repo)}/pull/${row.number}`.toLowerCase() !== row.url.toLowerCase()) throw new ConvexError("Pull request repository changed");
        return readSnapshot(repo, row.number, token);
      });
      return ctx.runMutation(internal.taskPRs.sync, { id, sequence: numberOf(args.sequence, "Sequence"), snapshot });
    }
    case "completeMergedIssue": {
      const { project } = await requireProject(ctx, sessionToken, args.projectId, "admin");
      if (typeof args.taskId !== "string") throw new ConvexError("Issue required");
      const issueNumber = numberOf(args.issueNumber, "Issue number");
      const claimed = record(args.pullRequest);
      const number = numberOf(claimed.number, "Pull request number");
      return withReadToken(ctx, project, async (token, repo) => {
        const path = `/repos/${repo.owner}/${repo.repo}`;
        const pr = await github<{ merged?: boolean; merged_at?: string | null; merge_commit_sha?: string | null; head: { sha: string } }>(`${path}/pulls/${number}`, token);
        const issue = await github<{ state: string; pull_request?: unknown }>(`${path}/issues/${issueNumber}`, token);
        if (!(await closingIssues(repo, number, token)).includes(issueNumber)) return false;
        const mergedAt = Date.parse(pr.merged_at ?? "");
        const mergeSha = pr.merge_commit_sha;
        if (!pr.merged || !mergeSha || !Number.isFinite(mergedAt) || mergeSha !== claimed.mergeSha || pr.head.sha !== claimed.headSha || issue.pull_request || issue.state !== "closed") return false;
        return ctx.runMutation(internal.integrations.completeMergedIssue, {
          projectId: project._id, taskId: args.taskId as Id<"tasks">, repoUrl: repoUrlOf(repo), issueNumber,
          pullRequest: { number, headSha: pr.head.sha, mergeSha, mergedAt },
        });
      });
    }
    default:
      throw new ConvexError(`${operation} is not available to a member's Origin server`);
  }
}

export const bridge = action({
  args: { sessionToken: v.string(), operation: v.string(), args: v.any() },
  returns: v.any(),
  handler: async (ctx, a) => sessionOperation(ctx, a.sessionToken, a.operation, record(a.args)),
});

/** The signed integration bridge's GitHub operations: the operator's server is trusted like the deployment itself. */
export const operatorToken = internalAction({
  args: { projectId: v.id("projects"), access: v.string(), extra: v.optional(v.any()) },
  returns: v.object({ token: v.string(), expiresAt: v.string(), repoUrl: v.string() }),
  handler: async (ctx, a) => {
    const project = await ctx.runQuery(internal.teamGitHub.projectView, { projectId: a.projectId });
    const { token, expiresAt, repoUrl } = await projectToken(ctx, project, accessOf(a.access), extraOf(a.extra));
    return { token, expiresAt, repoUrl };
  },
});

export const operatorCreateRepository = internalAction({
  args: { projectId: v.id("projects"), name: v.optional(v.string()), visibility: v.optional(repoVisibility), manual: v.optional(v.boolean()) },
  handler: async (ctx, a): Promise<RepositoryResult> => createRepositoryFor(ctx, a.projectId, { name: nameOf(a.name), visibility: a.visibility, manual: a.manual === true }),
});
