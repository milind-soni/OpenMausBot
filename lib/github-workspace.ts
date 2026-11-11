import { createHash, randomBytes } from "node:crypto";
import { githubHeaders } from "./github-repo";
import { originUrl } from "./integration-bridge";
import { store, withLease } from "./server-store";

// The instance's GitHub App, each workspace's GitHub connection, OAuth states and job markers. Everything is stored in
// Convex (convex/serverStore.ts); secrets are sealed there with ORIGIN_SEALING_KEY and never written to disk here.

export type GitHubAppConfig = { clientId: string; clientSecret: string; slug?: string; webhookSecret?: string; appId?: number; privateKey?: string };
type TokenRecord = { access_token: string; refresh_token?: string; expires_at?: number };
type StoredToken = { login: string; accountId: number; version: number; token: TokenRecord };
export type GithubState = { teamId: string; sessionToken: string; userId: string; slug: string; mode: "connect" | "setup"; verifier: string; installationAttempted?: boolean; projectId?: string };

const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export async function githubAppConfig(): Promise<GitHubAppConfig | null> {
  const saved = await store<string | null>("store.githubApp");
  const credentials = { appId: process.env.GITHUB_APP_ID ? Number(process.env.GITHUB_APP_ID) : undefined, privateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") };
  if (saved) { const config = JSON.parse(saved) as GitHubAppConfig; return { ...config, appId: credentials.appId ?? config.appId, privateKey: credentials.privateKey ?? config.privateKey }; }
  return process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET ? { ...credentials, clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET, webhookSecret: process.env.GITHUB_WEBHOOK_SECRET } : null;
}
/** ORIGIN_ADMIN_EMAILS (comma separated, lowercased): an optional operator lock on registering the App. */
function instanceAdminEmails() {
  return (process.env.ORIGIN_ADMIN_EMAILS || "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean);
}
/**
 * Who may register the instance's GitHub App with the manifest flow while none is configured: any owner or admin of
 * their workspace. An operator who opens sign-up to strangers can restrict it to named accounts with ORIGIN_ADMIN_EMAILS.
 */
export async function canSetupGitHubApp(user: { email: string }, workspaceRole: string, config?: GitHubAppConfig | null) {
  if (!["owner", "admin"].includes(workspaceRole) || (config === undefined ? await githubAppConfig() : config)) return false;
  const admins = instanceAdminEmails();
  return !admins.length || admins.includes(user.email.trim().toLowerCase());
}
/** Stores the App registered by the manifest flow. Returns false when another admin registered one first. */
export function saveGitHubApp(config: GitHubAppConfig) {
  return store<boolean>("store.githubAppSave", { config: JSON.stringify(config) });
}
export function workspaceGitHubInfo(team: string) {
  return store<{ login: string; accountId: number; connectedBy: string } | null>("store.githubWorkspaceInfo", { teamId: team });
}
export async function saveWorkspaceGitHub(team: string, login: string, accountId: number, connectedBy: string, token: TokenRecord) {
  await store("store.githubWorkspaceSave", { teamId: team, login, accountId, connectedBy, token });
}
export async function disconnectWorkspaceGitHub(team: string) { await store("store.githubWorkspaceDelete", { teamId: team }); }

const fresh = (token: TokenRecord) => !token.expires_at || token.expires_at > Date.now() + 60000;
const readToken = (team: string, connectedBy: string) => store<StoredToken | null>("store.githubWorkspaceToken", { teamId: team, connectedBy });

/**
 * The workspace's GitHub user token, refreshed when it is about to expire. GitHub refresh tokens are single use, so one
 * instance refreshes under a shared lease while others wait for the new token; the save is compare-and-set, so a
 * disconnect or reconnect during the refresh is never overwritten with the old authorization.
 */
export async function workspaceGitHubToken(team: string, connectedBy: string) {
  const row = await readToken(team, connectedBy);
  if (!row) return undefined;
  if (fresh(row.token)) return row.token.access_token;
  const refreshed = await withLease(`github-refresh:${team}`, 30000, async () => {
    const current = await readToken(team, connectedBy);
    if (!current) throw new Error("Reconnect GitHub in workspace settings");
    if (fresh(current.token)) return current.token.access_token;
    const config = await githubAppConfig();
    if (!config || !current.token.refresh_token) throw new Error("Reconnect GitHub in workspace settings");
    const next = await exchangeGitHubToken({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: current.token.refresh_token });
    if (!await store<boolean>("store.githubWorkspaceSave", { teamId: team, login: current.login, accountId: current.accountId, connectedBy, token: next, expectedVersion: current.version })) throw new Error("GitHub connection changed");
    return next.access_token;
  });
  if (!refreshed.busy) return refreshed.value;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const current = await readToken(team, connectedBy);
    if (!current) return undefined;
    if (fresh(current.token)) return current.token.access_token;
  }
  throw new Error("GitHub is refreshing this workspace's connection. Try again in a moment.");
}
export async function exchangeGitHubToken(params: Record<string, string>): Promise<TokenRecord> {
  const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000) });
  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !data.access_token || data.error) throw new Error("GitHub authorization failed. Please reconnect.");
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined };
}
export async function createGithubState(value: Omit<GithubState, "verifier">) {
  const state = randomBytes(32).toString("base64url"), browser = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  await store("store.githubStateCreate", { stateHash: hashSecret(state), browserHash: hashSecret(browser), value: JSON.stringify({ ...value, verifier }), expiresAt: Date.now() + 15 * 60000 });
  return { state, browser, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export async function consumeGithubState(state: string, browser: string, mode: GithubState["mode"]) {
  const value = await store<string | null>("store.githubStateTake", { stateHash: hashSecret(state), browserHash: hashSecret(browser), consume: true });
  if (!value) throw new Error("GitHub connection request expired. Start again from Settings.");
  const result: GithubState = JSON.parse(value);
  if (result.mode !== mode) throw new Error("Invalid connection request");
  return result;
}
export async function peekGithubState(state: string, browser: string) {
  const value = await store<string | null>("store.githubStateTake", { stateHash: hashSecret(state), browserHash: hashSecret(browser), consume: false });
  if (!value) throw new Error("GitHub connection request expired");
  return JSON.parse(value) as GithubState;
}
export async function githubAuthorizeUrl(state: string, challenge: string) {
  const config = await githubAppConfig(); if (!config) throw new Error("GitHub App setup is required");
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: `${originUrl()}/api/github/oauth/callback`, state, code_challenge: challenge, code_challenge_method: "S256" });
  if (!config.slug) params.set("scope", "repo");
  return `https://github.com/login/oauth/authorize?${params}`;
}

export class GitHubHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function githubRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: githubHeaders(token), cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    let detail = "";
    if (response.status === 422) {
      const payload = await response.json().catch(() => null) as { message?: string; errors?: { field?: string; code?: string; message?: string }[] } | null;
      detail = (payload?.errors || []).slice(0, 3).map(error => `${error.field || "request"}: ${error.message || error.code || "invalid"}`).join("; ").slice(0, 300);
    }
    const message = response.status === 401 ? "Reconnect GitHub in workspace settings"
      : [403, 429].includes(response.status) ? "GitHub permissions or rate limit prevented this action. Check the Origin GitHub App access and try again later."
      : response.status === 404 ? "Repository not found. Grant the Origin GitHub App access to this repository."
      : response.status === 422 ? `GitHub rejected this request${detail ? ` (${detail})` : ". Check the repository name and issue fields."}`
      : `GitHub request failed (${response.status})`;
    throw new GitHubHttpError(response.status, message);
  }
  return response.json();
}

/** Idempotency markers for GitHub side effects and sync cursors, shared by every instance. */
export function readGitHubJob(key: string) {
  return store<{ state: string; payload: string | null; updated: number } | null>("store.githubJobRead", { key }).then(row => row ?? undefined);
}
export async function saveGitHubJob(key: string, state: string, payload?: unknown) {
  await store("store.githubJobSave", { key, state, payload: payload === undefined ? null : JSON.stringify(payload) });
}
/** Takes the job's 90-second lease unless another instance holds a fresh one. */
export function lockGitHubJob(key: string) {
  return store<boolean>("store.githubJobLock", { key });
}
