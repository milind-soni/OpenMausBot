import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DingTalkCredentialProvider, DingTalkCredentials } from "../../integrations/dingtalk/config.ts";
import type {
  DingTalkCardAction,
  DingTalkInboundMessage,
  DingTalkOwnerTextCommand,
  DingTalkOwnerTextCommandOutcome,
} from "../../integrations/dingtalk/types.ts";
import type { DirectOwnerControlAction, OwnerActionOutcome } from "../actions.ts";
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
import { enqueueInboundCard, type OutboxDeliveryPort } from "../outbox.ts";
import { renderCommandStatusCard, renderPlanStatusCard } from "../message-renderer.ts";
import { evaluateOwnerPolicy } from "../policy.ts";
import type { PlannerPort } from "../planner.ts";
import type { AcceptanceCondition } from "../snapshot.ts";
import { renderCandidateDiffPreview } from "../candidate-preview.ts";
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
  performCommand(command: DingTalkOwnerTextCommand): DingTalkOwnerTextCommandOutcome;
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
  executionIsolation?: "native_linux" | "docker_linux";
  autoExecuteReady?: boolean;
  /** Opens and validates configuration without leasing, recovering, streaming, dispatching, or maintaining. */
  probeOnly?: boolean;
  planner?: PlannerPort;
  planningPolicy?: PlanningPolicy;
  planningDefaultDefinition?: { repository: string; acceptanceConditions: AcceptanceCondition[] };
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
    cardTemplateId?: string;
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
const CANDIDATE_READY_SUMMARY = "修改已完成并通过验证，请确认结果是否符合需求。";
const DIRECT_TEXT_ACTIONS: Readonly<Partial<Record<DingTalkOwnerTextCommand["command"], DirectOwnerControlAction>>> = {
  pause: "pause",
  resume: "resume",
  retry: "retry",
  cancel: "cancel",
};

function commandSummary(command: DingTalkOwnerTextCommand["command"], allowed: boolean, reason: string): string {
  if (allowed) return ({
    status: "已返回任务当前状态。",
    pause: "任务已暂停；正在运行的执行会收到中断请求。",
    resume: "任务已恢复；符合条件的节点将继续执行。",
    retry: "任务已重新进入受控执行队列。",
    cancel: "任务已取消，不会再产生新的执行结果。",
    refresh_approval: "已重新生成当前候选的验收指令。",
  } as const)[command];
  const guidance: Readonly<Record<string, string>> = {
    not_active_owner: "只有当前唯一负责人可以执行该操作。",
    owner_not_configured: "尚未配置唯一负责人，请先完成 Owner 绑定。",
    stable_identity_required: "无法确认稳定的钉钉身份，本次操作未执行。",
    unknown_work_item: "未找到该任务，请检查任务编号。",
    work_item_not_active: "任务当前不处于可暂停状态。",
    work_item_not_paused: "任务当前不处于暂停状态。",
    work_item_not_retryable: "任务当前没有可重试的失败结果。",
    work_item_already_accepted: "任务已经验收完成，无需重复操作。",
    work_item_cancelled: "任务已经取消，不能执行该操作。",
    candidate_not_current: "当前没有可验收候选，请先查询任务状态。",
  };
  return guidance[reason] ?? "当前状态不允许执行该操作，请先查询任务状态。";
}

export function enqueueExecutionOutcomeStatus(input: {
  database: DatabaseSync;
  cardTemplateId?: string;
  outcome: CandidateExecutionOutcome;
  now: number;
}): void {
  const passed = input.outcome.report.state === "target_tests_passed" && !!input.outcome.resultSha;
  const candidatePreview = passed
    ? renderCandidateDiffPreview({
        repository: input.outcome.worktreePath,
        baseSha: input.outcome.baseSha,
        resultSha: input.outcome.resultSha!,
        changedPaths: input.outcome.changedPaths,
      })
    : undefined;
  const workItem = passed
    ? input.database
        .prepare("SELECT version FROM collaboration_work_items WHERE id = ?")
        .get(input.outcome.workItemId) as { version: number } | undefined
    : undefined;
  if (passed && !workItem) throw new Error("candidate_owner_decision_work_item_missing");
  let card;
  if (passed && input.cardTemplateId) {
    card = {
      type: "plan_status_card" as const,
      headline: "候选已就绪" as const,
      cardTemplateId: input.cardTemplateId,
      outTrackId: `candidate-${input.outcome.runId}`,
      workItemId: input.outcome.workItemId,
      workItemVersion: workItem!.version,
      status: "candidate_ready" as const,
      summary: CANDIDATE_READY_SUMMARY,
      candidateSha: input.outcome.resultSha!,
      ...(candidatePreview ? { candidatePreview } : {}),
      changedPaths: input.outcome.changedPaths,
      testStates: input.outcome.evidence.map((item) => `${item.commandId}: ${item.state}`),
    };
  } else {
    card = renderPlanStatusCard({
      workItemId: input.outcome.workItemId,
      planRevision: input.outcome.planRevision,
      status: passed ? "candidate_ready" : "execution_failed",
      ...(passed
        ? {
            summary: CANDIDATE_READY_SUMMARY,
            candidateSha: input.outcome.resultSha!,
            ...(candidatePreview ? { candidatePreview } : {}),
            changedPaths: input.outcome.changedPaths,
            testStates: input.outcome.evidence.map((item) => `${item.commandId}: ${item.state}`),
            workItemVersion: workItem!.version,
          }
        : {
            failures: input.outcome.report.reasons.length
              ? input.outcome.report.reasons
              : [input.outcome.report.state],
          }),
    });
  }
  input.database.exec("BEGIN IMMEDIATE");
  try {
    enqueueInboundCard(input.database, {
      sourceEventId: `candidate:${input.outcome.runId}`,
      aggregateType: "plan",
      aggregateId: input.outcome.workItemId,
      aggregateVersion: input.outcome.planRevision,
      card,
      supersessionKey: `work-item:${input.outcome.workItemId}:execution-status`,
      now: input.now,
    });
    input.database.exec("COMMIT");
  } catch (error) {
    input.database.exec("ROLLBACK");
    throw error;
  }
}

export function enqueuePendingOwnerDecisionCards(
  database: DatabaseSync,
  cardTemplateId: string | undefined,
  now: number,
): number {
  const rows = database.prepare(
    "SELECT w.id AS work_item_id, w.version AS work_item_version, w.current_plan_revision AS plan_revision, " +
      "r.id AS run_id, r.repository_path, c.base_sha, c.result_sha, c.changed_paths_json " +
      "FROM collaboration_work_items w " +
      "JOIN collaboration_runs r ON r.work_item_id = w.id AND r.plan_revision = w.current_plan_revision " +
      "JOIN collaboration_candidates c ON c.run_id = r.id " +
      "WHERE w.control_state = 'active' AND w.accepted_candidate_sha IS NULL " +
      "AND r.status = 'succeeded' AND c.state = 'target_tests_passed' AND c.result_sha IS NOT NULL " +
      "AND r.attempt = (SELECT MAX(latest.attempt) FROM collaboration_runs latest " +
      "WHERE latest.work_item_id = w.id AND latest.plan_revision = w.current_plan_revision) " +
      "ORDER BY w.updated_at, w.id",
  ).all() as unknown as Array<{
    work_item_id: string;
    work_item_version: number;
    plan_revision: number;
    run_id: string;
    repository_path: string;
    base_sha: string;
    result_sha: string;
    changed_paths_json: string;
  }>;
  let enqueued = 0;
  for (const row of rows) {
    const sourceEventId = `owner-decision:${row.run_id}:v${row.work_item_version}`;
    if (database.prepare(
      "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
    ).get(sourceEventId)) continue;
    const evidence = database
      .prepare("SELECT command_id, state FROM collaboration_test_evidence WHERE run_id = ? ORDER BY command_id")
      .all(row.run_id) as unknown as Array<{ command_id: string; state: string }>;
    const changedPaths = parseJson<string[]>(row.changed_paths_json) ?? [];
    const candidatePreview = renderCandidateDiffPreview({
      repository: row.repository_path,
      baseSha: row.base_sha,
      resultSha: row.result_sha,
      changedPaths,
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      enqueueInboundCard(database, {
        sourceEventId,
        aggregateType: "plan",
        aggregateId: row.work_item_id,
        aggregateVersion: row.plan_revision,
        card: cardTemplateId
          ? {
              type: "plan_status_card",
              headline: "候选已就绪",
              cardTemplateId,
              outTrackId: `candidate-${row.run_id}`,
              workItemId: row.work_item_id,
              workItemVersion: row.work_item_version,
              planRevision: row.plan_revision,
              status: "candidate_ready",
              summary: CANDIDATE_READY_SUMMARY,
              candidateSha: row.result_sha,
              ...(candidatePreview ? { candidatePreview } : {}),
              changedPaths,
              testStates: evidence.map((item) => `${item.command_id}: ${item.state}`),
            }
          : renderPlanStatusCard({
              workItemId: row.work_item_id,
              workItemVersion: row.work_item_version,
              planRevision: row.plan_revision,
              status: "candidate_ready",
              summary: CANDIDATE_READY_SUMMARY,
              candidateSha: row.result_sha,
              ...(candidatePreview ? { candidatePreview } : {}),
              changedPaths,
              testStates: evidence.map((item) => `${item.command_id}: ${item.state}`),
            }),
        supersessionKey: `work-item:${row.work_item_id}:execution-status`,
        now,
      });
      database.exec("COMMIT");
      enqueued += 1;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return enqueued;
}

export function enqueueOwnerDecisionForWorkItem(
  database: DatabaseSync,
  workItemId: string,
  cardTemplateId: string | undefined,
  sourceEventId: string,
  now: number,
): boolean {
  const row = database.prepare(
    "SELECT w.id AS work_item_id, w.version AS work_item_version, w.current_plan_revision AS plan_revision, " +
      "r.id AS run_id, r.repository_path, c.base_sha, c.result_sha, c.changed_paths_json " +
      "FROM collaboration_work_items w " +
      "JOIN collaboration_runs r ON r.work_item_id = w.id AND r.plan_revision = w.current_plan_revision " +
      "JOIN collaboration_candidates c ON c.run_id = r.id " +
      "WHERE w.id = ? AND w.control_state = 'active' AND w.accepted_candidate_sha IS NULL " +
      "AND r.status = 'succeeded' AND c.state = 'target_tests_passed' AND c.result_sha IS NOT NULL " +
      "AND r.attempt = (SELECT MAX(latest.attempt) FROM collaboration_runs latest " +
      "WHERE latest.work_item_id = w.id AND latest.plan_revision = w.current_plan_revision) " +
      "ORDER BY c.created_at DESC LIMIT 1",
  ).get(workItemId) as {
    work_item_id: string;
    work_item_version: number;
    plan_revision: number;
    run_id: string;
    repository_path: string;
    base_sha: string;
    result_sha: string;
    changed_paths_json: string;
  } | undefined;
  if (!row) return false;
  if (database.prepare(
    "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
  ).get(sourceEventId)) return true;
  const evidence = database
    .prepare("SELECT command_id, state FROM collaboration_test_evidence WHERE run_id = ? ORDER BY command_id")
    .all(row.run_id) as unknown as Array<{ command_id: string; state: string }>;
  const changedPaths = parseJson<string[]>(row.changed_paths_json) ?? [];
  const candidatePreview = renderCandidateDiffPreview({
    repository: row.repository_path,
    baseSha: row.base_sha,
    resultSha: row.result_sha,
    changedPaths,
  });
  const card = cardTemplateId
    ? {
        type: "plan_status_card" as const,
        headline: "候选已就绪" as const,
        cardTemplateId,
        outTrackId: `candidate-${row.run_id}-refresh-${sourceEventId}`,
        workItemId: row.work_item_id,
        workItemVersion: row.work_item_version,
        planRevision: row.plan_revision,
        status: "candidate_ready" as const,
        summary: CANDIDATE_READY_SUMMARY,
        candidateSha: row.result_sha,
        ...(candidatePreview ? { candidatePreview } : {}),
        changedPaths,
        testStates: evidence.map((item) => `${item.command_id}: ${item.state}`),
      }
    : renderPlanStatusCard({
        workItemId: row.work_item_id,
        workItemVersion: row.work_item_version,
        planRevision: row.plan_revision,
        status: "candidate_ready",
        summary: CANDIDATE_READY_SUMMARY,
        candidateSha: row.result_sha,
        ...(candidatePreview ? { candidatePreview } : {}),
        changedPaths,
        testStates: evidence.map((item) => `${item.command_id}: ${item.state}`),
      });
  database.exec("BEGIN IMMEDIATE");
  try {
    enqueueInboundCard(database, {
      sourceEventId,
      aggregateType: "work_item",
      aggregateId: row.work_item_id,
      aggregateVersion: row.work_item_version,
      card,
      supersessionKey: `work-item:${row.work_item_id}:execution-status`,
      now,
    });
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

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
  private readonly executionIsolation: "native_linux" | "docker_linux";
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
  private readonly scheduledWorkItems = new Set<string>();
  private recoveryDecisions: RecoveryDecision[] = [];

  constructor(options: CollaborationHeadlessRuntimeOptions) {
    this.options = options;
    this.ownerId = options.ownerId?.trim() || `headless:${randomUUID()}`;
    this.leaseTtlMs = positiveInteger(options.instanceLeaseTtlMs ?? 30_000, "instanceLeaseTtlMs");
    this.shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs ?? 10_000, "shutdownTimeoutMs");
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.logger = options.logger ?? NULL_LOGGER;
    this.platform = options.platform ?? process.platform;
    this.executionIsolation = options.executionIsolation ?? "native_linux";
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
          ? {
              planning: {
                planner: this.options.planner,
                policy: this.options.planningPolicy,
                ...(this.options.planningDefaultDefinition
                  ? { defaultDefinition: this.options.planningDefaultDefinition }
                  : {}),
              },
            }
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
      if (!this.reason) {
        enqueuePendingOwnerDecisionCards(this.database, this.options.dingTalk?.cardTemplateId, this.clock.now());
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
      executionMode: this.executionEnabled()
        ? "execute"
        : this.platform === "darwin"
          ? "observe_plan_only"
          : "not_configured",
    };
  }

  recovery(): readonly RecoveryDecision[] {
    return this.recoveryDecisions.map((decision) => ({ ...decision }));
  }

  ingestDingTalkMessage(message: DingTalkInboundMessage): InboundMessageOutcome {
    this.assertAcceptingNewWork();
    const outcome = this.service!.ingestDingTalkMessage(message);
    if (this.options.autoExecuteReady && !outcome.duplicate && outcome.workItemId) {
      this.scheduleReadyExecution(outcome.workItemId);
    }
    return outcome;
  }

  performDingTalkOwnerAction(action: DingTalkCardAction): OwnerActionOutcome {
    this.assertOperational();
    const outcome = this.service!.performOwnerAction({
      actionToken: action.actionToken,
      sender: action.sender,
      ...(action.reason ? { reason: action.reason } : {}),
      now: action.receivedAt,
    });
    if (action.origin === "text") this.enqueueTextOwnerActionStatus(action, outcome);
    return outcome;
  }

  performDingTalkOwnerTextCommand(command: DingTalkOwnerTextCommand): DingTalkOwnerTextCommandOutcome {
    this.assertOperational();
    const database = this.database!;
    const existingResponse = database.prepare(
      "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
    ).get(command.transportEventId);

    if (command.command === "status") {
      const row = database.prepare(
        "SELECT status, definition_status, control_state, version FROM collaboration_work_items WHERE id = ?",
      ).get(command.workItemId) as {
        status: string;
        definition_status: string;
        control_state: string;
        version: number;
      } | undefined;
      if (!existingResponse) {
        this.enqueueOwnerTextCommandStatus(command, Boolean(row), row ? "status_returned" : "unknown_work_item", row);
      }
      return {
        allowed: Boolean(row),
        duplicate: Boolean(existingResponse),
        command: command.command,
        workItemId: command.workItemId,
        reason: row ? "status_returned" : "unknown_work_item",
      };
    }

    if (command.command === "refresh_approval") {
      if (existingResponse) {
        return {
          allowed: true,
          duplicate: true,
          command: command.command,
          workItemId: command.workItemId,
          reason: "approval_refreshed",
        };
      }
      const policy = evaluateOwnerPolicy(database, {
        sender: command.sender,
        capability: "candidate.accept",
        now: command.receivedAt,
      });
      if (policy.decision !== "allow") {
        this.enqueueOwnerTextCommandStatus(command, false, policy.reason);
        return {
          allowed: false,
          duplicate: false,
          command: command.command,
          workItemId: command.workItemId,
          reason: policy.reason,
        };
      }
      const refreshed = enqueueOwnerDecisionForWorkItem(
        database,
        command.workItemId,
        this.options.dingTalk?.cardTemplateId,
        command.transportEventId,
        command.receivedAt,
      );
      if (!refreshed) this.enqueueOwnerTextCommandStatus(command, false, "candidate_not_current");
      return {
        allowed: refreshed,
        duplicate: false,
        command: command.command,
        workItemId: command.workItemId,
        reason: refreshed ? "approval_refreshed" : "candidate_not_current",
      };
    }

    const action = DIRECT_TEXT_ACTIONS[command.command];
    if (!action) throw new Error("unsupported_owner_text_command");
    const outcome = this.service!.performDirectOwnerAction({
      sourceEventId: command.transportEventId,
      action,
      workItemId: command.workItemId,
      sender: command.sender,
      now: command.receivedAt,
    });
    this.enqueueOwnerTextCommandStatus(command, outcome.allowed, outcome.reason);
    if (outcome.allowed && (action === "resume" || action === "retry")) {
      this.scheduleReadyExecution(command.workItemId);
    }
    return {
      allowed: outcome.allowed,
      duplicate: outcome.duplicate,
      command: command.command,
      workItemId: command.workItemId,
      reason: outcome.reason,
    };
  }

  private enqueueTextOwnerActionStatus(action: DingTalkCardAction, outcome: OwnerActionOutcome): void {
    if (!this.database) return;
    if (this.database.prepare(
      "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
    ).get(action.transportEventId)) return;
    const status = !outcome.allowed
      ? "owner_action_denied"
      : outcome.action === "accept"
        ? "owner_accepted"
        : outcome.action === "reject"
          ? "owner_rejected"
          : "owner_action_denied";
    const summary = !outcome.allowed
      ? "该验收操作未通过身份、有效期或候选状态校验，请使用最新候选消息中的指令。"
      : undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      enqueueInboundCard(this.database, {
        sourceEventId: action.transportEventId,
        aggregateType: outcome.workItemId ? "plan" : "association",
        aggregateId: outcome.workItemId ?? action.transportEventId,
        aggregateVersion: outcome.workItemVersion ?? 1,
        card: renderPlanStatusCard({
          workItemId: outcome.workItemId ?? "unavailable",
          status,
          ...(summary ? { summary } : {}),
        }),
        now: action.receivedAt,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private enqueueOwnerTextCommandStatus(
    command: DingTalkOwnerTextCommand,
    allowed: boolean,
    reason: string,
    state?: { status: string; definition_status: string; control_state: string; version: number },
  ): void {
    if (!this.database) return;
    if (this.database.prepare(
      "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
    ).get(command.transportEventId)) return;
    const row = state ?? this.database.prepare(
      "SELECT status, definition_status, control_state, version FROM collaboration_work_items WHERE id = ?",
    ).get(command.workItemId) as {
      status: string;
      definition_status: string;
      control_state: string;
      version: number;
    } | undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      enqueueInboundCard(this.database, {
        sourceEventId: command.transportEventId,
        aggregateType: "work_item",
        aggregateId: command.workItemId,
        aggregateVersion: row?.version ?? 1,
        card: renderCommandStatusCard({
          command: command.command,
          workItemId: command.workItemId,
          outcome: allowed ? "allowed" : "denied",
          summary: commandSummary(command.command, allowed, reason),
          ...(row
            ? {
                workItemStatus: row.status,
                definitionStatus: row.definition_status,
                controlState: row.control_state,
              }
            : {}),
        }),
        now: command.receivedAt,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async executeCurrentPlan(workItemId: string, attempt?: number): Promise<CandidateExecutionOutcome> {
    this.assertAcceptingNewWork();
    if (!this.executionEnabled()) throw new Error("collaboration_execution_not_configured");
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
      (this.platform !== "darwin" || this.executionIsolation === "docker_linux") &&
      !!this.options.agent &&
      !!this.options.containment &&
      !!this.options.commandRunner &&
      !!this.options.execution
    );
  }

  private scheduleReadyExecution(workItemId: string): void {
    if (!this.executionEnabled() || this.scheduledWorkItems.has(workItemId) || !this.database) return;
    const ready = this.database
      .prepare(
        "SELECT w.current_plan_revision AS plan_revision, COALESCE((" +
          "SELECT MAX(previous.attempt) FROM collaboration_runs previous WHERE previous.work_item_id = w.id" +
          "), 0) AS previous_attempt FROM collaboration_work_items w " +
          "WHERE w.id = ? AND w.definition_status = 'ready_for_execution' AND w.control_state = 'active' " +
          "AND w.current_plan_revision IS NOT NULL AND NOT EXISTS (" +
          "SELECT 1 FROM collaboration_runs r WHERE r.work_item_id = w.id " +
          "AND r.plan_revision = w.current_plan_revision AND r.status IN ('running', 'succeeded'))",
      )
      .get(workItemId) as { plan_revision: number; previous_attempt: number } | undefined;
    if (!ready) return;
    const attempt = ready.previous_attempt + 1;
    if (attempt > this.options.execution!.limits.maxAttempts) return;
    this.scheduledWorkItems.add(workItemId);
    void this.executeCurrentPlan(workItemId, attempt)
      .then((outcome) => this.enqueueExecutionStatus(outcome))
      .catch(() => this.enqueueExecutionFailure(workItemId, ready.plan_revision))
      .finally(() => this.scheduledWorkItems.delete(workItemId));
  }

  private enqueueExecutionStatus(outcome: CandidateExecutionOutcome): void {
    if (!this.database) return;
    enqueueExecutionOutcomeStatus({
      database: this.database,
      ...(this.options.dingTalk?.cardTemplateId
        ? { cardTemplateId: this.options.dingTalk.cardTemplateId }
        : {}),
      outcome,
      now: this.clock.now(),
    });
  }

  private enqueueExecutionFailure(workItemId: string, planRevision: number): void {
    if (!this.database) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      enqueueInboundCard(this.database, {
        sourceEventId: `execution:${workItemId}:plan:${planRevision}:failed`,
        aggregateType: "plan",
        aggregateId: workItemId,
        aggregateVersion: planRevision,
        card: renderPlanStatusCard({
          workItemId,
          planRevision,
          status: "execution_failed",
          failures: ["隔离执行未完成；证据已保留，可由 Owner 检查后重试。"],
        }),
        supersessionKey: `work-item:${workItemId}:execution-status`,
        now: this.clock.now(),
      });
      this.database.exec("COMMIT");
    } catch {
      this.database.exec("ROLLBACK");
    }
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
          performCommand: (command) => this.performDingTalkOwnerTextCommand(command),
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
