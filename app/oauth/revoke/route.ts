import { api } from "@/convex/_generated/api";
import { revokeMcpToken, oauthHeaders, requestClientId } from "@/lib/mcp-oauth";
import { getConvexClient } from "@/lib/workspace-session";
import { TooManyRequests } from "@/lib/server-store";
import { readBoundedText } from "@/lib/http-body";
import { isPatFormat, PAT_PREFIX } from "@/lib/mcp-tokens";
import { limitOAuthEndpoint } from "@/lib/mcp-rate-limit";

export const runtime = "nodejs";
// RFC 7009: always answer 200 for unknown tokens.
export async function POST(request: Request) {
  try {
    const params = new URLSearchParams(await readBoundedText(request, 20000));
    const clientId = requestClientId(params, request.headers.get("authorization"));
    await limitOAuthEndpoint(request, "mcp-revoke", clientId, 60);
    const value = params.get("token") || "";
    if (value.startsWith(PAT_PREFIX)) { if (isPatFormat(value)) await getConvexClient().mutation(api.mcp.revokeOwnToken, { token: value }); }
    else await revokeMcpToken(value, clientId);
    return new Response(null, { status: 200, headers: oauthHeaders });
  } catch (error) {
    if (error instanceof TooManyRequests) return Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { ...oauthHeaders, "Retry-After": "60" } });
    return new Response(null, { status: 400, headers: oauthHeaders });
  }
}
export { OPTIONS } from "../register/route";
