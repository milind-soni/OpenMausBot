import { integrationBridge, readIntegrationRequest } from "@/lib/integration-bridge";
import { createProjectRepository, syncGitHubOutbox, syncGitHubPage } from "@/lib/github-sync";
import { lockGitHubJob, saveGitHubJob } from "@/lib/github-workspace";
import { after } from "next/server";
import { syncPRPage } from "@/lib/github-prs";
import { BodyTooLarge } from "@/lib/http-body";

export const runtime = "nodejs";
export const maxDuration = 60;
// Called by the Convex cron every two minutes. The sync lease lives in Convex (githubJobs "sync-lock", 90 s), so at
// most one instance syncs at a time. MCP OAuth upkeep and chat notifications run in Convex itself.
export async function POST(request: Request) {
  let payload;
  try { payload = await readIntegrationRequest(request); } catch (error) { return new Response("Request rejected", { status: error instanceof BodyTooLarge ? 413 : 401 }); }
  if (payload.projectId) { await createProjectRepository(payload.projectId); return Response.json({ ok: true }); }
  // An Origin issue changed (convex/lib/githubIssueSync.ts): mirror it to GitHub now instead of on the next tick.
  if (payload.issues) { after(async () => { await syncGitHubOutbox(); }); return Response.json({ accepted: true }, { status: 202 }); }
  if (!await lockGitHubJob("sync-lock")) return Response.json({ busy: true });
  after(async () => {
    try {
      const pending = await integrationBridge<string[]>("pending", {});
      await Promise.all([...(pending.length ? [createProjectRepository(pending[0])] : []), syncGitHubPage(), syncPRPage(), syncGitHubOutbox()]);
    } finally { await saveGitHubJob("sync-lock", "done"); }
  });
  return Response.json({ accepted: true }, { status: 202 });
}
