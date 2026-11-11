import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { callJson, callOptions } from "@/lib/call-http";
import { api } from "@/convex/_generated/api";
import { errorText } from "@/lib/error-text";
import { getConvexClient, withRetry, workspaceScope } from "@/lib/workspace-session";
import type { LocalVoiceSignal } from "@/lib/chat-types";

// WebRTC signaling by polling: offers, answers and ICE candidates queue in Convex until the recipient acknowledges them.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown, status = 400) {
  return callJson({ error: errorText(error, "Request failed") }, { status: error instanceof BodyTooLarge ? 413 : status });
}

export async function GET(request: Request) {
  try {
    const { sessionToken, teamId } = workspaceScope(request);
    const rows = await withRetry(() => getConvexClient().query(api.workspaceCalls.signals, { sessionToken, teamId }));
    return callJson({ signals: rows.map(row => JSON.parse(row) as LocalVoiceSignal), hosted: "origin-local" });
  } catch (error) {
    return errorResponse(error, 401);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request) as {
      sessionToken?: string;
      teamId?: string;
      toUserId?: string;
      kind?: LocalVoiceSignal["kind"];
      payload?: string;
      fromJoinedAt?: number;
      toJoinedAt?: number;
    };
    const { sessionToken, teamId } = workspaceScope(request, body);
    if (!body.toUserId || !body.kind) throw new Error("Signal target and kind required");
    const signal = await getConvexClient().mutation(api.workspaceCalls.signal, {
      sessionToken, teamId, toUserId: String(body.toUserId), kind: String(body.kind), payload: typeof body.payload === "string" ? body.payload : "",
      ...(typeof body.fromJoinedAt === "number" ? { fromJoinedAt: body.fromJoinedAt } : {}),
      ...(typeof body.toJoinedAt === "number" ? { toJoinedAt: body.toJoinedAt } : {}),
    });
    return callJson({ signal: signal === null ? null : JSON.parse(signal) as LocalVoiceSignal, hosted: "origin-local" });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await readBoundedJson(request) as { sessionToken?: string; teamId?: string; signalIds?: string[] };
    const { sessionToken, teamId } = workspaceScope(request, body);
    const signalIds = Array.isArray(body.signalIds) ? body.signalIds.slice(0, 120).map(String) : [];
    await getConvexClient().mutation(api.workspaceCalls.ack, { sessionToken, teamId, signalIds });
    return callJson({ ok: true, hosted: "origin-local" });
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() { return callOptions(); }
