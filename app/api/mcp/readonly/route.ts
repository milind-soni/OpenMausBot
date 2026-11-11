import { mcpEndpoint } from "@/lib/mcp-endpoint";

// Read-only MCP endpoint (Linear's /mcp/readonly): the read tools only, for any valid bearer.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const endpoint = mcpEndpoint(true);
export const GET = endpoint.GET, POST = endpoint.POST, DELETE = endpoint.DELETE, OPTIONS = endpoint.OPTIONS;
