export function botPermissionSnapshot(bot: {
  composio?: unknown;
  connectorScopes?: unknown;
  connectorTools?: unknown;
  mcpServers?: unknown;
}) {
  return {
    composio: bot.composio ?? null,
    connectorScopes: bot.connectorScopes ?? null,
    connectorTools: bot.connectorTools ?? null,
    mcpServers: bot.mcpServers ?? null,
  };
}
