/** Whop's official hosted MCP uses browser OAuth, not a pasted API key. */
export const WHOP_MCP_URL = "https://mcp.whop.com/mcp";

export function isWhopServer(server: { url?: string; type?: string }): boolean {
  if (server.type !== "http" || !server.url) return false;
  try {
    const url = new URL(server.url);
    return url.origin === "https://mcp.whop.com" && /^\/mcp\/?$/.test(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

/** Never overwrite an unrelated server that happens to be called whop. */
export function whopServerName(servers: Array<{ name: string }>): string {
  const names = new Set(servers.map((server) => server.name));
  let name = "whop";
  for (let suffix = 2; names.has(name); suffix++) name = `whop-${suffix}`;
  return name;
}
