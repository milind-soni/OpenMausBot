import { InvalidClientMetadata, oauthHeaders, registerMcpClient, RegistrationLimited } from "@/lib/mcp-oauth";
import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { clientAddress } from "@/lib/client-address";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const address = clientAddress(request);
  try {
    const body = await readBoundedJson(request, 20000);
    // New clients only: per client address behind a trusted proxy, otherwise one bucket for this endpoint.
    // Unused clients are deleted after a day, so neither can fill the table for long.
    const client = await registerMcpClient(body, address ? { key: `mcp-register:ip:${address}`, maximum: 15 } : { key: "mcp-register", maximum: 60 });
    return Response.json(client, { status: 201, headers: oauthHeaders });
  } catch (error) {
    if (error instanceof RegistrationLimited) return Response.json({ error: "temporarily_unavailable", error_description: "Too many registrations. Try again shortly." }, { status: 429, headers: { ...oauthHeaders, "Retry-After": "60" } });
    if (error instanceof BodyTooLarge) return Response.json({ error: "invalid_client_metadata", error_description: "Request too large" }, { status: 413, headers: oauthHeaders });
    const known = error instanceof InvalidClientMetadata;
    return Response.json({ error: known ? error.code : "invalid_client_metadata", error_description: known ? error.message : "Invalid client metadata" }, { status: 400, headers: oauthHeaders });
  }
}
export async function OPTIONS() { return new Response(null, { status: 204, headers: { ...oauthHeaders, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version" } }); }
