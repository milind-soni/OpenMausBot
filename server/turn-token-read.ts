// The proxy side of per-turn tokens (see turn-token.ts). Kept free of any
// server import so the spawned proxies (agents, browser, connectors) stay
// small and load nothing but node:fs.
import { readFileSync } from "node:fs";

/** The current token for `envName`: read fresh from the file named by
 * `<envName>_FILE` when present (the harness rewrites it every turn), else
 * the plain env value. An unreadable file yields "" — the harness then
 * answers 401, the right failure for a token that is genuinely gone. */
export function readTurnToken(envName: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = env[`${envName}_FILE`];
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  }
  return env[envName] ?? "";
}
