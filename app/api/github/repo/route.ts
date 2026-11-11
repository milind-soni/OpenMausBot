import { NextResponse } from "next/server";
import { githubHeaders, githubProject, parseGitHubRepo } from "@/lib/githubLocal";
import { getConvexClient, requireLocalWorkspace, sessionTokenFromRequest } from "@/lib/workspace-session";
import { limitAction } from "@/lib/server-store";
import { createProjectRepository } from "@/lib/github-sync";
import { workspaceGitHubInfo } from "@/lib/github-workspace";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GitHubIssue = {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  author?: string;
  updatedAt: number;
};

type GitHubPullRequest = {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  author?: string;
  branch?: string;
  updatedAt: number;
};

function errorResponse(error: unknown, status = 400) {
  return NextResponse.json({ error: errorText(error, "Request failed") }, { status });
}

export async function POST(request: Request) {
  try {
    const user = await requireLocalWorkspace(request);
    if (!["owner", "admin"].includes(user.workspaceRole)) return errorResponse(new Error("A workspace admin must create the repository"), 403);
    const projectId = new URL(request.url).searchParams.get("projectId") as Id<"projects"> | null;
    if (!projectId) throw new Error("Project required");
    const project = await getConvexClient().query(api.projects.get, { sessionToken: sessionTokenFromRequest(request), projectId });
    if (project.teamId !== user.teamId) return errorResponse(new Error("Project not found"), 404);
    if (project.repoUrl) return NextResponse.json({ state: "ready", repoUrl: project.repoUrl });
    if (!await workspaceGitHubInfo(user.teamId)) return errorResponse(new Error("Connect GitHub to this workspace first"), 409);
    await limitAction(`github-create-repo:${user._id}`, 10, 60000);
    const result = await createProjectRepository(projectId, true);
    return NextResponse.json(result, { status: result.state === "error" ? 400 : result.state === "awaiting_connection" ? 409 : result.state === "working" ? 202 : 200 });
  } catch (error) { return errorResponse(error); }
}

export async function GET(request: Request) {
  try {
    const { project, user, token } = await githubProject(sessionTokenFromRequest(request), new URL(request.url).searchParams.get("projectId") || undefined);
    await limitAction(`github-read:${user._id}`, 60, 60000);
    const repo = parseGitHubRepo(project.repoUrl);
    if (!repo) throw new Error("Add a valid GitHub repo URL in Settings.");
    const headers = githubHeaders(token);
    const options = { headers, cache: "no-store" as const, signal: AbortSignal.timeout(15000) };
    const [issuesResponse, pullRequestsResponse, commitsResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/issues?state=all&per_page=30`, options),
      fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?state=all&per_page=20`, options),
      fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?per_page=30`, options),
    ]);
    if (!issuesResponse.ok || !pullRequestsResponse.ok) {
      const status = !issuesResponse.ok ? issuesResponse.status : pullRequestsResponse.status;
      throw new Error(status === 404 ? "Repository not found or access unavailable. Check the repository URL and workspace connection in repository settings." : status === 401 ? "Your GitHub connection has expired. Reconnect in repository settings." : status === 403 ? "GitHub denied access. Check the workspace connection, organization approval or rate limits." : `GitHub sync failed (${status}).`);
    }
    const issuesPayload = await issuesResponse.json() as Array<{
      number: number;
      title?: string;
      state?: "open" | "closed";
      html_url?: string;
      updated_at?: string;
      user?: { login?: string };
      pull_request?: unknown;
    }>;
    const pullsPayload = await pullRequestsResponse.json() as Array<{
      number: number;
      title?: string;
      state?: "open" | "closed";
      merged_at?: string | null;
      html_url?: string;
      updated_at?: string;
      user?: { login?: string };
      head?: { ref?: string };
    }>;
    const issues: GitHubIssue[] = issuesPayload
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title || `Issue #${issue.number}`,
        state: issue.state === "closed" ? "closed" : "open",
        url: issue.html_url || `https://github.com/${repo.owner}/${repo.repo}/issues/${issue.number}`,
        author: issue.user?.login,
        updatedAt: issue.updated_at ? new Date(issue.updated_at).getTime() : Date.now(),
      }));
    const pullRequests: GitHubPullRequest[] = pullsPayload.map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title || `PR #${pullRequest.number}`,
      state: pullRequest.merged_at ? "merged" : pullRequest.state === "closed" ? "closed" : "open",
      url: pullRequest.html_url || `https://github.com/${repo.owner}/${repo.repo}/pull/${pullRequest.number}`,
      author: pullRequest.user?.login,
      branch: pullRequest.head?.ref,
      updatedAt: pullRequest.updated_at ? new Date(pullRequest.updated_at).getTime() : Date.now(),
    }));
    const commits = commitsResponse.ok ? ((await commitsResponse.json()) as Array<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }>).map(item => ({ sha: item.sha, url: item.html_url, message: item.commit.message.split("\n")[0], author: item.commit.author?.name || "GitHub", committedAt: Date.parse(item.commit.author?.date) || Date.now() })) : [];
    return NextResponse.json({
      repo: `${repo.owner}/${repo.repo}`,
      tokenConfigured: Boolean(token),
      commits,
      commitsError: commitsResponse.ok || commitsResponse.status === 409 ? "" : "Commits unavailable. Check the token's Contents read permission.",
      issues,
      pullRequests,
      hosted: "origin-local",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
