import { after } from "next/server";
import { acceptExecutionControllerTick, executionControllerBillingContext, reconcileExecution } from "@/lib/execution-controller";
import { executionHttpFailure, executionResponseHeaders } from "@/lib/execution-http";
import { readBoundedJson } from "@/lib/http-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;
export async function POST(request: Request) {
  try {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") || "")?.[1] || "";
    const body = await readBoundedJson(request, 150000);
    if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 && "op" in body && body.op === "billingContext") {
      return Response.json({ boxdBilling: executionControllerBillingContext(token) }, { headers: executionResponseHeaders });
    }
    const teamId = acceptExecutionControllerTick(token, body);
    after(async () => {
      try { await reconcileExecution(teamId); }
      catch { console.error("Execution reconciliation failed; durable run and cloud journals remain authoritative"); }
    });
    return Response.json({ accepted: true }, { headers: executionResponseHeaders });
  } catch (error) { return executionHttpFailure(error); }
}
