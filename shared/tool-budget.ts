/** The most tools one Chat Completions request may carry: OpenAI-compatible endpoints refuse more than 128. */
export const CHAT_TOOL_LIMIT = 128;

/** How one bot's last chat-engine turn spent the model's tool limit. */
export interface ToolBudget {
  limit: number;
  /** Tools the model was handed directly, the tool search's own and the built-ins' included. */
  listed: number;
  /** The bot's configured MCP servers, in turn order. `direct: false` is a server reached through the tool search. */
  servers: Array<{ name: string; tools: number; direct: boolean }>;
}

/** What one server's tool count alone does to a chat-engine turn: past the limit it can only be searched, and from half of
 * it on it pushes other servers into the search. */
export function chatToolBudgetFit(tools: number, limit: number = CHAT_TOOL_LIMIT): "fits" | "crowds" | "exceeds" {
  if (tools >= limit) return "exceeds";
  return tools * 2 >= limit ? "crowds" : "fits";
}
