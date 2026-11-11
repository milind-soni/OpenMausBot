import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { NextResponse } from "next/server";
import { githubHeaders, githubProject, parseGitHubRepo } from "@/lib/githubLocal";
import { deleteGitHubConnection, githubConnectionInfo, saveGitHubConnection } from "@/lib/githubConnection";
import { getConvexClient, sessionTokenFromRequest } from "@/lib/workspace-session";
import { limitAction } from "@/lib/server-store";
import { workspaceGitHubInfo } from "@/lib/github-workspace";
import { api } from "@/convex/_generated/api";
import { errorText } from "@/lib/error-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function context(request: Request) {
  const result = await githubProject(sessionTokenFromRequest(request), new URL(request.url).searchParams.get("projectId") || undefined);
  const repo = parseGitHubRepo(result.project.repoUrl);
  return { ...result, repo: repo ? `${repo.owner}/${repo.repo}`.toLowerCase() : null };
}
function failure(error: unknown) { return NextResponse.json({ error: errorText(error, "GitHub connection failed") }, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
export async function GET(request: Request) {
  try {
    const { project, repo, token } = await context(request);
    const projectConnection = repo ? await githubConnectionInfo(project._id, repo) : null;
    const workspace = project.teamId && project.githubWorkspaceAccess && token ? await workspaceGitHubInfo(project.teamId) : null;
    const status = workspace && project.teamId ? await getConvexClient().query(api.integrations.status, { sessionToken: sessionTokenFromRequest(request), teamId: project.teamId }) : null;
    const connection = projectConnection ? { ...projectConnection, source: "project" } : workspace && status?.connectedBy === workspace.connectedBy ? { login: workspace.login, source: "workspace" } : null;
    return NextResponse.json({ connection }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const { project, user, repo } = await context(request);
    if (!["admin", "owner"].includes(project.memberRole)) throw new Error("A project admin must connect GitHub");
    if (!repo) throw new Error("Add a GitHub repository in project settings first");
    await limitAction(`github-connect:${user._id}`, 10, 60000);
    const body = await readBoundedJson(request);
    if (typeof body.token !== "string" || body.token.length < 20 || body.token.length > 500 || /\s/.test(body.token)) throw new Error("Enter a valid GitHub access token");
    const headers = githubHeaders(body.token);
    const response = await fetch("https://api.github.com/user", { headers, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("GitHub could not verify this token. Check that it has not expired.");
    const account = await response.json() as { login: string };
    const repository = await fetch(`https://api.github.com/repos/${repo}`, { headers, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!repository.ok) throw new Error("This token cannot access the repository. Select this repository when creating the token and check organization approval.");
    const current = await context(request);
    if (current.user._id !== user._id || current.repo !== repo || !["admin", "owner"].includes(current.project.memberRole)) throw new Error("Repository access changed. Reload and reconnect GitHub.");
    await saveGitHubConnection(project._id, repo, account.login, body.token, user._id);
    return NextResponse.json({ connection: await githubConnectionInfo(project._id, repo) });
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try {
    const { project } = await context(request);
    if (!["admin", "owner"].includes(project.memberRole)) throw new Error("A project admin must disconnect GitHub");
    await deleteGitHubConnection(project._id);
    return NextResponse.json({ connection: null });
  } catch (error) { return failure(error); }
}
