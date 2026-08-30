import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

import {
  containmentBindingHash,
  type ContainmentBinding,
  type ContainmentInspection,
  type ContainmentPort,
  type ContainmentProof,
  runtimeIdentityFingerprint,
  type RuntimeIdentity,
} from "../containment.ts";

const BACKEND = "docker_cgroup_v2";
const MANAGED_LABEL = "com.openmausbot.collaboration.managed";
const BINDING_LABEL = "com.openmausbot.collaboration.binding";
const GENERATION_LABEL = "com.openmausbot.collaboration.host-generation";

export interface DockerCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface DockerCommandPort {
  run(args: readonly string[], options?: { input?: Buffer; timeoutMs?: number; maxOutputBytes?: number }): Promise<DockerCommandResult>;
}

export class NodeDockerCommandPort implements DockerCommandPort {
  private readonly executable: string;
  private readonly prefix: readonly string[];

  constructor(input: { executable?: string; context?: string } = {}) {
    this.executable = input.executable?.trim() || "docker";
    const context = input.context?.trim();
    this.prefix = context ? ["--context", context] : [];
  }

  async run(
    args: readonly string[],
    options: { input?: Buffer; timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<DockerCommandResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("docker_timeout_invalid");
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("docker_output_limit_invalid");
    return await new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...this.prefix, ...args], {
        shell: false,
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      if (!child.stdout || !child.stderr) {
        child.kill("SIGKILL");
        reject(new Error("docker_stdio_unavailable"));
        return;
      }
      let bytes = 0;
      let settled = false;
      let limited = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      const collect = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          limited = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (limited) {
          reject(new Error("docker_output_limit_exceeded"));
          return;
        }
        if (timedOut) {
          reject(new Error("docker_command_timed_out"));
          return;
        }
        resolve({ exitCode: code ?? 127, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      if (options.input) {
        if (!child.stdin) {
          child.kill("SIGKILL");
          reject(new Error("docker_stdin_unavailable"));
          return;
        }
        child.stdin.end(options.input);
      }
    });
  }
}

interface DockerInspection {
  Id?: unknown;
  Config?: { Labels?: Record<string, string> | null };
  State?: { Running?: unknown; Status?: unknown };
}

function receipt(key: Buffer, identity: RuntimeIdentity, binding: ContainmentBinding): string {
  return createHmac("sha256", key)
    .update(runtimeIdentityFingerprint(identity))
    .update("\0")
    .update(containmentBindingHash(binding))
    .digest("base64url");
}

function parseInspection(result: DockerCommandResult): DockerInspection | null {
  if (result.exitCode !== 0 || result.stdout.length > 128 * 1024) return null;
  try {
    const parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
    const value = Array.isArray(parsed) ? parsed[0] : parsed;
    return value && typeof value === "object" ? (value as DockerInspection) : null;
  } catch {
    return null;
  }
}

export class DockerCliContainmentSupervisor implements ContainmentPort {
  private readonly docker: DockerCommandPort;
  private readonly hostGeneration: string;
  private readonly verifierKey: Buffer;
  private readonly verifierVersion: string;
  private readonly emptyTimeoutMs: number;

  constructor(input: {
    docker: DockerCommandPort;
    hostGeneration: string;
    verifierKey: Buffer;
    verifierVersion?: string;
    emptyTimeoutMs?: number;
  }) {
    if (!input.hostGeneration.trim()) throw new Error("host_generation_required");
    if (input.verifierKey.length < 32) throw new Error("containment_verifier_key_too_short");
    this.docker = input.docker;
    this.hostGeneration = input.hostGeneration.trim();
    this.verifierKey = Buffer.from(input.verifierKey);
    this.verifierVersion = input.verifierVersion ?? "docker-cgroup-v2-hmac-v1";
    this.emptyTimeoutMs = input.emptyTimeoutMs ?? 10_000;
  }

  labels(binding: ContainmentBinding): string[] {
    return [
      `${MANAGED_LABEL}=1`,
      `${BINDING_LABEL}=${containmentBindingHash(binding)}`,
      `${GENERATION_LABEL}=${this.hostGeneration}`,
    ];
  }

  async issueProof(containerId: string, binding: ContainmentBinding): Promise<ContainmentProof> {
    const identity = this.identity(containerId);
    const inspection = await this.inspection(containerId);
    if (!inspection || inspection.State?.Running !== true) throw new Error("containment_container_not_running");
    if (!this.labelsMatch(inspection, binding)) throw new Error("containment_container_labels_invalid");
    return { identity, receipt: receipt(this.verifierKey, identity, binding) };
  }

  async verifyProof(proof: ContainmentProof, expectedBinding: ContainmentBinding) {
    if (
      proof.identity.backend !== BACKEND ||
      proof.identity.hostGeneration !== this.hostGeneration ||
      proof.identity.verifierVersion !== this.verifierVersion
    ) {
      return { verified: false as const, reason: "containment_supervisor_identity_mismatch" };
    }
    const inspection = await this.inspection(proof.identity.opaqueId);
    if (!inspection || !this.labelsMatch(inspection, expectedBinding)) {
      return { verified: false as const, reason: "containment_container_unavailable" };
    }
    const expected = Buffer.from(receipt(this.verifierKey, proof.identity, expectedBinding));
    const actual = Buffer.from(proof.receipt);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { verified: false as const, reason: "containment_receipt_invalid" };
    }
    return {
      verified: true as const,
      fingerprint: runtimeIdentityFingerprint(proof.identity),
      bindingHash: containmentBindingHash(expectedBinding),
    };
  }

  async inspect(identity: RuntimeIdentity): Promise<ContainmentInspection> {
    if (!this.validIdentity(identity)) return { state: "unknown", reason: "containment_identity_invalid" };
    const inspection = await this.inspection(identity.opaqueId);
    if (!inspection) return { state: "unknown", reason: "containment_container_unavailable" };
    const fingerprint = runtimeIdentityFingerprint(identity);
    return inspection.State?.Running === true ? { state: "active", fingerprint } : { state: "empty", fingerprint };
  }

  async terminateAndWaitEmpty(identity: RuntimeIdentity): Promise<ContainmentInspection> {
    if (!this.validIdentity(identity)) return { state: "unknown", reason: "containment_identity_invalid" };
    const inspection = await this.inspection(identity.opaqueId);
    if (!inspection) return { state: "unknown", reason: "containment_container_unavailable" };
    if (inspection.State?.Running === true) {
      await this.docker.run(["kill", identity.opaqueId], { timeoutMs: this.emptyTimeoutMs, maxOutputBytes: 16 * 1024 });
    }
    const deadline = Date.now() + this.emptyTimeoutMs;
    while (Date.now() <= deadline) {
      const state = await this.inspect(identity);
      if (state.state === "empty" || state.state === "unknown") return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { state: "unknown", reason: "containment_container_did_not_stop" };
  }

  private identity(containerId: string): RuntimeIdentity {
    const normalized = containerId.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error("containment_container_id_invalid");
    return {
      backend: BACKEND,
      opaqueId: normalized,
      hostGeneration: this.hostGeneration,
      verifierVersion: this.verifierVersion,
    };
  }

  private validIdentity(identity: RuntimeIdentity): boolean {
    return (
      identity.backend === BACKEND &&
      identity.hostGeneration === this.hostGeneration &&
      identity.verifierVersion === this.verifierVersion &&
      /^[0-9a-f]{64}$/u.test(identity.opaqueId)
    );
  }

  private labelsMatch(inspection: DockerInspection, binding: ContainmentBinding): boolean {
    const labels = inspection.Config?.Labels ?? {};
    return (
      labels[MANAGED_LABEL] === "1" &&
      labels[BINDING_LABEL] === containmentBindingHash(binding) &&
      labels[GENERATION_LABEL] === this.hostGeneration
    );
  }

  private async inspection(containerId: string): Promise<DockerInspection | null> {
    const normalized = containerId.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(normalized)) return null;
    return parseInspection(await this.docker.run(["inspect", normalized], { timeoutMs: 5_000, maxOutputBytes: 128 * 1024 }));
  }
}
