// A Team Cloud member's own connected apps: mounted beside the team's `composio` server, only in that member's own turns in
// their private chat. Everything that reads a `composio` tool as an app tool reads this one the same way.
export const OWN_APPS_SERVER = "own_apps";

/** The two servers whose tools are connected-app (Composio) tools. */
export const isConnectedAppsServer = (server: string): boolean => server === "composio" || server === OWN_APPS_SERVER;
