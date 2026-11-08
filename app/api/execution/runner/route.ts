import { executionRunnerBundle } from "@/lib/execution-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const bundle = await executionRunnerBundle();
    return Response.json(bundle, { headers: { "Cache-Control": "public, max-age=60", ETag: `"${bundle.sha256}"` } });
  } catch { return Response.json({ error: "Reviewed runner distribution is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
