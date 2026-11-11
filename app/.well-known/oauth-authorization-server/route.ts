import { mcpScopes, oauthHeaders } from "@/lib/mcp-oauth";
import { originUrl } from "@/lib/integration-bridge";

// RFC 8414 authorization server metadata. Clients register (RFC 7591) or present an HTTPS client_id that serves
// their metadata document; every client is public and must use PKCE S256.
export const runtime = "nodejs";
export async function GET() {
  const origin = originUrl();
  return Response.json({
    issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"], scopes_supported: mcpScopes, authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  }, { headers: oauthHeaders });
}
export { OPTIONS } from "../../oauth/register/route";
