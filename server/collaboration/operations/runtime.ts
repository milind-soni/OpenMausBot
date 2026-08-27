import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DingTalkCredentialProvider, DingTalkCredentials } from "../../integrations/dingtalk/config.ts";
import type { DingTalkCardAction, DingTalkInboundMessage } from "../../integrations/dingtalk/types.ts";
import type { OwnerActionOutcome } from "../actions.ts";
import {
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
  verifyContainmentProof,
} from "../containment.ts";
import type { CandidateExecutorOptions, CandidateExecutionOutcome } from "../executor.ts";
import type { PlanningPolicy } from "../graph.ts";
import type { InboundMessageOutcome } from "../inbound.ts";
import { InstanceLeaseCoordinator, type InstanceLease } from "../leases.ts";
import { OutboxDispatcher, type DispatchOutcome, type OutboxDispatcherOptions } from "../outbox-dispatcher.ts";
import type { OutboxDeliveryPort } from "../outbox.ts";
import type { PlannerPort } from "../planner.ts";
import type { AgentRunPort } from "../provider-runner.ts";
import type { SandboxedCommandRunner } from "../quality-gate.ts";
import { type CandidateInspectionPort, RecoveryCoordinator, type RecoveryDecision } from "../recovery.ts";
import {
  startCollaborationService,
  type CollaborationHealth,
  type CollaborationService,
  type CollaborationServiceOptions,
} from "../service.ts";
import { UnavailableContainmentSupervisor } from "./containment-supervisor.ts";

export type CollaborationRuntimeState = "starting" | "running" | "draining" | "degraded" | "stopped";

export interface RuntimeClock {
  now(): number;
}

export interface RuntimeLogEvent {
  event: string;
  code?: string;
  state?: CollaborationRuntimeState;
  recoveryCount?: number;
}

export interface RuntimeLogger {
  write(event: RuntimeLogEvent): void;
}

export interface RuntimeStream {
  start(): Promise<"connected" | "reconnecting">;
  stop(): void | Promise<void>;
  state(): string;
}

export interface RuntimeDingTalkSinks {
  ingest(message: DingTalkInboundMessage): InboundMessageOutcome;
  perform(action: DingTalkCardAction): OwnerActionOutcome;
}

export type RuntimeStreamFactory = (
  credentials: DingTalkCredentials,
  sinks: RuntimeDingTalkSinks,
  logger: RuntimeLogger,
) => RuntimeStream;

export interface RuntimeMaintenancePort {
  run(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): void | Promise<void>;
}

export interface RuntimeMaintenanceContext {
  database: DatabaseSync;
  dataDirectory: string;
}

export type RuntimeExecutionConfiguration = Omit<
  CandidateExecutorOptions,
  "agent" | "containment" | "commandRunner" | "scheduler"
>;

export interface CollaborationHeadlessRuntimeOptions {
  dataDirectory: string;
  ownerId?: string;
  instanceLeaseTtlMs?: number;
  shutdownTimeoutMs?: number;
  clock?: RuntimeClock;
  logger?: RuntimeLogger;
  platform?: NodeJS.Platform;
  /** Opens and validates configuration without leasing, recovering, streaming, dispatching, or maintaining. */
  probeOnly?: boolean;
  planner?: PlannerPort;
  planningPolicy?: PlanningPolicy;
  agent?: AgentRunPort;
  containment?: ContainmentPort;
  commandRunner?: SandboxedCommandRunner;
  execution?: RuntimeExecutionConfiguration;
  candidateInspector?: CandidateInspectionPort;
  recoveryMaxAttempts?: number;
  outboxDelivery?: OutboxDeliveryPort;
  outbox?: Partial<OutboxDispatcherOptions>;
  maintenance?: RuntimeMaintenancePort;
  maintenanceFactory?: (context: RuntimeMaintenanceContext) => RuntimeMaintenancePort;
  dingTalk?: {
    enabled: boolean;
    credentials: DingTalkCredentialProvider;
    createStream: RuntimeStreamFactory;
  };
}

export interface CollaborationRuntimeHealth {
  app: "openmausbot-collaboration";
  sourceBaseline?: CollaborationHealth["sourceBaseline"];
  authority?: "headless";
  defaults?: CollaborationHealth["defaults"];
  state: CollaborationRuntimeState;
  status: "healthy" | "degraded" | "stopped";
  ready: boolean;
  reason?: string;
  database?: CollaborationHealth["database"];
  instanceLease: "held" | "not_held";
  dingtalk: {
    enabled: boolean;
    state: "disabled" | "configured" | "connected" | "reconnecting" | "needs_configuration" | "stopped";
  };
  executionMode: "execute" | "observe_plan_only" | "not_configured";
}

export interface DrainOutcome {
  dispatched: DispatchOutcome | null;
  maintained: boolean;
}

interface UnresolvedRun {
  id: string;
  work_item_id: string;
  plan_revision: number;
  node_id: string;
  worktree_path: string;
  runtime_identity_json: string | null;
  containment_binding_json: string | null;
  containment_fingerprint: string | null;
}

const SYSTEM_CLOCK: RuntimeClock = { now: Date.now };
const NULL_LOGGER: RuntimeLogger = { write() {} };

class NoCandidateInspector implements CandidateInspectionPort {
  async inspect() {
    return { complete: false, resultSha: null, reason: "candidate_inspector_unavailable" };
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function safeConfigurationReason(error: unknown): string {
  if (error instanceof Error && error.message === "restore_review_required") return error.message;
  return "dingtalk_credentials_invalid";
}

async function waitBounded(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, milliseconds));
    void promise.then(() => finish(true), () => finish(true));
  });
}

async function resultBounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { completed: true; value: T } | { completed: false }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ completed: false }), Math.max(1, milliseconds));
    void promise.then(
      (value) => finish({ completed: true, value }),
      () => finish({ completed: false }),
    );
  });
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class CollaborationHeadlessRuntime {
  private readonly options: CollaborationHeadlessRuntimeOptions;
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly clock: RuntimeClock;
  private readonly logger: RuntimeLogger;
  private readonly platform: NodeJS.Platform;
  private currentState: CollaborationRuntimeState = "stopped";
  private reason: string | null = null;
  private service: CollaborationService | null = null;
  private database: DatabaseSync | null = null;
  private leaseCoordinator: InstanceLeaseCoordinator | null = null;
  private lease: InstanceLease | null = null;
  private dispatcher: OutboxDispatcher | null = null;
  private maintenance: RuntimeMaintenancePort | null = null;
  private stream: RuntimeStream | null = null;
  private dingTalkState: CollaborationRuntimeHealth["dingtalk"]["state"];
  private drainPromise: Promise<DrainOutcome> | null = null;
  private stopPromise: Promise<CollaborationRuntimeHealth> | null = null;
  private readonly activeExecutions = new Set<Promise<unknown>>();
  private recoveryDecisions: RecoveryDecision[] = [];

  constructor(options: CollaborationHeadlessRuntimeOptions) {
    this.options = options;
    this.ownerId = options.ownerId?.trim() || `headless:${randomUUID()}`;
    this.leaseTtlMs = positiveInteger(options.instanceLeaseTtlMs ?? 30_000, "instanceLeaseTtlMs");
    this.shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs ?? 10_000, "shutdownTimeoutMs");
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.logger = options.logger ?? NULL_LOGGER;
    this.platform = options.platform ?? process.platform;
    this.dingTalkState = options.dingTalk?.enabled ? "stopped" : "disabled";
    if ((options.planner && !options.planningPolicy) || (!options.planner && options.planningPolicy)) {
      throw new Error("planner and planningPolicy must be configured together");
    }
    if (options.maintenance && options.maintenanceFactory) {
      throw new Error("maintenance and maintenanceFactory are mutually exclusive");
    }
    const executionParts = [options.agent, options.containment, options.commandRunner, options.execution];
    if (executionParts.some(Boolean) && !executionParts.every(Boolean) && (options.agent || options.commandRunner || options.execution)) {
      throw new Error("agent, containment, commandRunner, and execution must be configured together");
    }
  }

  async start(): Promise<CollaborationRuntimeHealth> {
    if (this.currentState !== "stopped" || this.service || this.database) {
      throw new Error("collaboration_runtime_already_started");
    }
    this.currentState = "starting";
    this.reason = null;
    this.logger.write({ event: "collaboration.runtime.starting", state: this.currentState });
    try {
      const serviceOptions: CollaborationServiceOptions = {
        dataDirectory: this.options.dataDirectory,
        ...(this.options.planner && this.options.planningPolicy
          ? { planning: { planner: this.options.planner, policy: this.options.planningPolicy } }
          : {}),
        ...(this.executionEnabled()
          ? {
              execution: {
                ...this.options.execution!,
                agent: this.options.agent!,
                containment: this.options.containment!,
                commandRunner: this.options.commandRunner!,
                scheduler: { ownerId: this.ownerId, leaseTtlMs: this.leaseTtlMs },
              },
            }
          : {}),
      };
      this.service = startCollaborationService(serviceOptions);
      this.database = new DatabaseSync(join(this.options.dataDirectory, "collaboration", "collaboration.sqlite"));
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      if (this.options.probeOnly) {
        const initialHealth = this.service.health();
        if (!initialHealth.ready) this.reason = initialHealth.degradation?.reason ?? "service_not_ready";
        if (!this.reason) await this.probeDingTalk();
        this.currentState = this.reason ? "degraded" : "running";
        this.logger.write({
          event: "collaboration.runtime.probed",
          state: this.currentState,
          ...(this.reason ? { code: this.reason } : {}),
        });
        return this.health();
      }
      this.leaseCoordinator = new InstanceLeaseCoordinator(this.database, this.ownerId);
      this.lease = this.leaseCoordinator.acquire(this.clock.now(), this.leaseTtlMs);
      if (!this.lease) throw new Error("instance_lease_unavailable");
      this.maintenance = this.options.maintenanceFactory
        ? this.options.maintenanceFactory({ database: this.database, dataDirectory: this.options.dataDirectory })
        : (this.options.maintenance ?? null);

      if (this.options.outboxDelivery) {
        this.dispatcher = new OutboxDispatcher(this.database, this.options.outboxDelivery, {
          maxAttempts: this.options.outbox?.maxAttempts ?? 5,
          claimTtlMs: this.options.outbox?.claimTtlMs ?? 30_000,
          baseBackoffMs: this.options.outbox?.baseBackoffMs ?? 1_000,
          maxBackoffMs: this.options.outbox?.maxBackoffMs ?? 60_000,
          ...(this.options.outbox?.jitter ? { jitter: this.options.outbox.jitter } : {}),
        });
      }

      const initialHealth = this.service.health();
      if (!initialHealth.ready) {
        this.reason = initialHealth.degradation?.reason ?? "service_not_ready";
      } else {
        await this.recoverAtStartup();
      }
      if (!this.reason) await this.startDingTalk();
      if (!this.reason && !this.service.health().ready) {
        this.reason = this.service.health().degradation?.reason ?? "service_not_ready";
      }
      this.currentState = this.reason ? "degraded" : "running";
      this.logger.write({
        event: "collaboration.runtime.started",
        state: this.currentState,
        ...(this.reason ? { code: this.reason } : {}),
        recoveryCount: this.recoveryDecisions.length,
      });
      return this.health();
    } catch (error) {
      const code = error instanceof Error ? error.message : "runtime_start_failed";
      this.reason = code === "instance_lease_unavailable" ? code : "runtime_start_failed";
      this.currentState = "degraded";
      this.logger.write({ event: "collaboration.runtime.start_failed", code: this.reason, state: this.currentState });
      await this.closeResources();
      throw error;
    }
  }

  health(): CollaborationRuntimeHealth {
    let collaborationHealth: CollaborationHealth | null = null;
    try {
      collaborationHealth = this.service?.health() ?? null;
    } catch {
      collaborationHealth = null;
    }
    const stopped = this.currentState === "stopped";
    let lowDisk = false;
    try {
      const row = this.database
        ?.prepare("SELECT low_disk FROM collaboration_runtime_state WHERE singleton = 1")
        .get() as { low_disk: number } | undefined;
      lowDisk = row?.low_disk === 1;
    } catch {
      lowDisk = false;
    }
    const reason =
      this.reason ??
      collaborationHealth?.degradation?.reason ??
      (lowDisk || collaborationHealth?.executionGated === "low_disk" ? "low_disk" : null);
    const ready =
      this.currentState === "running" &&
      !reason &&
      collaborationHealth?.ready === true &&
      (this.options.probeOnly === true || !!this.lease);
    return {
      app: "openmausbot-collaboration",
      state: this.currentState,
      status: stopped ? "stopped" : ready ? "healthy" : "degraded",
      ready,
      ...(reason ? { reason } : {}),
      ...(collaborationHealth ? { database: collaborationHealth.database } : {}),
      ...(collaborationHealth
        ? {
            sourceBaseline: collaborationHealth.sourceBaseline,
            authority: collaborationHealth.authority,
            defaults: collaborationHealth.defaults,
          }
        : {}),
      instanceLease: this.lease ? "held" : "not_held",
      dingtalk: { enabled: this.options.dingTalk?.enabled === true, state: this.dingTalkState },
      executionMode: this.platform === "darwin"
        ? "observe_plan_only"
        : this.executionEnabled()
          ? "execute"
          : "not_configured",
    };
  }

  recovery(): readonly RecoveryDecision[] {
    return this.recoveryDecisions.map((decision) => ({ ...decision }));
  }

  ingestDingTalkMessage(message: DingTalkInboundMessage): InboundMessageOutcome {
    this.assertAcceptingNewWork();
    return this.service!.ingestDingTalkMessage(message);
  }

  performDingTalkOwnerAction(action: DingTalkCardAction): OwnerActionOutcome {
    this.assertOperational();
    return this.service!.performOwnerAction({
      actionToken: action.actionToken,
      sender: action.sender,
      ...(action.reason ? { reason: action.reason } : {}),
      now: action.receivedAt,
    });
  }

  async executeCurrentPlan(workItemId: string, attempt?: number): Promise<CandidateExecutionOutcome> {
    this.assertAcceptingNewWork();
    if (this.platform === "darwin") throw new Error("execute_unavailable_on_macos");
    const execution = this.service!.executeCurrentPlan(workItemId, attempt, this.clock.now());
    this.activeExecutions.add(execution);
    try {
      return await execution;
    } finally {
      this.activeExecutions.delete(execution);
    }
  }

  async drainOnce(): Promise<DrainOutcome> {
    if (this.drainPromise) return await this.drainPromise;
    this.drainPromise = this.performDrain();
    try {
      return await this.drainPromise;
    } finally {
      this.drainPromise = null;
    }
  }

  async stop(): Promise<CollaborationRuntimeHealth> {
    if (this.stopPromise) return await this.stopPromise;
    if (this.currentState === "stopped" && !this.service && !this.database) return this.health();
    this.stopPromise = this.performStop();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async performStop(): Promise<CollaborationRuntimeHealth> {
    const deadline = Date.now() + this.shutdownTimeoutMs;
    this.currentState = "draining";
    this.logger.write({ event: "collaboration.runtime.draining", state: this.currentState });
    let releaseLease = false;
    try {
      const streamStop = Promise.resolve().then(() => this.stream?.stop());
      if (!(await waitBounded(streamStop, deadline - Date.now()))) this.reason = "shutdown_timeout";
      this.stream = null;
      this.dingTalkState = this.options.dingTalk?.enabled ? "stopped" : "disabled";
      if (this.drainPromise && !(await waitBounded(this.drainPromise, deadline - Date.now()))) {
        this.reason = "shutdown_timeout";
      }
      releaseLease = await this.interruptAndSettleRuns(Math.max(1, deadline - Date.now()));
      if (!releaseLease) this.reason = "shutdown_containment_unverified";
    } catch {
      this.reason = "shutdown_failed";
      releaseLease = false;
    } finally {
      await this.closeResources(releaseLease);
      this.currentState = "stopped";
      this.logger.write({ event: "collaboration.runtime.stopped", state: this.currentState });
    }
    return this.health();
  }

  private executionEnabled(): boolean {
    return (
      this.platform !== "darwin" &&
      !!this.options.agent &&
      !!this.options.containment &&
      !!this.options.commandRunner &&
      !!this.options.execution
    );
  }

  private async recoverAtStartup(): Promise<void> {
    const containment = this.options.containment ?? new UnavailableContainmentSupervisor();
    const candidates = this.options.candidateInspector ?? new NoCandidateInspector();
    try {
      this.recoveryDecisions = await new RecoveryCoordinator(
        this.database!,
        containment,
        candidates,
        positiveInteger(this.options.recoveryMaxAttempts ?? 3, "recoveryMaxAttempts"),
      ).scan(this.lease!, this.clock.now());
    } catch {
      this.reason = "recovery_failed";
    }
  }

  private async startDingTalk(): Promise<void> {
    const configuration = this.options.dingTalk;
    if (!configuration?.enabled) {
      this.dingTalkState = "disabled";
      return;
    }
    let credentials: DingTalkCredentials | null;
    try {
      credentials = configuration.credentials.load();
    } catch (error) {
      this.reason = safeConfigurationReason(error);
      this.dingTalkState = "needs_configuration";
      return;
    }
    if (!credentials) {
      this.reason = "dingtalk_credentials_missing";
      this.dingTalkState = "needs_configuration";
      return;
    }
    try {
      this.stream = configuration.createStream(
        credentials,
        {
          ingest: (message) => this.ingestDingTalkMessage(message),
          perform: (action) => this.performDingTalkOwnerAction(action),
        },
        this.logger,
      );
      const state = await this.stream.start();
      this.dingTalkState = state;
      if (state !== "connected") this.reason = "dingtalk_reconnecting";
    } catch {
      this.stream = null;
      this.reason = "dingtalk_connection_failed";
      this.dingTalkState = "needs_configuration";
    }
  }

  private async probeDingTalk(): Promise<void> {
    const configuration = this.options.dingTalk;
    if (!configuration?.enabled) {
      this.dingTalkState = "disabled";
      return;
    }
    try {
      if (!configuration.credentials.load()) {
        this.reason = "dingtalk_credentials_missing";
        this.dingTalkState = "needs_configuration";
        return;
      }
      this.dingTalkState = "configured";
    } catch (error) {
      this.reason = safeConfigurationReason(error);
      this.dingTalkState = "needs_configuration";
    }
  }

  private async performDrain(): Promise<DrainOutcome> {
    if (this.currentState === "draining" || this.currentState === "stopped") {
      throw new Error("collaboration_runtime_not_accepting_work");
    }
    const now = this.clock.now();
    try {
      this.lease = this.leaseCoordinator!.renew(this.lease!, now, this.leaseTtlMs);
    } catch {
      this.reason = "lease_failed";
      this.currentState = "degraded";
      this.lease = null;
      return { dispatched: null, maintained: false };
    }
    let dispatched: DispatchOutcome | null = null;
    const serviceReady = !this.reason && this.service!.health().ready;
    if (serviceReady && this.dispatcher) dispatched = await this.dispatcher.dispatchOne(this.lease, now);
    let maintained = false;
    if (serviceReady && this.maintenance) {
      await this.maintenance.run(this.lease, now);
      maintained = true;
    }
    return { dispatched, maintained };
  }

  private assertOperational(): void {
    if (this.currentState !== "running" || this.reason || !this.service) {
      throw new Error("collaboration_runtime_not_accepting_work");
    }
  }

  private assertAcceptingNewWork(): void {
    this.assertOperational();
    const row = this.database
      ?.prepare("SELECT low_disk FROM collaboration_runtime_state WHERE singleton = 1")
      .get() as { low_disk: number } | undefined;
    if (row?.low_disk === 1) throw new Error("collaboration_runtime_low_disk");
  }

  private async interruptAndSettleRuns(timeoutMs: number): Promise<boolean> {
    if (!this.database || !this.lease) return true;
    const deadline = Date.now() + timeoutMs;
    const now = this.clock.now();
    const rows = this.database
      .prepare(
        "SELECT id FROM collaboration_runs WHERE status = 'running' AND instance_owner = ? AND instance_fence = ?",
      )
      .all(this.lease.ownerId, this.lease.fence) as unknown as Array<{ id: string }>;
    this.database
      .prepare(
        "UPDATE collaboration_runs SET interrupt_requested_at = COALESCE(interrupt_requested_at, ?), " +
          "version = version + 1 WHERE status = 'running' AND instance_owner = ? AND instance_fence = ?",
      )
      .run(now, this.lease.ownerId, this.lease.fence);
    const interrupts = this.options.agent
      ? Promise.allSettled(rows.map((row) => Promise.resolve().then(() => this.options.agent!.interrupt(row.id))))
      : Promise.resolve([]);
    const shutdownWork = interrupts.then(async () => {
      await Promise.allSettled([...this.activeExecutions]);
    });
    if (!(await waitBounded(shutdownWork, timeoutMs))) this.reason = "shutdown_timeout";
    const unresolved = this.database
      .prepare(
        "SELECT id, work_item_id, plan_revision, node_id, worktree_path, runtime_identity_json, " +
          "containment_binding_json, containment_fingerprint FROM collaboration_runs " +
          "WHERE status = 'running' AND instance_owner = ? AND instance_fence = ?",
      )
      .all(this.lease.ownerId, this.lease.fence) as unknown as UnresolvedRun[];
    const containmentEmpty = await this.terminateUnresolvedContainment(unresolved, deadline);
    for (const row of unresolved) {
      this.database
        .prepare(
          "UPDATE collaboration_runs SET status = 'needs_configuration', recovery_state = 'unsafe_to_retry', " +
            "finished_at = ?, error = 'shutdown_unsettled', version = version + 1 WHERE id = ? AND status = 'running'",
        )
        .run(now, row.id);
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET runtime_state = 'needs_configuration', lease_owner = NULL, " +
            "lease_expires_at = NULL, version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ?",
        )
        .run(row.work_item_id, row.plan_revision, row.node_id);
    }
    return containmentEmpty;
  }

  private async terminateUnresolvedContainment(rows: readonly UnresolvedRun[], deadline: number): Promise<boolean> {
    if (rows.length === 0) return true;
    const containment = this.options.containment;
    if (!containment || !this.lease) return false;
    let allEmpty = true;
    for (const row of rows) {
      const proof = parseJson<ContainmentProof>(row.runtime_identity_json);
      const binding = parseJson<ContainmentBinding>(row.containment_binding_json);
      if (
        !proof ||
        !binding ||
        binding.runId !== row.id ||
        binding.canonicalWorktreePath !== row.worktree_path ||
        binding.instanceOwner !== this.lease.ownerId ||
        binding.instanceFence !== this.lease.fence
      ) {
        allEmpty = false;
        continue;
      }
      const verifiedResult = await resultBounded(
        verifyContainmentProof(containment, proof, binding),
        Math.max(1, deadline - Date.now()),
      );
      if (
        !verifiedResult.completed ||
        !verifiedResult.value.verified ||
        verifiedResult.value.fingerprint !== row.containment_fingerprint
      ) {
        allEmpty = false;
        continue;
      }
      const terminated = await resultBounded(
        containment.terminateAndWaitEmpty(proof.identity),
        Math.max(1, deadline - Date.now()),
      );
      if (
        !terminated.completed ||
        terminated.value.state !== "empty" ||
        terminated.value.fingerprint !== verifiedResult.value.fingerprint
      ) {
        allEmpty = false;
      }
    }
    return allEmpty;
  }

  private async closeResources(releaseLease = true): Promise<void> {
    if (releaseLease && this.leaseCoordinator && this.lease) {
      try {
        this.leaseCoordinator.release(this.lease, this.clock.now());
      } catch {}
    }
    this.lease = null;
    this.leaseCoordinator = null;
    this.dispatcher = null;
    this.maintenance = null;
    try {
      this.database?.close();
    } catch {}
    this.database = null;
    try {
      this.service?.close();
    } catch {}
    this.service = null;
  }
}
