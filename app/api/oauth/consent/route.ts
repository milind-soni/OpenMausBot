import { ConvexError } from "convex/values";
import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getConvexClient, requireLocalUser, sessionTokenFromRequest } from "@/lib/workspace-session";
import { limitAction } from "@/lib/server-store";
import { authorizationError, issueMcpCode, OAuthError, validateMcpAuthorization } from "@/lib/mcp-oauth";
import { originUrl } from "@/lib/integration-bridge";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

function describe(redirect: string) {
  const url = new URL(redirect);
  return url.protocol === "http:" ? "This computer" : url.hostname;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const auth = await validateMcpAuthorization(params);
    return Response.json({ name: auth.name, domain: describe(auth.redirect), write: auth.scope.split(" ").includes("origin:write") }, { headers: noStore });
  } catch (error) {
    // Never redirect from here: anyone can register a client, so an automatic redirect to its URI would make this
    // page an open redirector (RFC 9700 section 4.11.2). The error is shown on Origin instead.
    const detail = error instanceof OAuthError && error.code !== "invalid_client" ? ` (${error.message})` : "";
    return Response.json({ error: `Invalid connection request${detail}. Start again from your app.` }, { status: 400, headers: noStore });
  }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== originUrl()) throw new Error("Invalid origin");
    const body = await readBoundedJson(request);
    if (typeof body.query !== "string" || body.query.length > 12000) throw new Error("Invalid request");
    const auth = await validateMcpAuthorization(new URLSearchParams(body.query));
    const sessionToken = sessionTokenFromRequest(request);
    const user = await requireLocalUser(sessionToken);
    await limitAction(`mcp-consent:${user._id}`, 10, 60000);
    if (body.allow === false) return Response.json({ url: authorizationError(auth, "access_denied") }, { headers: noStore });
    if (body.allow !== true || typeof body.teamId !== "string") throw new Error("Choose a workspace");
    const write = body.write === true && auth.scope.split(" ").includes("origin:write");
    const convex = getConvexClient();
    const grant = await convex.mutation(api.mcp.createOAuthGrant, { sessionToken, teamId: body.teamId as Id<"teams">, name: `${auth.name} (${describe(auth.redirect)})`.slice(0, 120), write });
    // Abandoned consents (codes that expire unused) are revoked by a Convex cron, so they leave Settings > Agents.
    try { return Response.json({ url: await issueMcpCode(auth, grant.token, grant.expiresAt, write) }, { headers: noStore }); }
    catch (error) { await convex.mutation(api.mcp.revokeOwnToken, { token: grant.token }).catch(() => {}); throw error; }
  } catch (error) {
    const message = error instanceof ConvexError && typeof error.data === "string" ? error.data : "Could not connect. Check your workspace access and try again.";
    return Response.json({ error: message }, { status: error instanceof BodyTooLarge ? 413 : 400, headers: noStore });
  }
}
