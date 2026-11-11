import { parseGitHubRepo } from "./github-repo";
export { parseGitHubRepo, githubHeaders, githubRepoUrl, manualIssueUrl, type ParsedGitHubRepo } from "./github-repo";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DEFAULT_OWNER_EMAIL } from "@/convex/lib/auth";
import { getConvexClient, requireLocalUser } from "./workspace-session";
import { githubConnectionInfo, githubConnectionToken } from "./githubConnection";
import { workspaceGitHubToken } from "./github-workspace";
import { integrationBridge } from "./integration-bridge";

export async function githubProject(sessionToken: string, projectId: string | undefined, write = false) {
  if (!projectId) throw new Error("Project required");
  const user = await requireLocalUser(sessionToken);
  const project = await getConvexClient().query(api.projects.get, { sessionToken, projectId: projectId as Id<"projects"> });
  if (write && project.memberRole === "viewer") throw new Error("You have view-only access");
  const repo = parseGitHubRepo(project.repoUrl);
  const repoName = repo ? `${repo.owner}/${repo.repo}`.toLowerCase() : null;
  const saved = repoName ? await githubConnectionInfo(project._id, repoName) : null;
  const credential = saved ? await integrationBridge<{ credentialAllowed: boolean }>("context", { projectId, credentialOwner: saved.connectedBy }) : null;
  const token = repoName && credential?.credentialAllowed ? await githubConnectionToken(project._id, repoName) : undefined;
  const legacyToken = user.email === DEFAULT_OWNER_EMAIL && project.ownerEmail === DEFAULT_OWNER_EMAIL ? process.env.GITHUB_TOKEN : undefined;
  const workspace = project.teamId ? await getConvexClient().query(api.integrations.status, { sessionToken, teamId: project.teamId }) : null;
  const workspaceToken = !token && project.githubWorkspaceAccess && workspace?.connectedBy && project.teamId ? await workspaceGitHubToken(project.teamId, workspace.connectedBy) : undefined;
  return { project, user, token: token || workspaceToken || legacyToken };
}
