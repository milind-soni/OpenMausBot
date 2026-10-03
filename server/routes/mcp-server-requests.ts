// POST /api/internal/mcp-server-requests: propose_mcp_server from a bot's
// agents proxy. Runs from INTERNAL_ROUTES, so the bot capability is already
// checked and `readBody` already refuses a body naming another bot or
// conversation. The proposal itself is validated by McpServerRequestService.
import { z } from "zod";
import type { McpServerRequestService } from "../mcp-server-requests.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface McpServerRequestRouteDeps {
  requests: Pick<McpServerRequestService, "submit">;
  bot(id: string): { id: string; name: string; color: string } | null | undefined;
  /** A refusal sentence unless the bot is an active Chief of Staff. */
  proposerRefusal(botId: string): string | null;
  /** The conversation the bot is posting from, or null when it is not the bot's. */
  sourceConversation(botId: string, threadId: string): { group: boolean } | null;
  /** The decision log row for a shown card or a Full Access apply. */
  recordDecision(row: { threadId: string; requestId: string; botId: string; botName: string; summary: string; applied: boolean }): void;
}

const body = z.object({
  fromBotId: z.string().min(1).max(128),
  fromThreadId: z.string().min(1).max(128),
  proposal: z.unknown(),
}).strict();

export function createMcpServerRequestRoutes(deps: McpServerRequestRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (method !== "POST" || path !== "/api/internal/mcp-server-requests") return PASS;
    const parsed = body.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "invalid MCP server proposal" });
    const { fromBotId, fromThreadId, proposal } = parsed.data;
    const from = deps.bot(fromBotId);
    if (!from) return json(res, 403, { error: "unknown sender" });
    // The catalog only shows this tool to Chiefs; that is presentation.
    // This is the check.
    const refusal = deps.proposerRefusal(from.id);
    if (refusal) return json(res, 403, { error: refusal });
    const source = deps.sourceConversation(from.id, fromThreadId);
    if (!source) return json(res, 403, { error: "source conversation does not belong to sender" });
    const proposed = deps.requests.submit({
      botId: from.id,
      threadId: fromThreadId,
      request: proposal,
      from: source.group ? { botId: from.id, name: from.name, color: from.color } : undefined,
    });
    // The card detail names env and header keys, never their values.
    deps.recordDecision({
      threadId: fromThreadId, requestId: proposed.requestId, botId: from.id, botName: from.name,
      summary: proposed.detail, applied: proposed.state === "applied",
    });
    return json(res, 201, proposed);
  };
}
