import { mkdirSync } from "node:fs";

/**
 * A custom endpoint (Settings > Custom endpoint) gets its own Claude folder under providers/, but no sign-in that would
 * make it. On a Cloud the bot box binds that folder as a required path, and bubblewrap stops the turn when it is missing
 * ("Can't find source path"), so it is made before every spawn. Claude accounts and the default Claude are untouched.
 */
export function withEndpointFolder<T extends Record<string, string | undefined>>(
  env: T, config: { endpointModels?: unknown; configDir?: string },
): T {
  if (config.endpointModels && config.configDir && env.CLAUDE_CONFIG_DIR) mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  return env;
}
