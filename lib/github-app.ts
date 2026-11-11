import { createSign } from "node:crypto";
import { githubAppConfig, githubRequest, workspaceGitHubInfo } from "./github-workspace";
import { parseGitHubRepo } from "./github-repo";
import { integrationBridge } from "./integration-bridge";

const prPermissions = { contents: "write", pull_requests: "write", checks: "read" } as const;
export const permissionNotice = "Tasks as pull requests needs Contents: write, Pull requests: write and Checks: read. The App owner must save these permissions and subscribe to pull_request, pull_request_review, check_suite and check_run (keep issues). Then open GitHub Settings > Applications > Installed GitHub Apps > Origin > Configure and accept the new permissions. Existing issue sync continues with the current permissions.";
type Installation = { id: number; account?: { id: number; login: string }; suspended_at?: string | null; permissions: Record<string, string> };
type Account = { id: number; login: string };

export function appJwt() {
  const config = githubAppConfig();
  if (!config?.appId || !config.privateKey) throw new Error("The App owner must configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the Origin server for PRs. Existing issue sync is available.");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(config.appId) })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(config.privateKey, "base64url")}`;
}
export function repositoryPath(repoUrl: string) {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo || [repo.owner, repo.repo].some(part => part === "." || part === "..")) throw new Error("GitHub repository required");
  return `/repos/${repo.owner}/${repo.repo}`;
}
export async function installationFor(repoUrl: string, account?: Account) {
  const installation = await githubRequest<Installation>(`${repositoryPath(repoUrl)}/installation`, appJwt());
  if (account && (installation.account?.id !== account.id || installation.account.login.toLowerCase() !== account.login.toLowerCase())) throw new Error("Repository App installation does not belong to this workspace's connected GitHub account");
  if (installation.suspended_at || Object.entries(prPermissions).some(([key, level]) => installation.permissions[key] !== level && installation.permissions[key] !== "write")) throw new Error(permissionNotice);
  return installation;
}
// Tokens are held only in process memory and expire in one hour (GitHub's lifetime).
// Hosts revoke their push token immediately after git push. Never persist/return it to a model.
export async function installationToken(repoUrl: string, pushOnly = false, account?: Account) {
  const repo = parseGitHubRepo(repoUrl)!;
  const installation = await installationFor(repoUrl, account);
  const result = await githubRequest<{ token: string; expires_at: string; permissions: Record<string, string>; repositories: { full_name: string }[] }>(`/app/installations/${installation.id}/access_tokens`, appJwt(), {
    method: "POST", body: JSON.stringify({ repositories: [repo.repo], permissions: pushOnly ? { contents: "write" } : prPermissions }),
  });
  if (!result.token || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now() || Date.parse(result.expires_at) > Date.now() + 65 * 60000 || result.repositories?.length !== 1 || result.repositories[0].full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) {
    if (result.token) await revokeInstallationToken(result.token);
    throw new Error("Unexpected installation token scope");
  }
  return { token: result.token, expiresAt: result.expires_at };
}
export async function projectInstallationToken(projectId: string, repoUrl: string, pushOnly = false) {
  const account = await projectAccount(projectId, repoUrl);
  const credentials = await installationToken(repoUrl, pushOnly, account);
  try {
    const current = await projectAccount(projectId, repoUrl);
    if (current.id !== account.id || current.login.toLowerCase() !== account.login.toLowerCase()) throw new Error("GitHub connection changed during authorization");
    return credentials;
  } catch (error) { await revokeInstallationToken(credentials.token); throw error; }
}
async function projectAccount(projectId: string, repoUrl: string): Promise<Account> {
  const context = await integrationBridge<{ project: { repoUrl?: string; githubWorkspaceAccess?: boolean }; connection: { teamId: string; login: string; connectedBy: string } | null }>("context", { projectId });
  const connection = context.connection, saved = connection && workspaceGitHubInfo(connection.teamId);
  const expected = parseGitHubRepo(repoUrl), current = parseGitHubRepo(context.project.repoUrl);
  if (!context.project.githubWorkspaceAccess || !expected || !current || `${expected.owner}/${expected.repo}`.toLowerCase() !== `${current.owner}/${current.repo}`.toLowerCase() || !connection || !saved || saved.connected_by !== connection.connectedBy || saved.login.toLowerCase() !== connection.login.toLowerCase()) throw new Error("An active workspace admin must connect GitHub and authorize this repository before using the App for PRs");
  return { id: saved.account_id, login: saved.login };
}
export async function withInstallation<T>(projectId: string, repoUrl: string, fn: (token: string) => Promise<T>): Promise<T> {
  const { token } = await projectInstallationToken(projectId, repoUrl);
  try { return await fn(token); }
  finally {
    // githubRequest expects JSON; GitHub returns no body for this endpoint.
    await revokeInstallationToken(token);
  }
}
export async function revokeInstallationToken(token: string) {
  await fetch("https://api.github.com/installation/token", { method: "DELETE", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) }).catch(() => {});
}
