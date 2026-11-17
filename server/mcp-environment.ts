import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const mcpNpmCache = join(tmpdir(), `openmausbot-mcp-npm-${randomBytes(12).toString("hex")}`);

/** npm's cache for this environment: `npm_config_cache` when set, else npm's own default under the home folder. */
function inheritedNpmCache(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "npm_config_cache");
  if (key) return env[key] || undefined;
  if (process.platform === "win32") return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "npm-cache") : undefined;
  return env.HOME ? join(env.HOME, ".npm") : undefined;
}

/** The nearest folder that exists on the way to `path` can be written. */
export function writableCache(path: string): boolean {
  for (let at = join(path, "_cacache", "tmp"); ; at = dirname(at)) {
    try {
      accessSync(at, constants.W_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) return false;
    }
  }
}

/** Give npm-backed MCP commands a writable cache when the one the server inherited cannot be written. A cache that
 * works is kept, so packages it already holds still start offline and are not fetched again on every launch. */
export function mcpCommandEnvironment(base: NodeJS.ProcessEnv, serverEnv: Record<string, string>, canWrite = writableCache): NodeJS.ProcessEnv {
  const explicitCache = Object.keys(serverEnv).some((key) => key.toLowerCase() === "npm_config_cache");
  const inherited = inheritedNpmCache({ ...base, ...serverEnv });
  if (explicitCache || !inherited || canWrite(inherited)) return { ...base, ...serverEnv };
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "npm_config_cache") delete env[key];
  return { ...env, npm_config_cache: mcpNpmCache, ...serverEnv };
}
