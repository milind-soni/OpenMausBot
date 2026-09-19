// Labels, deterministic naming, validated Docker/SSH argv builders, and the
// default docker-over-SSH command runner for the BYO VPS provider. Base
// module of ./vps/: it imports no sibling module.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { CUA_SOCKET, cuaExecArgs } from "../container-computer.ts";
import { DATA_DIR, isValidSshAlias, vpsSshAlias, type AppConfig } from "../config.ts";
import { augmentedPath, resolveCliSpawn } from "../env-path.ts";
import { loadEnvironmentId } from "../environment.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { prepareVpsSsh } from "../vps-ssh.ts";

export const VPS_MANAGED_LABEL = "com.openmausbot.vps";
export const VPS_CONTAINER_LABEL = "com.openmausbot.container";
export const VPS_ENVIRONMENT_LABEL = "com.openmausbot.environment";
export const VPS_VIEWER_LABEL = "com.openmausbot.vps-viewer";
export const VPS_CONTAINER_PREFIX = "openmausbot-vps";

// The same durable id is also served by the environment discovery endpoint.
// Resolve it lazily: index must finish legacy data migration and acquire the
// writer lease before either provider may create the new data directory.
let vpsEnvironmentIdCache: string | null = null;
export function vpsEnvironmentId(): string {
  if (!vpsEnvironmentIdCache) vpsEnvironmentIdCache = loadEnvironmentId(DATA_DIR);
  return vpsEnvironmentIdCache;
}

// SIGTERM must give ssh + docker time to tear down the remote exec before the
// SIGKILL escalation; 1s was routinely too short over a WAN round-trip, and an
// orphaned remote exec keeps the driver socket busy for the next command.
export const COMMAND_TIMEOUT_KILL_GRACE_MS = 5_000;

export const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
export const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
export const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/i;
export const MANAGED_VPS_CONTAINER_NAME = /^openmausbot-vps-[a-z0-9]{1,12}-[a-f0-9]{12}$/;
export const IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;

export const VIEWER_VERSION = "1";

/** Pin one SSH destination for a complete provider operation. The shared app
 * config is reloaded in place, so retaining it across awaits could otherwise
 * inspect one host and start/remove a container on another. */
export function snapshotVpsConfig(cfg: AppConfig): AppConfig {
  const sshAlias = vpsSshAlias(cfg);
  return sshAlias ? { vps: { sshAlias } } : {};
}

export interface VpsCommandOptions {
  input?: string;
  timeoutMs?: number;
}

export type VpsCommandRunner = (
  args: string[],
  options?: VpsCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type VpsLifecycleAction = "provision" | "start" | "stop" | "remove";

function containerNamePart(botId: string): string {
  return botId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "bot";
}

/** Stable across restarts and independent of the bot's editable display name. */
export function vpsContainerName(botId: string): string {
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `${VPS_CONTAINER_PREFIX}-${containerNamePart(botId)}-${hash}`;
}

export function vpsDockerArgs(alias: string, args: string[]): string[] {
  if (!isValidSshAlias(alias)) {
    throw new Error("invalid VPS SSH config alias");
  }
  return ["-H", `ssh://${alias}`, ...args];
}

const STREAM_CAP_CHARS = 16 * 1024 * 1024;

/** Keeps the LAST 16MB of a stream without rebuilding one giant string per
 * chunk (a 10-minute `docker build` stream made that rebuild quadratic).
 * Chunks fall off the front as soon as the tail alone covers the cap; the
 * final slice preserves the exact cap semantics of the old accumulator. */
function tailCollector() {
  const chunks: string[] = [];
  let total = 0;
  return {
    push(chunk: string) {
      chunks.push(chunk);
      total += chunk.length;
      for (;;) {
        const first = chunks[0];
        if (chunks.length < 2 || first === undefined || total - first.length < STREAM_CAP_CHARS) break;
        chunks.shift();
        total -= first.length;
      }
    },
    text(): string {
      return chunks.join("").slice(-STREAM_CAP_CHARS);
    },
  };
}

export function defaultRunner(args: string[], options: VpsCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const command = resolveCliSpawn("docker", args);
    // docker's SSH transport runs the first `ssh` on PATH: the app's shim,
    // which shares one connection across every command of this VPS.
    const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());
    const child = spawn(command.command, command.args, {
      shell: false,
      env: { ...process.env, PATH: ssh.path },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = tailCollector();
    const stderr = tailCollector();
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      finish();
    };
    timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settle(() => reject(new Error("Docker-over-SSH command timed out")));
      }, COMMAND_TIMEOUT_KILL_GRACE_MS);
      killTimer.unref?.();
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120_000);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
    });
    child.stdin.on("error", (error) => {
      if (timedOut) return;
      settle(() => reject(new Error(`Docker-over-SSH stdin failed: ${error.message}`)));
    });
    child.on("error", (error) => {
      settle(() => reject(new Error(`Docker-over-SSH could not start: ${error.message}`)));
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        settle(() => reject(new Error("Docker-over-SSH command timed out")));
        return;
      }
      settle(() => {
        if (code === 0) return resolve({ stdout: stdout.text(), stderr: stderr.text() });
        const detail = stderr.text().trim().slice(-1000);
        reject(new Error(detail || `Docker-over-SSH exited ${code ?? signal ?? "without a status"}`));
      });
    });
    try {
      child.stdin.end(options.input);
    } catch (error) {
      settle(() => reject(new Error(`Docker-over-SSH stdin failed: ${error instanceof Error ? error.message : String(error)}`)));
    }
  });
}

export function vpsLockKey(cfg: AppConfig, botId: string): string | null {
  const alias = vpsSshAlias(cfg);
  return alias ? `${alias}:${vpsContainerName(botId)}` : null;
}

export function vpsContainerMcpArgs(alias: string, containerName: string): string[] {
  if (!isValidSshAlias(alias) || (!CONTAINER_NAME.test(containerName) && !CONTAINER_ID.test(containerName))) {
    throw new Error("invalid VPS MCP connection");
  }
  return vpsDockerArgs(
    alias,
    cuaExecArgs(["mcp", "--socket", CUA_SOCKET], { container: containerName, interactive: true }),
  );
}

export function vpsComputerMcp(cfg: AppConfig, botId: string, containerRef?: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw new Error("VPS is not configured — add an SSH config alias first");
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.vpsContainerMcp, alias, containerRef ?? vpsContainerName(botId)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}
