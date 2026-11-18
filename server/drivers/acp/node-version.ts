import { execCli } from "../../procs.ts";

/** The Node.js version the `node` on `env`'s PATH reports ("20.19.4"); undefined when it can't be read. */
export function readNodeVersion(env: Record<string, string | undefined>): Promise<string | undefined> {
  return new Promise((resolve) => {
    execCli("node", ["--version"], { env: env as NodeJS.ProcessEnv, timeout: 5_000 }, (error, stdout) => {
      resolve(error ? undefined : /^v?(\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1]);
    });
  });
}

/** Whether `version` comes before `minimum` (both "major.minor.patch"). */
export function nodeOlderThan(version: string, minimum: string): boolean {
  const have = version.split(".").map(Number);
  const need = minimum.split(".").map(Number);
  for (let part = 0; part < 3; part++) {
    if ((have[part] ?? 0) !== (need[part] ?? 0)) return (have[part] ?? 0) < (need[part] ?? 0);
  }
  return false;
}
