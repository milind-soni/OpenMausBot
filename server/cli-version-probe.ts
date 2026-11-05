import { CLI_VERSION_TIMEOUT_MS, cliVersionReader, execCli } from "./procs.ts";

// Shares version checks and retries empty responses.
export function cliVersionProbe(cli: string, run: typeof execCli = execCli) {
  const read = cliVersionReader(cli);
  let pending: Promise<ReturnType<typeof read>> | undefined;
  return (env: NodeJS.ProcessEnv): Promise<ReturnType<typeof read>> => {
    if (pending) return pending;
    const deadline = Date.now() + CLI_VERSION_TIMEOUT_MS;
    const attempt = () => new Promise<{ error: Error | null; stdout: string }>((resolve) => {
      run(cli, ["--version"], { timeout: Math.max(1, deadline - Date.now()), env }, (error, stdout) => resolve({ error, stdout }));
    });
    pending = (async () => {
      let result = await attempt();
      if (!result.error && !result.stdout.trim() && Date.now() < deadline) result = await attempt();
      return read(result.error, result.stdout);
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
