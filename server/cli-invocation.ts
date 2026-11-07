/** How this CLI was started, so every command it prints can be pasted as is: `npx openmausbot`, `pnpm omb` in a
 * checkout, the Docker image's `docker compose exec omb openmausbot` (OMB_CLI_PREFIX), or plain `openmausbot`. */
export function cliPrefix(env: NodeJS.ProcessEnv = process.env, script = process.argv[1] ?? ""): string {
  const fixed = env.OMB_CLI_PREFIX?.trim();
  if (fixed) return fixed;
  if (env.npm_lifecycle_event === "omb") return "pnpm omb";
  // npm 7+ runs `npx` packages from its cache's `_npx` folder and marks the run `npm_command=exec`.
  if (/[\\/]_npx[\\/]/.test(script) || env.npm_command === "exec") return "npx openmausbot";
  return "openmausbot";
}

/** `openmausbot <rest>` the way this CLI was started. */
export function cliCommand(rest: string, env?: NodeJS.ProcessEnv, script?: string): string {
  return `${cliPrefix(env, script)} ${rest}`;
}
