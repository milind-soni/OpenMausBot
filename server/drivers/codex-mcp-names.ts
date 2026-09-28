// MCP server names the user already declared in their own Codex config.
//
// Custom MCP servers reach codex as `-c mcp_servers.<name>.…` overrides, and
// codex merges an override into any same-named table in config.toml. A stdio
// command laid over a remote `url` entry is "invalid configuration": codex
// falls back to defaults, config/read fails, and the whole turn dies before
// the model is even asked. Mounting a colliding server under a name of its
// own keeps both definitions usable.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HEADER = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))[ \t]*[.\]]/gm;

/** Names declared as `[mcp_servers.<name>]` (or a sub-table of one). Inline
 * tables are not scanned; a collision there still surfaces as codex's own
 * configuration error. */
export function mcpServerNamesInToml(toml: string): Set<string> {
  const names = new Set<string>();
  for (const match of toml.matchAll(HEADER)) {
    const name = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2] ?? match[3];
    if (name) names.add(name);
  }
  return names;
}

/** Server names in the config.toml of the Codex home this child will use. */
export function codexConfigMcpServerNames(env: Record<string, string | undefined>): Set<string> {
  const codexHome = env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".codex");
  try {
    return mcpServerNamesInToml(readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
    return new Set();
  }
}

/** The name to mount a custom server under: its own, unless the user's Codex
 * config already has a server by that name. */
export function mountedMcpServerName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  let candidate = `${name}_openmausbot`;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name}_openmausbot${i}`;
  return candidate;
}
