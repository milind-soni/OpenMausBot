import { execFile } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  containmentBindingHash,
  runtimeIdentityFingerprint,
  type ContainmentBinding,
  type ContainmentInspection,
  type ContainmentPort,
  type ContainmentProof,
  type RuntimeIdentity,
  type VerifiedContainmentProof,
} from "../../server/collaboration/containment.ts";
import type { OutboxDeliveryPort } from "../../server/collaboration/outbox.ts";
import type { PlannerPort, PlannerProposal } from "../../server/collaboration/planner.ts";
import type {
  AgentRunEvent,
  AgentRunPort,
  AgentRunRequest,
  AgentRunResult,
} from "../../server/collaboration/provider-runner.ts";
import type {
  SandboxedCommandRequest,
  SandboxedCommandResult,
  SandboxedCommandRunner,
} from "../../server/collaboration/quality-gate.ts";
import type { DiskCapacity, DiskCapacityPort } from "../../server/collaboration/operations/disk-monitor.ts";
import type {
  PrivateOwnerAlertPort,
  SafeOperationalAlert,
} from "../../server/collaboration/operations/private-alert.ts";
import type { WorkItemSnapshot } from "../../server/collaboration/snapshot.ts";

const execFileAsync = promisify(execFile);
const CREDENTIAL_ENVIRONMENT_KEY =
  /^(?:GIT_(?!ASKPASS$|TERMINAL_PROMPT$|CONFIG_GLOBAL$|CONFIG_NOSYSTEM$)|SSH_(?!ASKPASS$)|GCM_(?!INTERACTIVE$)|GH_|GITHUB_|NPM_|PNPM_|YARN_|.*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY).*)$/iu;
const REMOTE_OR_NETWORK_EXECUTABLE = /^(?:curl|fetch|ftp|git|nc|netcat|pnpm|scp|ssh|wget|yarn)$/iu;

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function hasCredentialEnvironment(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter((key) => CREDENTIAL_ENVIRONMENT_KEY.test(key)).sort();
}

function assertNoCredentialEnvironment(environment: NodeJS.ProcessEnv): void {
  const unsafe = hasCredentialEnvironment(environment);
  if (unsafe.length) throw new Error(`pilot_fake_rejected_credential_environment:${unsafe.join(",")}`);
}

function exactArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A manually advanced clock for deterministic restart and retry scenarios. */
export class ManualPilotClock {
  private current: number;
  readonly readings: number[] = [];

  constructor(initial = 1_000) {
    if (!Number.isSafeInteger(initial) || initial < 0) throw new Error("Manual clock must start at a non-negative integer");
    this.current = initial;
  }

  now = (): number => {
    this.readings.push(this.current);
    return this.current;
  };

  set(value: number): number {
    if (!Number.isSafeInteger(value) || value < this.current) throw new Error("Manual clock cannot move backwards");
    this.current = value;
    return this.current;
  }

  advance(milliseconds: number): number {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error("Clock advance must be non-negative");
    return this.set(this.current + milliseconds);
  }
}

/** The four-node sequential plan used by the disposable pilot repository. */
export function createSequentialPilotProposal(commandId = "pilot:target"): PlannerProposal {
  if (!commandId.trim()) throw new Error("Pilot target command ID is required");
  const budget = { maxMinutes: 5, maxAttempts: 2, maxTokens: 4_000 };
  const denyScope = [".env*", "**/.env*", ".git/**"];
  return {
    version: 1,
    summary: "Analyze, modify, validate, and report the disposable pilot candidate in order.",
    nodes: [
      {
        id: "analyze-pilot",
        type: "analyze",
        agentId: "pilot-coordinator",
        dependsOn: [],
        objective: "Analyze the confirmed disposable pilot change.",
        inputEvidence: ["snapshot:goal", "snapshot:acceptance"],
        instructions: "Use only the durable Work Item snapshot and declared repository scope.",
        readScope: ["**/*"],
        writeScope: [],
        denyScope,
        commands: [],
        expectedArtifacts: ["pilot-analysis"],
        completionDefinition: "The allowed change and its deterministic observation are identified.",
        risk: "low",
        budget,
      },
      {
        id: "modify-pilot",
        type: "modify",
        agentId: "pilot-developer",
        dependsOn: ["analyze-pilot"],
        objective: "Apply the allowlisted change inside the managed worktree.",
        inputEvidence: ["node:analyze-pilot"],
        instructions: "Modify only the allowlisted fixture path; do not invoke Git or network tools.",
        readScope: ["**/*"],
        writeScope: ["src/**"],
        denyScope,
        commands: [],
        expectedArtifacts: ["local-candidate"],
        completionDefinition: "The runtime can create a traceable local candidate commit from the changed file.",
        risk: "low",
        budget,
      },
      {
        id: "validate-pilot",
        type: "validate",
        agentId: "pilot-validator",
        dependsOn: ["modify-pilot"],
        objective: "Run the deterministic allowlisted target check.",
        inputEvidence: ["node:modify-pilot"],
        instructions: "Run only the configured target command through the injected runner.",
        readScope: ["**/*"],
        writeScope: [],
        denyScope,
        commands: [commandId],
        expectedArtifacts: ["target-test-evidence"],
        completionDefinition: "The target check has a captured exit status and containment binding.",
        risk: "low",
        budget,
      },
      {
        id: "report-pilot",
        type: "report",
        agentId: "pilot-coordinator",
        dependsOn: ["validate-pilot"],
        objective: "Report candidate and evidence without claiming merge or deployment.",
        inputEvidence: ["node:validate-pilot"],
        instructions: "Distinguish the local candidate from a merged or deployed result.",
        readScope: [],
        writeScope: [],
        denyScope,
        commands: [],
        expectedArtifacts: ["pilot-status"],
        completionDefinition: "The report links the plan, run, candidate, and target evidence.",
        risk: "low",
        budget,
      },
    ],
  };
}

export class FixedSequentialPilotPlanner implements PlannerPort {
  readonly snapshots: WorkItemSnapshot[] = [];
  private readonly proposal: PlannerProposal;

  constructor(proposal: PlannerProposal = createSequentialPilotProposal()) {
    this.proposal = structuredClone(proposal);
  }

  propose(snapshot: WorkItemSnapshot): unknown {
    this.snapshots.push(structuredClone(snapshot));
    return structuredClone(this.proposal);
  }
}

interface IssuedProof {
  bindingHash: string;
  fingerprint: string;
  state: "active" | "empty";
}

/**
 * Cryptographically binding but entirely fake containment authority. It proves
 * control-flow wiring and replay rejection only; it does not provide OS isolation.
 */
export class VerifiableFakeContainment implements ContainmentPort {
  readonly productionSafe = false;
  readonly issued: Array<{ proof: ContainmentProof; binding: ContainmentBinding }> = [];
  readonly verificationCalls: Array<{ proof: ContainmentProof; expectedBinding: ContainmentBinding }> = [];
  readonly inspectionCalls: RuntimeIdentity[] = [];
  readonly terminationCalls: RuntimeIdentity[] = [];
  private readonly key: Buffer;
  private readonly proofs = new Map<string, IssuedProof>();
  private sequence = 0;

  constructor(key = "openmausbot-nonproduction-pilot-fake-containment-v1") {
    this.key = createHash("sha256").update(key, "utf8").digest();
  }

  issueProof(binding: ContainmentBinding): ContainmentProof {
    this.sequence += 1;
    const bindingHash = containmentBindingHash(binding);
    const identity: RuntimeIdentity = {
      backend: "pilot_fake_containment",
      opaqueId: createHash("sha256").update(`${bindingHash}:${this.sequence}`).digest("hex"),
      hostGeneration: "pilot-host-generation-1",
      verifierVersion: "pilot-fake-v1",
    };
    const fingerprint = runtimeIdentityFingerprint(identity);
    const receipt = createHmac("sha256", this.key).update(`${bindingHash}:${fingerprint}`, "utf8").digest("hex");
    const proof = { identity, receipt };
    this.proofs.set(fingerprint, { bindingHash, fingerprint, state: "active" });
    this.issued.push({ proof: structuredClone(proof), binding: structuredClone(binding) });
    return proof;
  }

  markEmpty(identity: RuntimeIdentity): void {
    const fingerprint = runtimeIdentityFingerprint(identity);
    const issued = this.proofs.get(fingerprint);
    if (!issued) throw new Error("Unknown fake containment identity");
    issued.state = "empty";
  }

  async verifyProof(
    proof: ContainmentProof,
    expectedBinding: ContainmentBinding,
  ): Promise<VerifiedContainmentProof | { verified: false; reason: string }> {
    this.verificationCalls.push({ proof: structuredClone(proof), expectedBinding: structuredClone(expectedBinding) });
    const fingerprint = runtimeIdentityFingerprint(proof.identity);
    const issued = this.proofs.get(fingerprint);
    if (!issued) return { verified: false, reason: "pilot_fake_proof_unknown" };
    const bindingHash = containmentBindingHash(expectedBinding);
    if (issued.bindingHash !== bindingHash) return { verified: false, reason: "pilot_fake_binding_replay" };
    const expected = createHmac("sha256", this.key).update(`${bindingHash}:${fingerprint}`, "utf8").digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(proof.receipt, "hex");
    } catch {
      return { verified: false, reason: "pilot_fake_receipt_invalid" };
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { verified: false, reason: "pilot_fake_receipt_invalid" };
    }
    return { verified: true, fingerprint, bindingHash };
  }

  async inspect(identity: RuntimeIdentity): Promise<ContainmentInspection> {
    this.inspectionCalls.push(structuredClone(identity));
    const fingerprint = runtimeIdentityFingerprint(identity);
    const issued = this.proofs.get(fingerprint);
    return issued
      ? { state: issued.state, fingerprint }
      : { state: "unknown", reason: "pilot_fake_identity_unknown" };
  }

  async terminateAndWaitEmpty(identity: RuntimeIdentity): Promise<ContainmentInspection> {
    this.terminationCalls.push(structuredClone(identity));
    const fingerprint = runtimeIdentityFingerprint(identity);
    const issued = this.proofs.get(fingerprint);
    if (!issued) return { state: "unknown", reason: "pilot_fake_identity_unknown" };
    issued.state = "empty";
    return { state: "empty", fingerprint };
  }
}

export interface PilotFileMutation {
  path: string;
  contents: string | Uint8Array;
}

export interface ScriptedPilotAgentOptions {
  containment: VerifiableFakeContainment;
  mutations: readonly PilotFileMutation[];
  events?: readonly Omit<AgentRunEvent, "threadId" | "turnId">[];
  resultStatus?: AgentRunResult["status"];
}

/**
 * Applies fixture mutations only. CandidateExecutor, not the fake provider,
 * creates the local commit after validating the diff; this preserves the real
 * AgentRunPort contract (`capabilities.gitCommit === false`).
 */
export class ScriptedPilotAgent implements AgentRunPort {
  readonly productionSafe = false;
  readonly requests: AgentRunRequest[] = [];
  readonly interrupted: string[] = [];
  readonly evidence: Array<{
    runId: string;
    cwd: string;
    changedPaths: string[];
    environmentKeys: string[];
    emitted: AgentRunEvent[];
    invokedGit: false;
    remotePushes: 0;
  }> = [];
  private readonly containment: VerifiableFakeContainment;
  private readonly mutations: readonly PilotFileMutation[];
  private readonly events: readonly Omit<AgentRunEvent, "threadId" | "turnId">[];
  private readonly resultStatus: AgentRunResult["status"];

  constructor(options: ScriptedPilotAgentOptions) {
    this.containment = options.containment;
    this.mutations = options.mutations.map((mutation) => ({ ...mutation }));
    this.events = options.events ?? [
      { type: "progress", message: "pilot_fixture_change_started" },
      { type: "result", message: "pilot_fixture_change_complete" },
    ];
    this.resultStatus = options.resultStatus ?? "completed";
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    assertNoCredentialEnvironment(request.environment);
    if (request.capabilities.network || request.capabilities.arbitraryCommands || request.capabilities.gitCommit) {
      throw new Error("pilot_fake_requires_all_dangerous_capabilities_disabled");
    }
    if (request.sandbox.network !== "deny" || !request.sandbox.denyGitMetadata) {
      throw new Error("pilot_fake_requires_fail_closed_sandbox_request");
    }
    const root = realpathSync(request.cwd);
    if (root !== realpathSync(request.sandbox.filesystemRoot)) throw new Error("pilot_fake_worktree_binding_mismatch");
    const proof = this.containment.issueProof(request.containmentBinding);
    await request.registerContainment(proof);
    const changedPaths: string[] = [];
    for (const mutation of this.mutations) {
      if (!mutation.path || isAbsolute(mutation.path) || mutation.path.split(/[\\/]/u).includes("..")) {
        throw new Error(`pilot_fake_mutation_path_invalid:${mutation.path}`);
      }
      if (mutation.path === ".git" || mutation.path.startsWith(".git/") || /(?:^|\/)\.env(?:\.|$)/u.test(mutation.path)) {
        throw new Error(`pilot_fake_mutation_path_denied:${mutation.path}`);
      }
      if (!request.writeScope.some((scope) => pathMatchesScope(mutation.path, scope))) {
        throw new Error(`pilot_fake_mutation_outside_write_scope:${mutation.path}`);
      }
      const target = resolve(root, mutation.path);
      if (!contained(root, target)) throw new Error(`pilot_fake_mutation_escaped:${mutation.path}`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const parent = realpathSync(dirname(target));
      if (!contained(root, parent)) throw new Error(`pilot_fake_mutation_parent_escaped:${mutation.path}`);
      try {
        if (lstatSync(target).isSymbolicLink()) throw new Error(`pilot_fake_mutation_symlink_denied:${mutation.path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      writeFileSync(target, mutation.contents, { mode: 0o600 });
      changedPaths.push(mutation.path);
    }
    const emitted = this.events.map((event) => ({ ...event, threadId: request.threadId, turnId: request.turnId }));
    for (const event of emitted) request.emit(event);
    this.containment.markEmpty(proof.identity);
    this.evidence.push({
      runId: request.runId,
      cwd: root,
      changedPaths: [...changedPaths],
      environmentKeys: Object.keys(request.environment).sort(),
      emitted: structuredClone(emitted),
      invokedGit: false,
      remotePushes: 0,
    });
    return {
      threadId: request.threadId,
      turnId: request.turnId,
      status: this.resultStatus,
      sandboxEnforced: true,
      containmentProof: proof,
    };
  }

  async interrupt(runId: string): Promise<void> {
    this.interrupted.push(runId);
  }
}

function pathMatchesScope(path: string, scope: string): boolean {
  if (scope === "**/*" || scope === "**") return true;
  if (scope.endsWith("/**")) return path === scope.slice(0, -3) || path.startsWith(scope.slice(0, -2));
  if (!scope.includes("*")) return path === scope;
  const escaped = scope.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`, "u").test(path);
}

export interface AllowedPilotCommand {
  argv: readonly [string, ...string[]];
  cwd?: string;
}

/** An exact-argv, shell-free command runner for disposable pilot fixtures. */
export class AllowlistedPilotCommandRunner implements SandboxedCommandRunner {
  readonly productionSafe = false;
  readonly requests: Array<{
    commandId: string;
    argv: string[];
    cwd: string;
    environmentKeys: string[];
  }> = [];
  private readonly containment: VerifiableFakeContainment;
  private readonly worktreeRoot: string;
  private readonly commands: Readonly<Record<string, AllowedPilotCommand>>;

  constructor(input: {
    containment: VerifiableFakeContainment;
    worktreeRoot: string;
    commands: Readonly<Record<string, AllowedPilotCommand>>;
  }) {
    this.containment = input.containment;
    this.worktreeRoot = realpathSync(input.worktreeRoot);
    this.commands = input.commands;
  }

  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    const allowed = this.commands[request.commandId];
    if (!allowed || !exactArgv(request.argv, allowed.argv)) throw new Error(`pilot_command_not_allowlisted:${request.commandId}`);
    assertNoCredentialEnvironment(request.environment);
    const executable = request.argv[0].split(/[\\/]/u).at(-1) ?? "";
    if (REMOTE_OR_NETWORK_EXECUTABLE.test(executable)) throw new Error(`pilot_command_executable_denied:${executable}`);
    const cwd = realpathSync(request.cwd);
    if (!contained(this.worktreeRoot, cwd) || !contained(realpathSync(request.sandbox.writableRoot), cwd)) {
      throw new Error("pilot_command_cwd_outside_worktree");
    }
    if (allowed.cwd && realpathSync(resolve(this.worktreeRoot, allowed.cwd)) !== cwd) {
      throw new Error("pilot_command_cwd_mismatch");
    }
    if (request.sandbox.network !== "deny") throw new Error("pilot_command_network_must_be_denied");
    this.requests.push({
      commandId: request.commandId,
      argv: [...request.argv],
      cwd,
      environmentKeys: Object.keys(request.environment).sort(),
    });
    const proof = this.containment.issueProof(request.containmentBinding);
    await request.registerContainment(proof);
    const startedAt = Date.now();
    let exitCode = 0;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputLimitExceeded = false;
    try {
      const result = await execFileAsync(request.argv[0], request.argv.slice(1), {
        cwd,
        env: request.environment,
        encoding: "buffer",
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
        windowsHide: true,
        shell: false,
      });
      stdout = Buffer.from(result.stdout);
      stderr = Buffer.from(result.stderr);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        code?: string | number;
        killed?: boolean;
        stdout?: Buffer;
        stderr?: Buffer;
      };
      stdout = Buffer.from(failure.stdout ?? Buffer.alloc(0));
      stderr = Buffer.from(failure.stderr ?? Buffer.alloc(0));
      timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
      outputLimitExceeded = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      exitCode = typeof failure.code === "number" ? failure.code : timedOut || outputLimitExceeded ? 1 : 127;
    } finally {
      this.containment.markEmpty(proof.identity);
    }
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Math.max(1, Date.now() - startedAt),
      timedOut,
      outputLimitExceeded,
      attestation: {
        sandboxEnforced: true,
        writableRoot: request.sandbox.writableRoot,
        deniedPaths: [...request.sandbox.deniedPaths],
        network: "deny",
        processIsolated: true,
        processTreeReaped: true,
        containmentProof: proof,
      },
    };
  }
}

export type PilotDeliveryResult = Awaited<ReturnType<OutboxDeliveryPort["deliver"]>>;
export type PilotDeliveryMessage = Parameters<OutboxDeliveryPort["deliver"]>[0];

export class ScriptedPilotOutboxDelivery implements OutboxDeliveryPort {
  readonly calls: PilotDeliveryMessage[] = [];
  readonly attemptsByDedupeKey = new Map<string, number>();
  private readonly results: PilotDeliveryResult[];
  private readonly fallback: PilotDeliveryResult;

  constructor(
    results: readonly PilotDeliveryResult[] = [],
    fallback: PilotDeliveryResult = { outcome: "sent", transportId: "pilot-transport" },
  ) {
    this.results = results.map((result) => ({ ...result }));
    this.fallback = { ...fallback };
  }

  async deliver(message: PilotDeliveryMessage): Promise<PilotDeliveryResult> {
    this.calls.push(structuredClone(message));
    this.attemptsByDedupeKey.set(message.dedupeKey, (this.attemptsByDedupeKey.get(message.dedupeKey) ?? 0) + 1);
    return { ...(this.results.shift() ?? this.fallback) };
  }
}

export class RecordingPilotPrivateAlerts implements PrivateOwnerAlertPort {
  readonly calls: SafeOperationalAlert[] = [];
  private failuresRemaining: number;

  constructor(failures = 0) {
    this.failuresRemaining = failures;
  }

  async alert(input: SafeOperationalAlert): Promise<void> {
    this.calls.push(structuredClone(input));
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("pilot_private_alert_temporary_failure");
    }
  }
}

export class ScriptedPilotDiskCapacity implements DiskCapacityPort {
  readonly paths: string[] = [];
  private readonly values: Array<DiskCapacity | Error>;
  private readonly fallback: DiskCapacity;

  constructor(
    values: readonly (DiskCapacity | Error)[] = [],
    fallback: DiskCapacity = { availableBytes: 8_000_000_000n, totalBytes: 10_000_000_000n },
  ) {
    this.values = [...values];
    this.fallback = { ...fallback };
  }

  capacity(path: string): DiskCapacity {
    this.paths.push(path);
    const value = this.values.shift() ?? this.fallback;
    if (value instanceof Error) throw value;
    return { ...value };
  }
}

export function pilotCredentialEnvironmentKeys(environment: NodeJS.ProcessEnv): string[] {
  return hasCredentialEnvironment(environment);
}
