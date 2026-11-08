import { executionWorkerRequest } from "@/lib/execution-worker";
import { executionHttpFailure, executionResponseHeaders } from "@/lib/execution-http";
import { readBoundedJson } from "@/lib/http-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") || "")?.[1] || "";
    const body = await readBoundedJson(request, 4 * 1024 * 1024);
    return Response.json(await executionWorkerRequest(token, body), { headers: executionResponseHeaders });
  } catch (error) { return executionHttpFailure(error); }
}
