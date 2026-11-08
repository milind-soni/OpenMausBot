import { z } from "zod";
import { executionAction, executionRunDetail, executionSnapshot } from "@/lib/execution-browser";
import { browserExecutionPrincipal, executionId } from "@/lib/execution-common";
import { executionHttpFailure, executionResponseHeaders } from "@/lib/execution-http";
import { readBoundedJson } from "@/lib/http-body";
import { limitLocalAction, sessionTokenFromRequest } from "@/lib/localRealtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const scopeSchema = z.object({ teamId: executionId, projectId: executionId.optional(), taskId: executionId.optional() });

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const scope = scopeSchema.parse(Object.fromEntries(query));
    const principal = await browserExecutionPrincipal(sessionTokenFromRequest(request), scope.teamId, scope.projectId, scope.taskId);
    const runId = query.get("runId");
    const cursor = z.coerce.number().int().min(0).parse(query.get("cursor") || 0);
    return Response.json(runId ? executionRunDetail(principal, executionId.parse(runId), cursor) : executionSnapshot(principal), { headers: executionResponseHeaders });
  } catch (error) { return executionHttpFailure(error); }
}
export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request, 150000);
    const scope = scopeSchema.parse(body);
    const principal = await browserExecutionPrincipal(sessionTokenFromRequest(request), scope.teamId, scope.projectId, scope.taskId);
    limitLocalAction(`execution:${principal.userId}`, 100, 60000);
    return Response.json(await executionAction(principal, body), { headers: executionResponseHeaders });
  } catch (error) { return executionHttpFailure(error); }
}
