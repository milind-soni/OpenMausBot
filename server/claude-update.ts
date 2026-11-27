import type { ExecFileOptions } from "node:child_process";
import { dirname } from "node:path";

import { enginesBinDir, installNpmEngine } from "./engine-install.ts";
import { findCliCandidates } from "./env-path.ts";
import { describeSpawnFailure, execCli } from "./procs.ts";

type ExecCli = (
  cli: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr?: string) => void,
) => void;

const FALLBACK = "Run `claude update` in Terminal, then refresh Engines.";

/** Claude Code's npm package: the one ClaudeDriver's install descriptor names. */
export const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";

/** The copy Settings installed into the app's npm prefix shadows every other on PATH, and `claude update` cannot update it:
 * Claude's updater reinstalls through the first npm it finds. A configured path or wrapper is never the app's copy. */
export function isAppInstalledClaude(cli: string, binDir: string = enginesBinDir()): boolean {
  const resolved = findCliCandidates(cli)[0];
  return resolved !== undefined && dirname(resolved) === binDir;
}

export interface AppCopy {
  owns: (cli: string) => boolean;
  reinstall: (cli: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

const appCopy: AppCopy = {
  owns: (cli) => isAppInstalledClaude(cli),
  reinstall: (cli, env) => installNpmEngine(CLAUDE_CODE_PACKAGE, { cli, env }),
};

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string"
    ? stderr
    : Buffer.isBuffer(stderr)
      ? stderr.toString("utf8")
      : "";
}

function run(
  execute: ExecCli,
  cli: string,
  args: string[],
  options: ExecFileOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execute(cli, args, options, (error, stdout, stderr) => {
      if (error) {
        if ((error as { stderr?: unknown }).stderr === undefined && stderr) {
          Object.assign(error, { stderr });
        }
        reject(error);
      }
      else resolve(stdout);
    });
  });
}

function updateFailure(error: unknown, cli: string): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const processError = err as NodeJS.ErrnoException & { killed?: boolean };
  if (processError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new Error(`Claude update produced too much output. ${FALLBACK}`);
  }
  if (typeof processError.code === "string") {
    return new Error(`${describeSpawnFailure(processError, cli).message}. ${FALLBACK}`);
  }
  if (processError.killed) {
    return new Error(`Claude update timed out after 3 minutes. ${FALLBACK}`);
  }
  const detail = (stderrOf(err).trim() || err.message).split("\n")[0].slice(0, 400);
  return new Error(`Claude update failed${detail ? `: ${detail}` : ""}. ${FALLBACK}`);
}

/** The caller owns the environment, so credentials are stripped before the executable (or a wrapper) launches. */
export async function updateClaudeCli(
  cli: string,
  env: NodeJS.ProcessEnv,
  execute: ExecCli = execCli,
  own: AppCopy = appCopy,
): Promise<{ version: string }> {
  if (own.owns(cli)) {
    try {
      await own.reinstall(cli, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Claude update failed: ${message}`);
    }
  } else {
    try {
      await run(execute, cli, ["update"], {
        env,
        timeout: 180_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw updateFailure(error, cli);
    }
  }

  try {
    const stdout = await run(execute, cli, ["--version"], {
      env,
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    const version = stdout.trim().split("\n")[0];
    if (!version) throw new Error("Claude returned an empty version");
    return { version };
  } catch {
    throw new Error("Claude finished updating, but OpenMausBot could not verify the installed version. Refresh Engines to check it.");
  }
}
