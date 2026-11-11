import { contextWithToken } from "./github-sync";
import { githubRequest, readGitHubJob, saveGitHubJob } from "./github-workspace";
import { integrationBridge } from "./integration-bridge";
import { limitAction, limitReached } from "./server-store";

const TTL = 10 * 60000;
const GENERATION = "repo-access-generation";

// A successful read check is remembered for ten minutes in Convex (a one-request rate-limit window), keyed by a
// generation that a workspace disconnect bumps, so every instance forgets at once.
async function verifiedKey(projectId: string, repoUrl: string) {
  const generation = (await readGitHubJob(GENERATION))?.payload ?? "0";
  return `github-repo-verified:${generation}:${projectId}:${repoUrl.toLowerCase()}`;
}

/**
 * Whether a project's own GitHub credential (the workspace connection, or a project token) can read the repository.
 * One GitHub App serves every workspace on an instance, so webhooks and App installation tokens for a repository
 * only reach a project whose workspace proved access to it; approving a repository URL alone is not enough.
 */
export async function canReadRepository(projectId: string, repoUrl: string, fresh = false) {
  const key = await verifiedKey(projectId, repoUrl);
  if (!fresh && await limitReached(key, 1)) return true;
  try {
    const { token, repo } = await contextWithToken(projectId);
    if (!token || !repo || `https://github.com/${repo.owner}/${repo.repo}`.toLowerCase() !== repoUrl.toLowerCase()) return false;
    await githubRequest(`/repos/${repo.owner}/${repo.repo}`, token);
    await limitAction(key, 1, TTL).catch(() => { /* already remembered */ });
    return true;
  } catch { return false; }
}

/** Active projects with this approved repository whose workspace can read it. */
export async function verifiedRepositoryProjects(repoUrl: string) {
  const candidates = await integrationBridge<string[]>("prRepositoryProjects", { repoUrl });
  const allowed: string[] = [];
  for (const projectId of candidates) if (await canReadRepository(projectId, repoUrl)) allowed.push(projectId);
  return allowed;
}

export async function forgetRepositoryAccess() { await saveGitHubJob(GENERATION, "done", String(Date.now())); }
