import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { callJson, callOptions } from "@/lib/call-http";
import {
  ackLocalVoiceSignals,
  listLocalVoiceSignals,
  requireLocalWorkspace,
  sendLocalVoiceSignal,
  sessionTokenFromRequest,
  type LocalVoiceSignal,
} from "@/lib/localRealtime";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown, status = 400) {
  return callJson({ error: errorText(error, "Request failed") }, { status: error instanceof BodyTooLarge ? 413 : status });
}

export async function GET(request: Request) {
  try {
    const user = await requireLocalWorkspace(request);
    return callJson({ signals: await listLocalVoiceSignals(user), hosted: "origin-local" });
  } catch (error) {
    return errorResponse(error, 401);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request) as {
      sessionToken?: string;
      teamId?: string;
      toUserId?: Id<"users">;
      kind?: LocalVoiceSignal["kind"];
      payload?: string;
      fromJoinedAt?: number;
      toJoinedAt?: number;
    };
    const user = await requireLocalWorkspace(request, body);
    if (!body.toUserId || !body.kind) throw new Error("Signal target and kind required");
    const signal = await sendLocalVoiceSignal(user, body.toUserId, body.kind, body.payload || "", body.fromJoinedAt, body.toJoinedAt);
    return callJson({ signal, hosted: "origin-local" });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await readBoundedJson(request) as { sessionToken?: string; teamId?: string; signalIds?: string[] };
    const user = await requireLocalWorkspace(request, body);
    await ackLocalVoiceSignals(user, body.signalIds || []);
    return callJson({ ok: true, hosted: "origin-local" });
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() { return callOptions(); }
