import { createTaskPR } from "@/lib/github-prs";
import { githubProject } from "@/lib/githubLocal";
import { sessionTokenFromRequest } from "@/lib/workspace-session";
import { limitAction } from "@/lib/server-store";
import { BodyTooLarge, readBoundedText } from "@/lib/http-body";
import { errorText } from "@/lib/error-text";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = JSON.parse(await readBoundedText(request, 2000));
    if (typeof body.projectId !== "string" || typeof body.taskId !== "string") throw new Error("Project and task required");
    const sessionToken = sessionTokenFromRequest(request, body);
    const { user } = await githubProject(sessionToken, body.projectId, true);
    await limitAction(`github-pr:${user._id}`, 20, 60000);
    return Response.json(await createTaskPR(sessionToken, body.projectId, body.taskId));
  } catch (error) { return Response.json({ error: errorText(error, "PR creation failed") }, { status: error instanceof BodyTooLarge ? 413 : 400, headers: { "Cache-Control": "no-store" } }); }
}
