import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport, type AuthInfo } from "@modelcontextprotocol/server";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "./workspace-session";
import { originUrl } from "./integration-bridge";
import { MCP_INSTRUCTIONS, mcpTool, type McpToolName } from "./mcp-tools";

// Tool definitions for the remote MCP server (app/api/mcp). The Convex functions in convex/mcp.ts enforce access.

const text = (value: string) => {
  const body = JSON.parse(value);
  const origin = originUrl();
  const absolute = (node: unknown): unknown => Array.isArray(node) ? node.map(absolute)
    : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "url" && typeof v === "string" && v.startsWith("/") ? origin + v : absolute(v)]))
    : node;
  return { content: [{ type: "text" as const, text: JSON.stringify(absolute(body)) }] };
};
async function run(fn: () => Promise<string>) {
  try { return text(await fn()); }
  catch (error) { return { content: [{ type: "text" as const, text: error instanceof ConvexError && typeof error.data === "string" ? error.data : "Request failed" }], isError: true }; }
}

const ref = (what: string) => z.string().min(1).max(200).describe(what);
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const change = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const priority = z.enum(["low", "medium", "high"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const labels = z.array(z.string().min(1).max(32)).max(20);

export function originMcpServer(token: string, write: boolean) {
  const convex = getConvexClient();
  const server = new McpServer({ name: "origin", title: "Origin", version: "1.1.0" }, {
    // The tool list is fixed for a token, so clients need no subscriptions/listen stream for it.
    capabilities: { tools: { listChanged: false } },
    instructions: MCP_INSTRUCTIONS,
  });
  const meta = (name: McpToolName) => { const { title, description } = mcpTool(name); return { title, description }; };
  server.registerTool("get_workspace", { ...meta("get_workspace"), inputSchema: z.object({}), annotations: read },
    () => run(() => convex.query(api.mcp.workspace, { token })));
  server.registerTool("list_projects", { ...meta("list_projects"), inputSchema: z.object({ includeInactive: z.boolean().optional().describe("Include paused and archived projects") }), annotations: read },
    a => run(() => convex.query(api.mcp.projects, { token, ...a })));
  server.registerTool("list_issues", {
    ...meta("list_issues"),
    inputSchema: z.object({
      project: ref("Project id or name").optional(), column: ref("Column name or id, e.g. \"In progress\"").optional(),
      status: z.enum(["open", "completed", "all"]).optional().describe("Default: open"),
      assignee: ref("\"me\", \"unassigned\", an email, @username or name").optional(), label: ref("Label").optional(), text: ref("Text in title or description, or an issue key").optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default: 25"), cursor: z.string().max(20).optional(),
    }), annotations: read,
  }, a => run(() => convex.query(api.mcp.issues, { token, ...a })));
  server.registerTool("get_issue", { ...meta("get_issue"), inputSchema: z.object({ issueId: ref("Issue id or key, e.g. ORI-AB12") }), annotations: read },
    a => run(() => convex.query(api.mcp.issue, { token, ...a })));
  server.registerTool("get_inbox", { ...meta("get_inbox"), inputSchema: z.object({}), annotations: read },
    () => run(() => convex.query(api.mcp.inbox, { token })));
  server.registerTool("list_members", { ...meta("list_members"), inputSchema: z.object({ project: ref("Project id or name").optional() }), annotations: read },
    a => run(() => convex.query(api.mcp.members, { token, ...a })));
  if (!write) return server;
  server.registerTool("create_issue", {
    ...meta("create_issue"),
    inputSchema: z.object({
      project: ref("Project id or name"), title: z.string().min(1).max(250), description: z.string().max(60000).optional().describe("Markdown"),
      column: ref("Column name or id").optional(), priority: priority.optional().describe("Default: medium"),
      assignee: ref("Email, @username, \"me\" (default) or \"none\"").optional(), dueDate: date.optional().describe("YYYY-MM-DD; omit for no due date"),
      labels: labels.optional().describe("Label names; existing project labels are matched case-insensitively"),
    }), annotations: change,
  }, a => run(() => convex.mutation(api.mcp.createIssue, { token, ...a })));
  server.registerTool("update_issue", {
    ...meta("update_issue"),
    inputSchema: z.object({ issueId: ref("Issue id or key"), title: z.string().min(1).max(250).optional(), description: z.string().max(60000).optional(), priority: priority.optional(), assignee: ref("Email, @username, \"me\" or \"none\"").optional(), dueDate: date.or(z.literal("none")).optional().describe("YYYY-MM-DD or \"none\""),
      labels: labels.optional().describe("The issue's full set of labels; [] removes all") }),
    annotations: { ...change, idempotentHint: true },
  }, a => run(() => convex.mutation(api.mcp.updateIssue, { token, ...a })));
  server.registerTool("move_issue", {
    ...meta("move_issue"),
    inputSchema: z.object({
      issueId: ref("Issue id or key"), column: ref("Target column name or id").optional(),
      before: ref("Place above this issue id (same column)").optional(), position: z.enum(["top", "bottom"]).optional().describe("Default: bottom"),
      completed: z.boolean().optional().describe("true completes, false reopens"),
    }), annotations: { ...change, idempotentHint: true },
  }, a => run(() => convex.mutation(api.mcp.moveIssue, { token, ...a })));
  server.registerTool("add_comment", {
    ...meta("add_comment"),
    inputSchema: z.object({ issueId: ref("Issue id or key"), body: z.string().min(1).max(8000).describe("Markdown") }), annotations: change,
  }, a => run(() => convex.mutation(api.mcp.addComment, { token, ...a })));
  return server;
}

/** What app/api/mcp verified about the bearer: the Convex connector token and whether it may write. */
export type McpAuth = { token: string; write: boolean; key: string };

// Protocol revision 2026-07-28: server/discover and the per-request _meta envelope, one fresh server per request.
const modern = createMcpHandler(({ authInfo }) => {
  if (!authInfo) throw new Error("Unauthenticated MCP request");
  return originMcpServer(authInfo.token, authInfo.extra?.write === true);
}, { legacy: "reject" });

/**
 * Serves one Streamable HTTP POST without sessions. 2026-07-28 requests go to the SDK's modern handler; 2025-era
 * traffic (initialize handshake, JSON-RPC batches) keeps the stateless JSON-response transport, so older clients get
 * the same plain JSON answers as before.
 */
export async function serveMcp(request: Request, auth: McpAuth, parsedBody: unknown) {
  if (!await isLegacyRequest(request, parsedBody)) {
    const authInfo: AuthInfo = { token: auth.token, clientId: auth.key, scopes: auth.write ? ["read", "write"] : ["read"], extra: { write: auth.write } };
    return modern.fetch(request, { authInfo, parsedBody });
  }
  const server = originMcpServer(auth.token, auth.write);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    return new Response(response.body ? await response.text() : null, { status: response.status, headers: response.headers });
  } finally { await server.close(); }
}
