// User-configured MCP servers from config.json: validate-with-skip so one
// bad entry never takes the fleet down, and each skip is logged once.
import type { McpServerSpec } from "../contracts.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "../mcp-registry.ts";
import type { AppConfig } from "./schema.ts";

// ── user-configured MCP servers ─────────────────────────────────────────
// config.json: { "mcpServers": { "notes": { "command": "npx", "args":
// ["-y", "@x/notes-mcp"], "env": { "NOTES_TOKEN": "…" } },
//                                "docs": { "type": "http", "url": "https://…/mcp",
// "headers": { "Authorization": "Bearer …" } } } }
// Validate-with-skip so one bad entry never takes the fleet down, and each
// skip is logged once with a sentence that teaches.

export type CustomMcpServer = McpServerSpec;

const reportedMcpSkips = new Set<string>();
function skipMcpEntry(name: string, why: string): void {
  const key = `${name}: ${why}`;
  if (reportedMcpSkips.has(key)) return;
  reportedMcpSkips.add(key);
  console.error(`mcpServers.${JSON.stringify(name)} skipped — ${why}`);
}

/** The validated, normalized custom servers from config — or {}. */
export function customMcpServers(cfg: AppConfig, only?: string[]): Record<string, CustomMcpServer> {
  const out: Record<string, CustomMcpServer> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    // a bot with its own list gets exactly those names; a bot without one
    // keeps getting every enabled server, as before this field existed
    if (only && !only.includes(name)) continue;
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) {
      skipMcpEntry(name, `${parsed.error} Expected { "command": "npx", "args": [...], "env": { ... } } or { "type": "http", "url": "https://…", "headers": { ... } }`);
      continue;
    }
    if (!parsed.server.enabled) continue;
    out[name] = isRemoteMcpServer(parsed.server)
      ? { type: parsed.server.type, url: parsed.server.url, headers: parsed.server.headers }
      : { command: parsed.server.command, args: parsed.server.args, env: parsed.server.env };
  }
  return out;
}
