import { executionRunnerResource } from "@/lib/execution-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ resource: string[] }> }) {
  try { return await executionRunnerResource((await context.params).resource); }
  catch { return Response.json({ error: "Signed runner release is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
