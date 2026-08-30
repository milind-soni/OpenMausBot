import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type {
  SandboxedCommandRequest,
  SandboxedCommandResult,
  SandboxedCommandRunner,
} from "../quality-gate.ts";
import {
  DockerCliContainmentSupervisor,
  type DockerCommandPort,
} from "./docker-containment.ts";

const SAFE_ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error("docker_container_name_invalid");
  return `omb-${normalized.slice(0, 48)}`;
}

function environmentArgs(environment: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!SAFE_ENVIRONMENT_KEY.test(key) || value === undefined || value.includes("\0")) continue;
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

function containerId(stdout: Buffer): string {
  const value = stdout.toString("utf8").trim().toLowerCase();
  if (!CONTAINER_ID.test(value)) throw new Error("docker_create_did_not_return_container_id");
  return value;
}

export class DockerSandboxedCommandRunner implements SandboxedCommandRunner {
  private readonly docker: DockerCommandPort;
  private readonly containment: DockerCliContainmentSupervisor;
  private readonly image: string;
  private readonly exchangeRoot: string;
  private readonly user: string;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly pidsLimit: number;

  constructor(input: {
    docker: DockerCommandPort;
    containment: DockerCliContainmentSupervisor;
    image: string;
    exchangeRoot: string;
    user?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
  }) {
    if (!input.image.trim()) throw new Error("docker_command_image_required");
    this.docker = input.docker;
    this.containment = input.containment;
    this.image = input.image.trim();
    this.exchangeRoot = resolve(input.exchangeRoot);
    this.user = input.user?.trim() || `${typeof process.getuid === "function" ? process.getuid() : 1000}:${typeof process.getgid === "function" ? process.getgid() : 1000}`;
    this.memory = input.memory?.trim() || "1g";
    this.cpus = input.cpus?.trim() || "1";
    this.pidsLimit = input.pidsLimit ?? 256;
    if (!Number.isSafeInteger(this.pidsLimit) || this.pidsLimit < 16) throw new Error("docker_pids_limit_invalid");
    mkdirSync(this.exchangeRoot, { recursive: true, mode: 0o700 });
  }

  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    const startedAt = Date.now();
    const runDirectory = join(this.exchangeRoot, safeName(`${request.containmentBinding.runId}-${request.commandId}-${request.containmentBinding.nonce}`));
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const gate = join(runDirectory, "start");
    const labels = this.containment.labels(request.containmentBinding).flatMap((label) => ["--label", label]);
    const name = safeName(`${request.containmentBinding.runId}-${request.commandId}-${request.containmentBinding.nonce.slice(0, 8)}`);
    const create = await this.docker.run([
      "create",
      "--name", name,
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", String(this.pidsLimit),
      "--memory", this.memory,
      "--cpus", this.cpus,
      "--user", this.user,
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--mount", `type=bind,src=${request.sandbox.writableRoot},dst=${request.sandbox.writableRoot}`,
      "--mount", `type=bind,src=${runDirectory},dst=/run/openmausbot,readonly`,
      "--workdir", request.cwd,
      ...environmentArgs(request.environment),
      ...labels,
      "--entrypoint", "/bin/sh",
      this.image,
      "-c", "while [ ! -f /run/openmausbot/start ]; do sleep 0.02; done; exec \"$@\"", "openmausbot-command",
      ...request.argv,
    ], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (create.exitCode !== 0) {
      rmSync(runDirectory, { recursive: true, force: true });
      throw new Error(`docker_command_create_failed:${create.stderr.toString("utf8").slice(0, 300)}`);
    }
    const id = containerId(create.stdout);
    let proof;
    let timedOut = false;
    let outputLimitExceeded = false;
    try {
      const start = await this.docker.run(["start", id], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
      if (start.exitCode !== 0) throw new Error("docker_command_start_failed");
      proof = await this.containment.issueProof(id, request.containmentBinding);
      await request.registerContainment(proof);
      writeFileSync(gate, "start\n", { mode: 0o600 });
      let exitCode: number | null = null;
      try {
        const waited = await this.docker.run(["wait", id], {
          timeoutMs: request.timeoutMs,
          maxOutputBytes: 16 * 1024,
        });
        const parsed = Number(waited.stdout.toString("utf8").trim());
        exitCode = Number.isSafeInteger(parsed) ? parsed : waited.exitCode === 0 ? 127 : waited.exitCode;
      } catch (error) {
        timedOut = error instanceof Error && /timeout|timed out/iu.test(error.message);
        await this.containment.terminateAndWaitEmpty(proof.identity);
      }
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      try {
        const logs = await this.docker.run(["logs", id], {
          timeoutMs: 10_000,
          maxOutputBytes: request.maxOutputBytes,
        });
        stdout = logs.stdout;
        stderr = logs.stderr;
      } catch (error) {
        outputLimitExceeded = error instanceof Error && error.message === "docker_output_limit_exceeded";
      }
      const inspected = await this.containment.inspect(proof.identity);
      const processTreeReaped = inspected.state === "empty";
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: Math.max(0, Date.now() - startedAt),
        timedOut,
        outputLimitExceeded,
        attestation: {
          sandboxEnforced: true,
          writableRoot: request.sandbox.writableRoot,
          deniedPaths: [...request.sandbox.deniedPaths],
          network: "deny",
          processIsolated: true,
          processTreeReaped,
          containmentProof: proof,
        },
      };
    } finally {
      rmSync(runDirectory, { recursive: true, force: true });
    }
  }
}

export const dockerCommandContainerName = safeName;
export const dockerCommandGateName = (path: string): string => basename(path);
