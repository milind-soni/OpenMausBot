// Host runtime support for the Local VM: the default sh runner over the
// host PATH, the CommandRunner contract every computation accepts, and
// Docker/Podman/Apple-container detection. Imports no sibling module.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { augmentedPath, resolveCliSpawn } from "../env-path.ts";

const run = promisify(execFile);

export type CommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string }>;

const RUNTIMES = ["docker", "podman", "container"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type LifecycleAction = "pull" | "run" | "start" | "stop" | "remove";

export async function sh(cmd: string, args: string[], timeout = 8000): Promise<{ stdout: string }> {
  const resolved = resolveCliSpawn(cmd, args);
  const { stdout } = await run(resolved.command, resolved.args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: augmentedPath() },
  });
  return { stdout };
}

async function installed(
  cmd: string,
  runner: CommandRunner,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await runner(platform === "win32" ? "where.exe" : "/usr/bin/which", [cmd], 4000);
    return true;
  } catch {
    return false;
  }
}

export interface ContainerRuntimeStatus {
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
}

/** Inspect only the host runtime. Unlike a full Local VM status check, this
 * never opens a container, calls Cua, or reads a desktop screenshot. */
export async function containerRuntimeStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
): Promise<ContainerRuntimeStatus> {
  // Podman is the supported Windows VM lane and owns the pinned managed image.
  // Docker may also be installed and healthy on the same host, so the generic
  // Docker-first order would silently select an empty, unrelated image store.
  const candidates: Runtime[] = platform === "win32"
    ? ["podman", "docker"]
    : RUNTIMES.filter((runtime) => runtime !== "container" || platform === "darwin");
  const present = await Promise.all(candidates.map((runtime) => installed(runtime, runner, platform)));
  const available = candidates.filter((_, index) => present[index]);
  const healthy = await Promise.all(
    available.map(async (candidate) => {
      try {
        const infoArgs = candidate === "container"
          ? ["system", "status"]
          : candidate === "podman"
            ? ["info", "--format", "json"]
            : ["info", "--format", "{{.ServerVersion}}"];
        await runner(
          candidate,
          infoArgs,
          10_000,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  const healthyIndex = healthy.indexOf(true);
  return {
    runtime: healthyIndex >= 0 ? available[healthyIndex] : (available[0] ?? null),
    available,
    daemonUp: healthyIndex >= 0,
  };
}
