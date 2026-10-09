/** What the server uses while `mcp.callTimeoutMinutes` is unset — and all a
 * server older than the setting can do (server/config.ts). */
export const DEFAULT_MCP_CALL_TIMEOUT_MINUTES = 10;
export const MIN_MCP_CALL_TIMEOUT_MINUTES = 1;
export const MAX_MCP_CALL_TIMEOUT_MINUTES = 60;
export const MCP_CALL_TIMEOUT_INPUT_ERROR = "Enter a whole number from 1 to 60.";

export type McpCallTimeoutInput =
  | { ok: true; minutes: number }
  | { ok: false; error: string };

export function parseMcpCallTimeoutMinutes(value: string): McpCallTimeoutInput {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: MCP_CALL_TIMEOUT_INPUT_ERROR };
  const minutes = Number(trimmed);
  if (minutes < MIN_MCP_CALL_TIMEOUT_MINUTES || minutes > MAX_MCP_CALL_TIMEOUT_MINUTES) {
    return { ok: false, error: MCP_CALL_TIMEOUT_INPUT_ERROR };
  }
  return { ok: true, minutes };
}

/** The per-call ceiling a server's config reports. A server older than the
 * setting sends no `mcp` section at all (and a remote server or Cloud can be
 * older than this app), so every read goes through here, never
 * `config.mcp.callTimeoutMinutes` directly. */
export function mcpCallTimeoutMinutes(config: { mcp?: { callTimeoutMinutes?: number } } | null | undefined): number {
  return config?.mcp?.callTimeoutMinutes ?? DEFAULT_MCP_CALL_TIMEOUT_MINUTES;
}
