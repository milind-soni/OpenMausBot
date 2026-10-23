/** A bot on My Cloud links to `/?connect=<id>` for a connection that needs the person there: an MCP server's sign-in
 * opens the MCP servers, where its Sign in is; HighLevel opens the apps. The Admin's Team admin pages link a team's
 * admins to `/?connect=mcp`, `keys` (the keys in Settings) or `ai` (the engines in Settings). It only opens the page; it
 * never signs in by itself. Null for any other address. */
export function takeConnectRequest(href: string): ({ rest: string } & ({ surface: "mcp" | "apps" } | { section: "connections" | "engines" })) | null {
  const url = new URL(href);
  const id = url.searchParams.get("connect");
  if (id === null) return null;
  url.searchParams.delete("connect");
  const rest = `${url.pathname}${url.search}${url.hash}`;
  if (id === "keys" || id === "ai") return { rest, section: id === "keys" ? "connections" : "engines" };
  return { rest, surface: /^mcp(?::[a-z][a-z0-9_-]{0,31})?$/u.test(id) ? "mcp" : "apps" };
}
