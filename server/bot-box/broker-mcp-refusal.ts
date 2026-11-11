// What a boxed engine hears when an MCP server refuses one of its tool calls with HTTP 401. Passed through, the 401 starts the
// engine's own sign-in, which cannot succeed: the credential broker drops any Authorization the engine sends. Claude Code then
// reports only "Error dialing <address>", because the address holds a broker token and it redacts the reason. So the call is
// answered here, as a failed tool result the model reads, naming the server and what to do. Only text a model reads.
import type { McpServerApp } from "../mcp-server-app.ts";

/** The request bodies kept to answer a refused call; a larger call passes the 401 through. */
export const MAX_REFUSABLE_CALL_BYTES = 1_048_576;

/** What the bot hears when `server` wants a sign-in nobody gave it. `app`: the connected app it stands for, when this turn can
 * use that app instead. */
function signInWantedText(server: string, app?: McpServerApp): string {
  const refused = `The MCP server "${server}" needs a sign-in before its tools work, and nobody has signed in (HTTP 401), so nothing ran. Don't retry.`;
  if (app?.connected) return `${refused} ${app.label} is already connected as a connected app here, so use the connected app's ${app.label} tools instead of this MCP server. Don't show a connect card for it.`;
  const signIn = `mcp_server with action sign_in and name ${server}, then end your turn; if you can't, tell the person to sign in to ${server} in Apps, MCP servers.`;
  if (!app) return `${refused} Call ${signIn}`;
  return `${refused} ${app.label} can be connected in one step with its connect card. Call COMPOSIO_MANAGE_CONNECTIONS with toolkits ${JSON.stringify([app.slug])} to show the card in this chat, then end your turn. Once it is connected, use the connected app's ${app.label} tools instead of this MCP server. If the card can't be shown, call ${signIn}`;
}

/** The JSON-RPC answer for a refused `tools/call`, or null when `body` is anything else and the 401 should pass through.
 * `sentCredentials`: the broker added a key or sign-in to the refused request. */
export function refusedCallAnswer(server: string, sentCredentials: boolean, body: string, app?: McpServerApp): string | null {
  let frame: unknown;
  try { frame = JSON.parse(body); } catch { return null; }
  const { id, method } = (frame && typeof frame === "object" && !Array.isArray(frame) ? frame : {}) as { id?: unknown; method?: unknown };
  if (method !== "tools/call" || (typeof id !== "string" && typeof id !== "number")) return null;
  const text = sentCredentials
    ? `The MCP server "${server}" refused the sign-in or key it was sent (HTTP 401), so nothing ran. Don't retry. If it signs in, call mcp_server with action sign_in and name ${server}, then end your turn; otherwise tell the person to update its key in Apps, MCP servers.`
    : signInWantedText(server, app);
  return JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
}
