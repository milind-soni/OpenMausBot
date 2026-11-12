import { findCliCandidates } from "./env-path.ts";
import { CLI_VERSION_TIMEOUT_MS, cliVersionReader, execCli } from "./procs.ts";

/** What to launch: on Windows the checked copy's own path, since spawn-time resolution reads the app's PATH, not the turn's (POSIX spawn already looks up the turn's PATH). */
export function cliToLaunch(cli: string, checked: string | undefined, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" && checked ? checked : cli;
}

// Shares version checks and retries empty responses. A failed check falls back to the last version only while PATH
// still finds the same copy of the CLI, so a newly found copy is never reported with another copy's version.
export function cliVersionProbe(cli: string, run: typeof execCli = execCli) {
  let read = cliVersionReader(cli), readAt: string | undefined;
  let pending: { path: string | undefined; probe: Promise<ReturnType<typeof read>> } | undefined; // shared only by callers with the same PATH
  return (env: NodeJS.ProcessEnv): Promise<ReturnType<typeof read>> => {
    if (pending && pending.path === env.PATH) return pending.probe;
    const at = findCliCandidates(cli, env.PATH ?? "")[0];
    if (at !== readAt) [read, readAt] = [cliVersionReader(cli), at];
    const reader = read;
    const deadline = Date.now() + CLI_VERSION_TIMEOUT_MS;
    const attempt = () => new Promise<{ error: Error | null; stdout: string }>((resolve) => {
      run(cli, ["--version"], { timeout: Math.max(1, deadline - Date.now()), env }, (error, stdout) => resolve({ error, stdout }));
    });
    const entry: NonNullable<typeof pending> = { path: env.PATH, probe: (async () => {
      let result = await attempt();
      if (!result.error && !result.stdout.trim() && Date.now() < deadline) result = await attempt();
      return reader(result.error, result.stdout);
    })().finally(() => { if (pending === entry) pending = undefined; }) };
    pending = entry;
    return entry.probe;
  };
}
