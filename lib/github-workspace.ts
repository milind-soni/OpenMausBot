import { createHash, randomBytes } from "node:crypto";
import { integrationDb, openIntegration, sealIntegration } from "./githubConnection";
import { githubHeaders } from "./github-repo";
import { originUrl } from "./integration-bridge";

export type GitHubAppConfig = { clientId: string; clientSecret: string; slug?: string; webhookSecret?: string; appId?: number; privateKey?: string };
type TokenRecord = { access_token: string; refresh_token?: string; expires_at?: number };
type Connection = { team: string; login: string; account_id: number; connected_by: string; encrypted: string };
export type GithubState = { teamId: string; sessionToken: string; userId: string; slug: string; mode: "connect" | "setup"; verifier: string; installationAttempted?: boolean; projectId?: string };

function db() {
  const database = integrationDb();
  database.exec(`CREATE TABLE IF NOT EXISTS github_workspace (team TEXT PRIMARY KEY, login TEXT NOT NULL, account_id INTEGER NOT NULL, connected_by TEXT NOT NULL, encrypted TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_app (id INTEGER PRIMARY KEY CHECK(id=1), encrypted TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_oauth_states (hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, encrypted TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS github_jobs (key TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS instance_operator (id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT NOT NULL, recorded INTEGER NOT NULL);`);
  return database;
}
const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export function githubAppConfig(): GitHubAppConfig | null {
  const row = db().prepare("SELECT encrypted FROM github_app WHERE id=1").get() as { encrypted: string } | undefined;
  const credentials = { appId: process.env.GITHUB_APP_ID ? Number(process.env.GITHUB_APP_ID) : undefined, privateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") };
  if (row) { const saved = JSON.parse(openIntegration(row.encrypted, "github-app")); return { ...saved, appId: credentials.appId ?? saved.appId, privateKey: credentials.privateKey ?? saved.privateKey }; }
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
export function canSetupGitHubApp(user: { email: string }, workspaceRole: string) {
  if (githubAppConfig() || !["owner", "admin"].includes(workspaceRole)) return false;
  const admins = instanceAdminEmails();
  return !admins.length || admins.includes(user.email.trim().toLowerCase());
}
/** Stores the App registered by the manifest flow. Returns false when another admin registered one first. */
export function saveGitHubApp(config: GitHubAppConfig) {
  const result = db().prepare("INSERT INTO github_app VALUES(1,?) ON CONFLICT(id) DO NOTHING").run(sealIntegration(JSON.stringify(config), "github-app"));
  return Number(result.changes) === 1;
}
export function workspaceGitHubInfo(team: string) {
  const row = db().prepare("SELECT team,login,account_id,connected_by FROM github_workspace WHERE team=?").get(team) as Omit<Connection, "encrypted"> | undefined;
  return row || null;
}
export function saveWorkspaceGitHub(team: string, login: string, accountId: number, connectedBy: string, token: TokenRecord) {
  db().prepare("INSERT INTO github_workspace VALUES(?,?,?,?,?) ON CONFLICT(team) DO UPDATE SET login=excluded.login,account_id=excluded.account_id,connected_by=excluded.connected_by,encrypted=excluded.encrypted")
    .run(team, login, accountId, connectedBy, sealIntegration(JSON.stringify(token), `github-team:${team}`));
}
export function disconnectWorkspaceGitHub(team: string) { db().prepare("DELETE FROM github_workspace WHERE team=?").run(team); }
const refreshing = new Map<string, Promise<string>>();
export async function workspaceGitHubToken(team: string, connectedBy: string) {
  const row = db().prepare("SELECT * FROM github_workspace WHERE team=? AND connected_by=?").get(team, connectedBy) as Connection | undefined;
  if (!row) return undefined;
  const token: TokenRecord = JSON.parse(openIntegration(row.encrypted, `github-team:${team}`));
  if (!token.expires_at || token.expires_at > Date.now() + 60000) return token.access_token;
  const existing = refreshing.get(team); if (existing) return existing;
  const refresh = (async () => {
    const config = githubAppConfig();
    if (!config || !token.refresh_token) throw new Error("Reconnect GitHub in workspace settings");
    const next = await exchangeGitHubToken({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: token.refresh_token });
    // A disconnect/reconnect during refresh must not restore an old authorization.
    const current = db().prepare("SELECT encrypted FROM github_workspace WHERE team=? AND connected_by=?").get(team, connectedBy) as { encrypted: string } | undefined;
    if (current?.encrypted !== row.encrypted) throw new Error("GitHub connection changed");
    saveWorkspaceGitHub(team, row.login, row.account_id, row.connected_by, next);
    return next.access_token;
  })();
  refreshing.set(team, refresh);
  try { return await refresh; } finally { refreshing.delete(team); }
}
export async function exchangeGitHubToken(params: Record<string, string>): Promise<TokenRecord> {
  const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000) });
  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !data.access_token || data.error) throw new Error("GitHub authorization failed. Please reconnect.");
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined };
}
export function createGithubState(value: Omit<GithubState, "verifier">) {
  const state = randomBytes(32).toString("base64url"), browser = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  db().prepare("DELETE FROM github_oauth_states WHERE expires < ?").run(Date.now());
  db().prepare("INSERT INTO github_oauth_states VALUES(?,?,?,?)").run(hashSecret(state), hashSecret(browser), sealIntegration(JSON.stringify({ ...value, verifier }), `github-state:${hashSecret(state)}`), Date.now() + 15 * 60000);
  return { state, browser, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export function consumeGithubState(state: string, browser: string, mode: GithubState["mode"]) {
  const row = db().prepare("DELETE FROM github_oauth_states WHERE hash=? AND browser_hash=? AND expires>? RETURNING encrypted").get(hashSecret(state), hashSecret(browser), Date.now()) as { encrypted: string } | undefined;
  if (!row) throw new Error("GitHub connection request expired. Start again from Settings.");
  const result: GithubState = JSON.parse(openIntegration(row.encrypted, `github-state:${hashSecret(state)}`));
  if (result.mode !== mode) throw new Error("Invalid connection request");
  return result;
}
export function peekGithubState(state: string, browser: string) {
  const row = db().prepare("SELECT encrypted FROM github_oauth_states WHERE hash=? AND browser_hash=? AND expires>?").get(hashSecret(state), hashSecret(browser), Date.now()) as { encrypted: string } | undefined;
  if (!row) throw new Error("GitHub connection request expired");
  return JSON.parse(openIntegration(row.encrypted, `github-state:${hashSecret(state)}`)) as GithubState;
}
export function githubAuthorizeUrl(state: string, challenge: string) {
  const config = githubAppConfig(); if (!config) throw new Error("GitHub App setup is required");
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

export function readGitHubJob(key: string) {
  return db().prepare("SELECT state,payload,updated FROM github_jobs WHERE key=?").get(key) as { state: string; payload: string | null; updated: number } | undefined;
}
export function saveGitHubJob(key: string, state: string, payload?: unknown) {
  db().prepare("INSERT INTO github_jobs VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,payload=excluded.payload,updated=excluded.updated").run(key, state, payload === undefined ? null : JSON.stringify(payload), Date.now());
}
export function lockGitHubJob(key: string) {
  const row = db().prepare("INSERT INTO github_jobs VALUES(?,'working',NULL,?) ON CONFLICT(key) DO UPDATE SET state='working',updated=excluded.updated WHERE github_jobs.state!='working' OR github_jobs.updated<? RETURNING key").get(key, Date.now(), Date.now() - 90000);
  return Boolean(row);
}
