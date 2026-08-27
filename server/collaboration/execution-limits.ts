import { spawn } from "node:child_process";

import { killCliTree } from "../procs.ts";

export interface ArgvCommand {
  argv: readonly [string, ...string[]];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ArgvResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

const CREDENTIAL_ENV = /^(?:GIT_|SSH_|GCM_|GH_|GITHUB_|NPM_|PNPM_|YARN_|.*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY).*)$/iu;
const PROCESS_GROUP_TERM_GRACE_MS = 1_000;
const PROCESS_GROUP_KILL_GRACE_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 20;

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, remaining)));
  }
  return true;
}

async function cleanupProcessGroup(processGroupId: number): Promise<void> {
  if (!processGroupExists(processGroupId)) return;
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, PROCESS_GROUP_TERM_GRACE_MS)) return;
  signalProcessGroup(processGroupId, "SIGKILL");
  if (await waitForProcessGroupExit(processGroupId, PROCESS_GROUP_KILL_GRACE_MS)) return;
  throw new Error(`Unable to reap command process group ${processGroupId}`);
}

export function isolatedExecutionEnvironment(input: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: input.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: input.TMPDIR ?? "/tmp",
    LANG: input.LANG ?? "C.UTF-8",
    LC_ALL: input.LC_ALL ?? "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: process.platform === "win32" ? "" : "/usr/bin/false",
    SSH_ASKPASS: process.platform === "win32" ? "" : "/usr/bin/false",
    GCM_INTERACTIVE: "never",
    HUSKY: "0",
  };
  for (const key of Object.keys(environment)) {
    if (
      CREDENTIAL_ENV.test(key) &&
      !key.startsWith("GIT_TERMINAL") &&
      key !== "GIT_ASKPASS" &&
      key !== "SSH_ASKPASS" &&
      key !== "GCM_INTERACTIVE"
    ) {
      delete environment[key];
    }
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  return environment;
}

export async function runArgv(command: ArgvCommand, options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ArgvResult> {
  if (!Number.isInteger(command.timeoutMs) || command.timeoutMs <= 0) throw new Error("Command timeout must be positive");
  if (!Number.isInteger(command.maxOutputBytes) || command.maxOutputBytes <= 0) {
    throw new Error("Command output limit must be positive");
  }
  const [file, ...args] = command.argv;
  const startedAt = Date.now();
  return await new Promise<ArgvResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      const pid = child.pid;
      if (!pid) return Promise.resolve();
      if (process.platform !== "win32") {
        cleanupPromise = cleanupProcessGroup(pid);
        return cleanupPromise;
      }
      killCliTree(child);
      if (!hardKill) {
        hardKill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, PROCESS_GROUP_TERM_GRACE_MS);
        hardKill.unref?.();
      }
      cleanupPromise = Promise.resolve();
      return cleanupPromise;
    };
    const stop = () => {
      void cleanup().catch(() => undefined);
    };
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const remaining = command.maxOutputBytes - stdout.length - stderr.length;
      if (remaining <= 0) {
        outputLimitExceeded = true;
        stop();
        return current;
      }
      const accepted = chunk.subarray(0, remaining);
      if (accepted.length < chunk.length) {
        outputLimitExceeded = true;
        stop();
      }
      return Buffer.concat([current, accepted]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      void cleanup().then(
        () => reject(error),
        (cleanupError) => reject(new AggregateError([error, cleanupError], "Command failed and process cleanup failed")),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      void cleanup().then(
        () =>
          resolve({
            exitCode,
            signal,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt,
            timedOut,
            outputLimitExceeded,
          }),
        reject,
      );
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, command.timeoutMs);
    timer.unref?.();
  });
}

export async function withAbortTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<{ value?: T; timedOut: boolean }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("Agent run timed out"));
      reject(new Error("Agent run timed out"));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return { value: await Promise.race([operation(controller.signal), timeout]), timedOut: false };
  } catch (error) {
    if (controller.signal.aborted) return { timedOut: true };
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
