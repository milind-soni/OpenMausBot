// What a boxed engine hears when an MCP server refuses one of its tool calls with HTTP 401. Passed through, the 401 starts the
// engine's own sign-in, which cannot succeed: the credential broker drops any Authorization the engine sends. Claude Code then
// reports only "Error dialing <address>", because the address holds a broker token and it redacts the reason. So the call is
// answered here, as a failed tool result the model reads, naming the server and what to do. Only text a model reads.

/** The request bodies kept to answer a refused call; a larger call passes the 401 through. */
export const MAX_REFUSABLE_CALL_BYTES = 1_048_576;

/** The JSON-RPC answer for a refused `tools/call`, or null when `body` is anything else and the 401 should pass through.
 * `sentCredentials`: the broker added a key or sign-in to the refused request. */
export function refusedCallAnswer(server: string, sentCredentials: boolean, body: string): string | null {
  let frame: unknown;
  try { frame = JSON.parse(body); } catch { return null; }
  const { id, method } = (frame && typeof frame === "object" && !Array.isArray(frame) ? frame : {}) as { id?: unknown; method?: unknown };
  if (method !== "tools/call" || (typeof id !== "string" && typeof id !== "number")) return null;
  const text = sentCredentials
    ? `The MCP server "${server}" refused the sign-in or key it was sent (HTTP 401), so nothing ran. Don't retry. If it signs in, call mcp_server with action sign_in and name ${server}, then end your turn; otherwise tell the person to update its key in Apps, MCP servers.`
    : `The MCP server "${server}" needs a sign-in before its tools work, and nobody has signed in (HTTP 401), so nothing ran. Don't retry. Call mcp_server with action sign_in and name ${server}, then end your turn; if you can't, tell the person to sign in to ${server} in Apps, MCP servers.`;
  return JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
}
