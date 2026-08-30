import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ContainmentProof } from "../containment.ts";
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "../provider-runner.ts";
import {
  DockerCliContainmentSupervisor,
  type DockerCommandPort,
} from "./docker-containment.ts";

interface PatchChange {
  path: string;
  contents: string;
}

interface PatchProposal {
  status: "completed" | "failed" | "needs_configuration";
  summary: string;
  changes: PatchChange[];
}

export interface ReadOnlyPatchProvider {
  propose(request: AgentRunRequest): Promise<PatchProposal & { readOnlyEnforced: true }>;
  interrupt(runId: string): Promise<void>;
}

export interface PatchApplierPort {
  apply(request: AgentRunRequest, changes: PatchChange[]): Promise<ContainmentProof>;
  interrupt(runId: string): Promise<void>;
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error("docker_patch_name_invalid");
  return `omb-${normalized.slice(0, 48)}`;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function scopePattern(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

function validatedChanges(request: AgentRunRequest, changes: PatchChange[]): PatchChange[] {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 64) throw new Error("provider_patch_change_count_invalid");
  const scopes = request.writeScope.map(scopePattern);
  const root = resolve(request.cwd);
  let bytes = 0;
  return changes.map((change) => {
    if (!change || typeof change.path !== "string" || typeof change.contents !== "string") {
      throw new Error("provider_patch_change_invalid");
    }
    const path = change.path.replaceAll("\\", "/");
    const target = resolve(root, path);
    bytes += Buffer.byteLength(change.contents, "utf8");
    if (
      !path || isAbsolute(path) || path.includes("\0") || path.split("/").includes("..") ||
      path === ".git" || path.startsWith(".git/") || /(?:^|\/)\.env(?:\.|$)/u.test(path) ||
      !contained(root, target) || !scopes.some((scope) => scope.test(path))
    ) {
      throw new Error(`provider_patch_path_denied:${path.slice(0, 200)}`);
    }
    if (bytes > 1024 * 1024) throw new Error("provider_patch_content_limit_exceeded");
    return { path, contents: change.contents };
  });
}

export class DockerPatchApplier implements PatchApplierPort {
  private readonly docker: DockerCommandPort;
  private readonly containment: DockerCliContainmentSupervisor;
  private readonly image: string;
  private readonly exchangeRoot: string;
  private readonly helperPath: string;
  private readonly user: string;
  private readonly active = new Map<string, string>();

  constructor(input: {
    docker: DockerCommandPort;
    containment: DockerCliContainmentSupervisor;
    image: string;
    exchangeRoot: string;
    helperPath?: string;
    user?: string;
  }) {
    if (!input.image.trim()) throw new Error("docker_patch_image_required");
    this.docker = input.docker;
    this.containment = input.containment;
    this.image = input.image.trim();
    this.exchangeRoot = resolve(input.exchangeRoot);
    this.helperPath = input.helperPath?.trim() || "/opt/openmausbot/docker-apply-patch.js";
    if (!/^\/[A-Za-z0-9_./-]{1,500}$/u.test(this.helperPath) || this.helperPath.split("/").includes("..")) {
      throw new Error("docker_patch_helper_path_invalid");
    }
    this.user = input.user?.trim() || `${typeof process.getuid === "function" ? process.getuid() : 1000}:${typeof process.getgid === "function" ? process.getgid() : 1000}`;
    mkdirSync(this.exchangeRoot, { recursive: true, mode: 0o700 });
  }

  async apply(request: AgentRunRequest, changes: PatchChange[]): Promise<ContainmentProof> {
    const directory = join(this.exchangeRoot, safeName(`${request.runId}-${request.containmentBinding.nonce}`));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manifest = join(directory, "manifest.json");
    const gate = join(directory, "start");
    writeFileSync(manifest, JSON.stringify({ root: request.cwd, writeScopes: request.writeScope, changes }), { mode: 0o600 });
    const labels = this.containment.labels(request.containmentBinding).flatMap((label) => ["--label", label]);
    const created = await this.docker.run([
      "create",
      "--name", safeName(`${request.runId}-${request.containmentBinding.nonce.slice(0, 8)}`),
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "128",
      "--memory", "512m",
      "--cpus", "1",
      "--user", this.user,
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m",
      "--mount", `type=bind,src=${request.cwd},dst=${request.cwd}`,
      "--mount", `type=bind,src=${directory},dst=/run/openmausbot,readonly`,
      "--workdir", request.cwd,
      ...labels,
      "--entrypoint", "/bin/sh",
      this.image,
      "-c",
      "while [ ! -f /run/openmausbot/start ]; do sleep 0.02; done; exec node \"$1\" /run/openmausbot/manifest.json",
      "openmausbot-patch",
      this.helperPath,
    ], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    const containerId = created.stdout.toString("utf8").trim().toLowerCase();
    if (created.exitCode !== 0 || !/^[0-9a-f]{64}$/u.test(containerId)) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`docker_patch_create_failed:${created.stderr.toString("utf8").slice(0, 300)}`);
    }
    this.active.set(request.runId, containerId);
    let abort: (() => void) | undefined;
    try {
      const started = await this.docker.run(["start", containerId], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
      if (started.exitCode !== 0) throw new Error("docker_patch_start_failed");
      const proof = await this.containment.issueProof(containerId, request.containmentBinding);
      await request.registerContainment(proof);
      writeFileSync(gate, "start\n", { mode: 0o600 });
      abort = () => void this.interrupt(request.runId);
      request.signal.addEventListener("abort", abort, { once: true });
      const waited = await this.docker.run(["wait", containerId], {
        timeoutMs: 300_000,
        maxOutputBytes: 16 * 1024,
      });
      const exitCode = Number(waited.stdout.toString("utf8").trim());
      if (waited.exitCode !== 0 || exitCode !== 0) {
        const logs = await this.docker.run(["logs", containerId], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
        throw new Error(`docker_patch_apply_failed:${logs.stderr.toString("utf8").slice(0, 500)}`);
      }
      const inspection = await this.containment.inspect(proof.identity);
      if (inspection.state !== "empty") throw new Error("docker_patch_container_not_empty");
      return proof;
    } finally {
      if (abort) request.signal.removeEventListener("abort", abort);
      this.active.delete(request.runId);
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async interrupt(runId: string): Promise<void> {
    const id = this.active.get(runId);
    if (!id) return;
    await this.docker.run(["kill", id], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
  }
}

export class DockerPatchAgent implements AgentRunPort {
  private readonly provider: ReadOnlyPatchProvider;
  private readonly applier: PatchApplierPort;

  constructor(input: { provider: ReadOnlyPatchProvider; applier: PatchApplierPort }) {
    this.provider = input.provider;
    this.applier = input.applier;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (request.sandbox.network !== "deny" || !request.sandbox.denyGitMetadata || request.capabilities.gitCommit) {
      throw new Error("docker_patch_agent_contract_invalid");
    }
    request.emit({ threadId: request.threadId, turnId: request.turnId, type: "progress", message: "provider_read_only_started" });
    const proposal = await this.provider.propose(request);
    if (!proposal.readOnlyEnforced || proposal.status !== "completed") {
      return {
        threadId: request.threadId,
        turnId: request.turnId,
        status: proposal.status,
        message: proposal.summary.slice(0, 2_000),
        sandboxEnforced: proposal.readOnlyEnforced,
      };
    }
    const changes = validatedChanges(request, proposal.changes);
    const proof = await this.applier.apply(request, changes);
    request.emit({ threadId: request.threadId, turnId: request.turnId, type: "result", message: proposal.summary.slice(0, 2_000) });
    return {
      threadId: request.threadId,
      turnId: request.turnId,
      status: "completed",
      message: proposal.summary.slice(0, 2_000),
      sandboxEnforced: true,
      containmentProof: proof,
    };
  }

  async interrupt(runId: string): Promise<void> {
    await Promise.allSettled([this.provider.interrupt(runId), this.applier.interrupt(runId)]);
  }
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "changes"],
  properties: {
    status: { enum: ["completed", "failed", "needs_configuration"] },
    summary: { type: "string", maxLength: 2_000 },
    changes: {
      type: "array",
      minItems: 0,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "contents"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 500 },
          contents: { type: "string", maxLength: 1_048_576 },
        },
      },
    },
  },
};

export class CodexReadOnlyPatchProvider implements ReadOnlyPatchProvider {
  private readonly executable: string;
  private readonly model: string | undefined;
  private readonly reasoningEffort: string | undefined;
  private readonly exchangeRoot: string;
  private readonly timeoutMs: number;
  private readonly providerUid: number | undefined;
  private readonly providerGid: number | undefined;
  private readonly providerHome: string;
  private readonly forceKillGraceMs: number;
  private readonly launcher: { executable: string; args: string[] } | undefined;
  private readonly active = new Map<string, ChildProcess>();

  constructor(input: {
    executable?: string;
    model?: string;
    reasoningEffort?: string;
    exchangeRoot: string;
    timeoutMs?: number;
    providerUid?: number;
    providerGid?: number;
    providerHome?: string;
    forceKillGraceMs?: number;
    launcher?: { executable: string; args: string[] };
  }) {
    this.executable = input.executable?.trim() || "codex";
    this.model = input.model?.trim() || undefined;
    this.reasoningEffort = input.reasoningEffort?.trim() || undefined;
    this.exchangeRoot = resolve(input.exchangeRoot);
    this.timeoutMs = input.timeoutMs ?? 15 * 60_000;
    this.providerUid = input.providerUid;
    this.providerGid = input.providerGid;
    this.providerHome = input.providerHome?.trim() || process.env.HOME || "/tmp";
    this.forceKillGraceMs = input.forceKillGraceMs ?? 5_000;
    this.launcher = input.launcher;
    if ((this.providerUid === undefined) !== (this.providerGid === undefined)) {
      throw new Error("provider_uid_and_gid_must_be_configured_together");
    }
    if (!Number.isSafeInteger(this.forceKillGraceMs) || this.forceKillGraceMs < 1) {
      throw new Error("provider_force_kill_grace_invalid");
    }
    mkdirSync(this.exchangeRoot, { recursive: true, mode: 0o711 });
    if (this.providerUid !== undefined && this.providerGid !== undefined) {
      chownSync(
        this.exchangeRoot,
        typeof process.getuid === "function" ? process.getuid() : 0,
        typeof process.getgid === "function" ? process.getgid() : 0,
      );
    }
    chmodSync(this.exchangeRoot, 0o711);
  }

  async propose(request: AgentRunRequest): Promise<PatchProposal & { readOnlyEnforced: true }> {
    const directory = join(this.exchangeRoot, safeName(`${request.runId}-provider`));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const schema = join(directory, "schema.json");
    const output = join(directory, "output.json");
    writeFileSync(schema, JSON.stringify(OUTPUT_SCHEMA), { mode: 0o600 });
    writeFileSync(output, "", { mode: 0o600 });
    if (this.providerUid !== undefined && this.providerGid !== undefined) {
      const supervisorUid = typeof process.getuid === "function" ? process.getuid() : 0;
      chownSync(directory, supervisorUid, this.providerGid);
      chmodSync(directory, 0o710);
      chownSync(schema, supervisorUid, this.providerGid);
      chmodSync(schema, 0o640);
      chownSync(output, supervisorUid, this.providerGid);
      chmodSync(output, 0o660);
    }
    const prompt = [
      "You are the read-only planning half of a controlled code-change agent.",
      "Inspect only the supplied Git worktree. Do not modify files, run network tools, install dependencies, commit, or push.",
      "Git metadata is intentionally inaccessible. Do not run git commands; inspect files directly with read-only tools such as rg, sed, and cat.",
      "Return the complete desired contents for every changed file as JSON matching the required schema.",
      `Objective: ${request.objective}`,
      `Instructions: ${request.instructions}`,
      `Write scopes: ${JSON.stringify(request.writeScope)}`,
      `Denied scopes: ${JSON.stringify(request.denyScope)}`,
      `Expected artifacts: ${JSON.stringify(request.expectedArtifacts)}`,
      `Completion definition: ${request.completionDefinition}`,
    ].join("\n\n");
    const sandbox = this.providerUid !== undefined && this.providerGid !== undefined && this.launcher
      ? "danger-full-access"
      : "read-only";
    const args = [
      "exec", "-", "--skip-git-repo-check", "--sandbox", sandbox, "--ephemeral", "--color", "never",
      "--output-schema", schema, "--output-last-message", output, "-C", request.cwd,
      ...(this.model ? ["--model", this.model] : []),
      ...(this.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(this.reasoningEffort)}`] : []),
    ];
    try {
      await this.runProcess(request.runId, args, prompt, request.signal);
      const raw = readFileSync(output);
      if (raw.length < 2 || raw.length > 2 * 1024 * 1024) throw new Error("provider_patch_output_size_invalid");
      const parsed = JSON.parse(raw.toString("utf8")) as PatchProposal;
      if (!parsed || !["completed", "failed", "needs_configuration"].includes(parsed.status) || typeof parsed.summary !== "string" || !Array.isArray(parsed.changes)) {
        throw new Error("provider_patch_output_invalid");
      }
      return { ...parsed, readOnlyEnforced: true };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async interrupt(runId: string): Promise<void> {
    const child = this.active.get(runId);
    if (!child?.pid) return;
    const pid = child.pid;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
    } catch {}
    const forceKill = setTimeout(() => {
      if (this.active.get(runId) !== child) return;
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
      } catch {}
    }, this.forceKillGraceMs);
    forceKill.unref?.();
  }

  private async runProcess(runId: string, args: string[], prompt: string, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const executable = this.launcher?.executable ?? this.executable;
      const commandArgs = this.launcher ? [...this.launcher.args, this.executable, ...args] : args;
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: this.providerHome,
        CODEX_HOME: process.env.CODEX_HOME ?? join(this.providerHome, ".codex"),
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        NO_COLOR: "1",
      };
      const child = spawn(executable, commandArgs, {
        cwd: process.cwd(),
        env: environment,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
      this.active.set(runId, child);
      let stderr = Buffer.alloc(0);
      let settled = false;
      const stop = () => void this.interrupt(runId);
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, this.timeoutMs);
      timer.unref?.();
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, 64 * 1024);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        this.active.delete(runId);
        rejectPromise(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        this.active.delete(runId);
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`codex_patch_provider_failed:${stderr.toString("utf8").slice(0, 500)}`));
      });
      child.stdin?.end(prompt);
    });
  }
}

export const validateDockerPatchChanges = validatedChanges;
