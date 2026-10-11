/** The variable each harness MCP family reads its capability token from.
 *
 * Codex starts every MCP server from one shared environment and passes each
 * only the names in its env_vars. With one shared name, every server got the
 * last mount's token and the harness refused the others: a Codex bot with the
 * Data tools had no browser. */
export function harnessMcpTokenEnv(kind: "browser" | "computer" | "data"): string {
  return `OMB_MCP_TOKEN_${kind.toUpperCase()}`;
}
