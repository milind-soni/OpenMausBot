import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `<cwd>/.mcp.json`, forwarded verbatim because --strict-mcp-config stops the CLI reading it.
 * A malformed file is ignored. */
export function projectMcpServers(cwd: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
  } catch {
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    if (server && typeof server === "object" && !Array.isArray(server)) out[name] = server;
  }
  return out;
}
