import { oauthHeaders, protectedResourceMetadata } from "@/lib/mcp-oauth";

// RFC 9728 protected resource metadata for /api/mcp (here and at the path-suffixed URL the 401 challenge names).
export const runtime = "nodejs";
export async function GET() {
  return Response.json(protectedResourceMetadata(), { headers: oauthHeaders });
}
export { OPTIONS } from "../../oauth/register/route";
