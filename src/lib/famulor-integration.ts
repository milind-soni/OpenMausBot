/** Famulor's official hosted MCP uses browser OAuth, not a pasted API key. */
export const FAMULOR_MCP_URL = "https://app.famulor.io/mcp";

export function isFamulorServer(server: { url?: string; type?: string }): boolean {
  if (server.type !== "http" || !server.url) return false;
  try {
    const url = new URL(server.url);
    return url.origin === "https://app.famulor.io" && /^\/mcp\/?$/.test(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

export function famulorServerName(servers: Array<{ name: string }>): string {
  const names = new Set(servers.map((server) => server.name));
  let name = "famulor";
  for (let suffix = 2; names.has(name); suffix++) name = `famulor-${suffix}`;
  return name;
}
