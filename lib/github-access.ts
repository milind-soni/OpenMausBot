import { contextWithToken } from "./github-sync";
import { githubRequest } from "./github-workspace";
import { integrationBridge } from "./integration-bridge";

const verified = new Map<string, number>();
const TTL = 10 * 60000;

/**
 * Whether a project's own GitHub credential (the workspace connection, or a project token) can read the repository.
 * One GitHub App serves every workspace on an instance, so webhooks and App installation tokens for a repository
 * only reach a project whose workspace proved access to it; approving a repository URL alone is not enough.
 */
export async function canReadRepository(projectId: string, repoUrl: string, fresh = false) {
  const key = `${projectId}:${repoUrl.toLowerCase()}`;
  if (!fresh && (verified.get(key) ?? 0) > Date.now()) return true;
  verified.delete(key);
  try {
    const { token, repo } = await contextWithToken(projectId);
    if (!token || !repo || `https://github.com/${repo.owner}/${repo.repo}`.toLowerCase() !== repoUrl.toLowerCase()) return false;
    await githubRequest(`/repos/${repo.owner}/${repo.repo}`, token);
    if (verified.size > 5000) verified.clear();
    verified.set(key, Date.now() + TTL);
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

export function forgetRepositoryAccess() { verified.clear(); }
