import { mcpReadonlyResource, oauthHeaders, protectedResourceMetadata } from "@/lib/mcp-oauth";

// RFC 9728 metadata for the read-only endpoint, /api/mcp/readonly.
export const runtime = "nodejs";
export async function GET() {
  return Response.json(protectedResourceMetadata(mcpReadonlyResource()), { headers: oauthHeaders });
}
export { OPTIONS } from "../../../../../oauth/register/route";
