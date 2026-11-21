import { containerExec, type ContainerExecResult } from "./container-computer.ts";
import { defaultRunner, VpsHostUnreachableError, type VpsCommandRunner } from "./vps-command.ts";
import { vpsDockerArgs } from "./vps-computer.ts";

export interface VpsExecTarget {
  sshAlias: string;
  container: string;
}

/** vm_exec on a Self-hosted VPS desktop: the Local VM's exec, sent over the desktop's own Docker-over-SSH connection. */
export function vpsContainerExec(
  target: VpsExecTarget,
  command: string,
  options: { timeoutSeconds?: number; runner?: VpsCommandRunner } = {},
): Promise<ContainerExecResult> {
  const runner = options.runner ?? defaultRunner;
  return containerExec({ containerName: target.container }, command, {
    runtime: "docker",
    timeoutSeconds: options.timeoutSeconds,
    exec: async (_runtime, args, { timeout }) => {
      try {
        return { ...(await runner(vpsDockerArgs(target.sshAlias, args), { timeoutMs: timeout })), code: 0 };
      } catch (error) {
        const failure = error as { exitCode?: unknown; stdout?: string; stderr?: string };
        if (!(error instanceof VpsHostUnreachableError) && typeof failure.exitCode === "number") {
          return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.exitCode };
        }
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { status: 502 });
      }
    },
  });
}
