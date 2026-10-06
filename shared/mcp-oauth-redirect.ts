// The loopback address a pre-registered OAuth app must allow. It is a pure
// function of the MCP server URL so the same app can be reused on every
// sign-in, and so the settings screen can show the URI before the server
// is saved.

export const MCP_OAUTH_CALLBACK_PATH = "/mcp-oauth/callback";

/** A port derived from the server URL, inside the ephemeral range the
 * loopback listener prefers. */
export function mcpOAuthRedirectPort(url: string): number {
  let hash = 0x811c9dc5;
  for (const char of url) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 20_000 + (hash % 20_000);
}

/** The redirect URI a sign-in for this server uses. */
export function mcpOAuthRedirectUri(url: string): string {
  return `http://127.0.0.1:${mcpOAuthRedirectPort(url)}${MCP_OAUTH_CALLBACK_PATH}`;
}
