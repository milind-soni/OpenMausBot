import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { callJson, callOptions } from "@/lib/call-http";
import { errorText } from "@/lib/error-text";
import { api } from "@/convex/_generated/api";
import { getConvexClient, withRetry, workspaceScope } from "@/lib/workspace-session";
import type { LocalVoiceParticipant } from "@/lib/chat-types";

// Call presence. Clients poll and heartbeat; Convex (convex/workspaceCalls.ts) holds the state, so any instance answers.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown, status = 400) {
  return callJson({ error: errorText(error, "Request failed") }, { status: error instanceof BodyTooLarge ? 413 : status });
}

export async function GET(request: Request) {
  try {
    const { sessionToken, teamId } = workspaceScope(request);
    const rows = await withRetry(() => getConvexClient().query(api.workspaceCalls.participants, { sessionToken, teamId }));
    return callJson({ participants: rows.map(row => JSON.parse(row) as LocalVoiceParticipant), hosted: "origin-local" });
  } catch (error) {
    return errorResponse(error, 401);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request) as {
      sessionToken?: string;
      action?: "join" | "update" | "leave";
      audioEnabled?: boolean;
      videoEnabled?: boolean;
      teamId?: string;
      screenSharing?: boolean;
    };
    const { sessionToken, teamId } = workspaceScope(request, body);
    const convex = getConvexClient();
    if (body.action === "leave") {
      await withRetry(() => convex.mutation(api.workspaceCalls.leave, { sessionToken, teamId }));
      return callJson({ ok: true, hosted: "origin-local" });
    }
    const participant = await withRetry(() => convex.mutation(api.workspaceCalls.join, {
      sessionToken, teamId, audioEnabled: !!body.audioEnabled, videoEnabled: !!body.videoEnabled, screenSharing: !!body.screenSharing, heartbeat: body.action === "update",
    }));
    return callJson({ userId: participant.userId, joinedAt: participant.joinedAt, hosted: "origin-local" });
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() { return callOptions(); }
