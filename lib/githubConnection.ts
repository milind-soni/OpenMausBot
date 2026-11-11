import { store } from "./server-store";

// A project's own GitHub token (Settings > Repo). Convex seals it with ORIGIN_SEALING_KEY, bound to project and repo.

export async function saveGitHubConnection(project: string, repo: string, login: string, token: string, connectedBy: string) {
  await store("store.githubProjectSave", { projectId: project, repo, login, token, connectedBy });
}
export async function githubConnectionInfo(project: string, repo: string) {
  return store<{ login: string; updatedAt: number; connectedBy: string } | null>("store.githubProjectInfo", { projectId: project, repo });
}
export async function githubConnectionToken(project: string, repo: string) {
  return (await store<string | null>("store.githubProjectToken", { projectId: project, repo })) ?? undefined;
}
export async function deleteGitHubConnection(project: string) {
  await store("store.githubProjectDelete", { projectId: project });
}
