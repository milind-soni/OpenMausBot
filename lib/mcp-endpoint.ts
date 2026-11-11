import { createHash } from "node:crypto";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "./workspace-session";
import { BodyTooLarge, readBoundedJson } from "./http-body";
import { mcpReadonlyResource, mcpResource, mcpResourceMetadata, mcpScopes, resolveMcpToken } from "./mcp-oauth";
import { isPatFormat, PAT_PREFIX } from "./mcp-tokens";
import { mcpAuthBlocked, recordMcpAuthFailure } from "./mcp-rate-limit";
import { limitAction, limitReached } from "./server-store";
import { serveMcp } from "./mcp-server";

// Remote MCP server, Streamable HTTP without sessions: protocol revision 2026-07-28 (server/discover, per-request
// _meta envelope) and the 2025 revisions (initialize handshake, JSON-RPC batches) on the same POST endpoint. Auth is a
// Bearer token: an OAuth access token from /oauth/token or a personal access token. app/api/mcp serves every tool the
// token allows; app/api/mcp/readonly serves the read tools only, whatever the token allows.
// Requests never rely on cookies, so a cross-origin page cannot use the user's credentials.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version" };

type Auth = { token: string; write: boolean; key: string };
const KNOWN_PAT_TTL = 10 * 60000;
const tooMany = () => Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests" } }, { status: 429, headers: { ...cors, "Retry-After": "60" } });

export function mcpEndpoint(readonly: boolean) {
  const resource = () => readonly ? mcpReadonlyResource() : mcpResource();

  function unauthorized(error = "invalid_token") {
    const scope = readonly ? "origin:read" : mcpScopes.join(" ");
    const challenge = `Bearer resource_metadata="${mcpResourceMetadata(resource())}", scope="${scope}"${error ? `, error="${error}"` : ""}`;
    return Response.json({ error }, { status: 401, headers: { ...cors, "WWW-Authenticate": challenge, "Cache-Control": "no-store" } });
  }

  /**
   * Resolves the bearer without calling Convex for anything that cannot be valid: malformed personal access tokens
   * and unknown OAuth tokens fail locally. Failures are rate limited before any Convex call.
   */
  async function authenticate(request: Request): Promise<Auth | Response> {
    const header = request.headers.get("authorization") || "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!bearer) return unauthorized("");
    const fail = async () => { await recordMcpAuthFailure(request); return unauthorized(); };
    let resolved: { connectorToken: string; write: boolean; key: string };
    if (bearer.startsWith(PAT_PREFIX)) {
      if (!isPatFormat(bearer)) return fail();
      const key = createHash("sha256").update(bearer).digest("hex").slice(0, 24);
      // A PAT verified within the last ten minutes skips the failed-authentication gate, so a flood of bad tokens
      // cannot lock it out. The marker is a shared rate-limit window, so every instance sees it.
      if (!await limitReached(`mcp-known-pat:${key}`, 1) && await mcpAuthBlocked(request)) return tooMany();
      resolved = { connectorToken: bearer, write: true, key };
    } else {
      // OAuth tokens resolve from their hash; only valid ones reach the connector check.
      try { const grant = await resolveMcpToken(bearer, resource()); resolved = { connectorToken: grant.connectorToken, write: grant.write, key: grant.grantId }; }
      catch { return await mcpAuthBlocked(request) ? tooMany() : fail(); }
    }
    try { await limitAction(`mcp:${resolved.key}`, 240, 60000); } catch { return tooMany(); }
    try {
      const access = await getConvexClient().query(api.connectors.verify, { token: resolved.connectorToken });
      if (bearer.startsWith(PAT_PREFIX)) await limitAction(`mcp-known-pat:${resolved.key}`, 1, KNOWN_PAT_TTL).catch(() => {});
      return { token: resolved.connectorToken, write: !readonly && resolved.write && access.write, key: resolved.key };
    } catch {
      return fail();
    }
  }

  async function POST(request: Request) {
    const auth = await authenticate(request);
    if (auth instanceof Response) return auth;
    let parsedBody: unknown;
    try { parsedBody = await readBoundedJson(request, 200000); }
    catch (error) { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof BodyTooLarge ? "Request too large" : "Parse error" } }, { status: error instanceof BodyTooLarge ? 413 : 400, headers: cors }); }
    const response = await serveMcp(request, auth, parsedBody);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  // No server-initiated stream: GET and DELETE are not offered (Streamable HTTP allows 405).
  async function GET(request: Request) {
    const auth = await authenticate(request);
    if (auth instanceof Response) return auth;
    return new Response(null, { status: 405, headers: { ...cors, Allow: "POST" } });
  }
  async function DELETE() { return new Response(null, { status: 405, headers: { ...cors, Allow: "POST" } }); }
  async function OPTIONS() {
    return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID", "Access-Control-Max-Age": "86400" } });
  }
  return { GET, POST, DELETE, OPTIONS };
}
