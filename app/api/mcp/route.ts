import { mcpEndpoint } from "@/lib/mcp-endpoint";

// Remote MCP server (lib/mcp-endpoint.ts): every tool the bearer allows. /api/mcp/readonly serves the read tools only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const endpoint = mcpEndpoint(false);
export const GET = endpoint.GET, POST = endpoint.POST, DELETE = endpoint.DELETE, OPTIONS = endpoint.OPTIONS;
