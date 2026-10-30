/** The command, arguments and environment that start the computer-control server for lending, from either shape the
 * local driver reports: macOS and Windows name `mcpCommand`/`mcpArgs`/`mcpEnv`; a ready Linux connection nests the
 * verified invocation in `mcp` and the environment it was verified with in `commandEnv`. Null when there is none. */
export function sharedCuaConnection(connection) {
  if (connection?.mcpCommand) return Array.isArray(connection.mcpArgs) ? connection : null;
  if (connection?.status !== "ready" || typeof connection.mcp?.command !== "string" || !connection.mcp.command || !Array.isArray(connection.mcp.args)) return null;
  return { mcpCommand: connection.mcp.command, mcpArgs: connection.mcp.args, mcpEnv: connection.mcp.env ?? connection.commandEnv };
}
