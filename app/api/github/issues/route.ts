import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { githubProject } from "@/lib/githubLocal";
import { createGitHubTask } from "@/lib/github-sync";
import { getConvexClient, limitLocalAction, sessionTokenFromRequest } from "@/lib/localRealtime";
import { api } from "@/convex/_generated/api";
import { createTaskPR } from "@/lib/github-prs";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request);
    if (typeof body.projectId !== "string" || typeof body.taskId !== "string") throw new Error("Project and issue required");
    const sessionToken = sessionTokenFromRequest(request, body);
    const { user, project, token } = await githubProject(sessionToken, body.projectId, true);
    limitLocalAction(`github-create:${user._id}`, 20, 60000);
    if (!token && project.teamId && project.repoUrl && !project.githubWorkspaceAccess) {
      const client = getConvexClient();
      const workspace = await client.query(api.integrations.status, { sessionToken, teamId: project.teamId });
      if (workspace.connectedBy) {
        // Explicit issue creation by a workspace admin also approves this repository.
        // The mutation checks workspace membership, not the weaker project role.
        await client.mutation(api.integrations.approveRepository, { sessionToken, projectId: project._id, repoUrl: project.repoUrl });
      }
    }
    const task = await getConvexClient().query(api.tasks.details, { sessionToken, projectId: project._id, taskId: body.taskId as Id<"tasks"> });
    const issue = await createGitHubTask(body.projectId, body.taskId);
    if (task.task.githubTaskMode === "pull_request" || (!task.task.githubTaskMode && project.githubTaskMode === "pull_request")) return Response.json(await createTaskPR(sessionToken, body.projectId, body.taskId));
    return Response.json(issue);
  } catch (error) { return Response.json({ error: errorText(error, "GitHub issue creation failed") }, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
}
