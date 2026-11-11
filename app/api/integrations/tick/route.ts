import { integrationBridge, readIntegrationRequest } from "@/lib/integration-bridge";
import { createProjectRepository, syncGitHubPage } from "@/lib/github-sync";
import { lockGitHubJob, saveGitHubJob } from "@/lib/github-workspace";
import { after } from "next/server";
import { flushChatNotifications } from "@/lib/localRealtime";
import { syncPRPage } from "@/lib/github-prs";
import { BodyTooLarge } from "@/lib/http-body";
import { maintainMcpOAuth } from "@/lib/mcp-oauth";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  let payload;
  try { payload = await readIntegrationRequest(request); } catch (error) { return new Response("Request rejected", { status: error instanceof BodyTooLarge ? 413 : 401 }); }
  if (payload.projectId) { await createProjectRepository(payload.projectId); return Response.json({ ok: true }); }
  after(() => maintainMcpOAuth().catch(() => {}));
  if (!lockGitHubJob("sync-lock")) return Response.json({ busy: true });
  after(async () => {
    try {
      const pending = await integrationBridge<string[]>("pending", {});
      await Promise.all([...(pending.length ? [createProjectRepository(pending[0])] : []), syncGitHubPage(), syncPRPage(), flushChatNotifications()]);
    } finally { saveGitHubJob("sync-lock", "done"); }
  });
  return Response.json({ accepted: true }, { status: 202 });
}
