// Settings → engines "Test": run a CLI's `--version` with only PATH, never inherited credentials.
import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "./config.ts";
import type { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { augmentedPath } from "./env-path.ts";
import { describeSpawnFailure, execCli } from "./procs.ts";

export async function testCliBinary(
  cli: string,
  driver: (typeof BUILT_IN_DRIVERS)[number] | undefined,
): Promise<{ ok: boolean; version?: string; message?: string; install?: (typeof BUILT_IN_DRIVERS)[number]["install"] }> {
  return new Promise((resolve) => {
    execCli(
      cli,
      ["--version"],
      {
        timeout: 10_000,
        // SIGKILL, not SIGTERM: a child that traps TERM would never fire the callback and would pin the HTTP socket.
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 64,
        env: cliProbeEnvironment(),
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          // Node's err.code is an errno string only for spawn failures; a non-zero exit gives the status, a timeout null with killed.
          const exceededBuffer = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const isSpawnError = typeof e.code === "string" && !exceededBuffer;
          const message = exceededBuffer
            ? "CLI test produced more than 64 KiB of output"
            : isSpawnError
              ? describeSpawnFailure(e, cli).message
              : e.killed
              ? "CLI test timed out after 10s"
              : `CLI exited with error ${String(e.code)}: ${(stderrOf(err) || "").slice(0, 200) || err.message.split("\n")[0]}`;
          resolve({ ok: false, message, ...(driver?.install && isSpawnError ? { install: driver.install } : {}) });
          return;
        }
        resolve({ ok: true, version: stdout.trim().split("\n")[0] });
      },
    );
  });
}

/** Only PATH: never hand inherited credentials to an arbitrary wrapper selected through Settings. */
export function cliProbeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  return env;
}

function stderrOf(err: unknown): string {
  const s = (err as { stderr?: unknown }).stderr;
  return typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("utf8") : "";
}
