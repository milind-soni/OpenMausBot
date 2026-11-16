import { accessSync, constants, statSync } from "node:fs";

/** Debian's tini package, which the server image installs and names as its entrypoint. */
export const IMAGE_INIT = "/usr/bin/tini";
/** Set on the launcher run again under tini, so a launcher that is still process 1 there never runs itself again. */
export const UNDER_IMAGE_INIT = "OMB_UNDER_IMAGE_INIT";
const DOCS = 'docs/self-hosting.md, "Running on a container platform"';
const NO_INIT = `nothing collects the processes bots leave behind, so they pile up until the container's process limit and bots fail to start ("spawn EAGAIN"). Start the container with an init (docker run --init, or tini as its entrypoint): ${DOCS}.`;

export interface ContainerInit {
  /** Replace this process with the image's tini running this same launcher (execve's file, argv and environment), so
   * tini is process 1 for the life of the container; null when something else already collects exited processes. */
  exec: { file: string; args: string[]; env: NodeJS.ProcessEnv } | null;
  /** Said once at start, when this process found itself the container's process 1. */
  line: string | null;
}

/** Linux hands a process whose parent exited to process 1 (or the nearest subreaper), which must wait() for it or it
 * stays in the process table as a zombie and counts against the container's pids limit. Node waits only for the
 * children it started itself, so as process 1 it hands that place to tini and runs as tini's child: tini then collects
 * every orphan, across server restarts, and passes `docker stop` on. */
export function containerInit(options: {
  pid?: number; platform?: NodeJS.Platform; runnable?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv; execPath?: string; execArgv?: string[]; argv?: string[];
} = {}): ContainerInit {
  if ((options.platform ?? process.platform) !== "linux" || (options.pid ?? process.pid) !== 1) return { exec: null, line: null };
  const env = options.env ?? process.env;
  if (env[UNDER_IMAGE_INIT] === "1") return { exec: null, line: `OpenMausBot is still process 1 after starting under ${IMAGE_INIT}: ${NO_INIT}` };
  if (!(options.runnable ?? canRun)(IMAGE_INIT)) return { exec: null, line: `OpenMausBot is process 1 in this container and has no init it can run (${IMAGE_INIT} is missing or not executable): ${NO_INIT}` };
  const execPath = options.execPath ?? process.execPath, argv = options.argv ?? process.argv;
  return {
    exec: { file: IMAGE_INIT, args: [IMAGE_INIT, "--", execPath, ...(options.execArgv ?? process.execArgv), ...argv.slice(1)], env: { ...env, [UNDER_IMAGE_INIT]: "1" } },
    line: `OpenMausBot is process 1 in this container: the image's entrypoint was replaced. It starts again under ${IMAGE_INIT}, so the processes bots leave behind are still collected (${DOCS}).`,
  };
}

/** A regular file this user may execute (not on a noexec mount). Checked before execve because Node 24 aborts the
 * whole process when execve fails, rather than throwing. */
export function canRun(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs `exec` and does not return; when it cannot (this Node has no execve, or the kernel refuses where Node throws),
 * says why and carries on without an init. */
export function execUnderInit(exec: NonNullable<ContainerInit["exec"]>, execve: ((file: string, args: string[], env: NodeJS.ProcessEnv) => never) | null = process.execve?.bind(process) ?? null): void {
  try {
    if (!execve) throw new Error("this Node cannot replace its own process");
    execve(exec.file, exec.args, exec.env);
  } catch (error) {
    console.warn(`OpenMausBot could not start under ${exec.file} (${error instanceof Error ? error.message : String(error)}): ${NO_INIT}`);
  }
}
