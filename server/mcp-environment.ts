import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mcpNpmCache = join(tmpdir(), `openmausbot-mcp-npm-${randomBytes(12).toString("hex")}`);

/** Give npm-backed MCP commands a writable cache even when the server's inherited cache is not writable. */
export function mcpCommandEnvironment(base: NodeJS.ProcessEnv, serverEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "npm_config_cache") delete env[key];

  const explicitCache = Object.keys(serverEnv).some((key) => key.toLowerCase() === "npm_config_cache");
  if (!explicitCache) env.npm_config_cache = mcpNpmCache;
  return { ...env, ...serverEnv };
}
