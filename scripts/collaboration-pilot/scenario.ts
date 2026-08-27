import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { OwnerActionController, type OwnerActionOutcome } from "../../server/collaboration/actions.ts";
import { CollaborationDegradationController } from "../../server/collaboration/degradation.ts";
import type { PlanningPolicy } from "../../server/collaboration/graph.ts";
import { LocalOwnerRegistry } from "../../server/collaboration/owner.ts";
import { PlanningCoordinator } from "../../server/collaboration/plan-reviser.ts";
import { CollaborationDiskMonitor } from "../../server/collaboration/operations/disk-monitor.ts";
import { CollaborationHeadlessRuntime } from "../../server/collaboration/operations/runtime.ts";
import type { DingTalkInboundMessage, DingTalkSender } from "../../server/integrations/dingtalk/types.ts";
import {
  AllowlistedPilotCommandRunner,
  FixedSequentialPilotPlanner,
  ManualPilotClock,
  RecordingPilotPrivateAlerts,
  ScriptedPilotAgent,
  ScriptedPilotDiskCapacity,
  ScriptedPilotOutboxDelivery,
  VerifiableFakeContainment,
} from "./fakes.ts";
import {
  ACCEPTANCE_CHECK_IDS,
  AUTOMATED_FAKE_PENDING_CHECKS,
  OUT_OF_SCOPE_CHECKS,
  type AcceptanceCheckId,
  type AcceptanceReport,
  type CheckResult,
  type ControlOutcome,
  type RepositoryStateEvidence,
  validateAcceptanceReport,
} from "./report-schema.ts";

const COMMAND_ID = "pilot:target";
const OWNER_CORP_ID = "pilot-corp";
const OWNER_STAFF_ID = "single-owner";
const NON_OWNER_STAFF_ID = "contributor";
const CONVERSATION_ID = "pilot-conversation";
const SENTINEL = "original untracked sentinel\n";
const PRIMARY_SCENARIO_ID = "primary_candidate";

export interface AutomatedFakePilotResult {
  report: AcceptanceReport;
  scratchDirectory: string;
  dispose(): void;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidence(value: unknown): string {
  return sha256(canonical(value));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: safeGitEnvironment() }).trim();
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, env: safeGitEnvironment() });
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function createDisposableRepository(root: string): { repository: string; baseSha: string; sentinelPath: string } {
  const repository = join(root, "target-repository");
  mkdirSync(join(repository, "src"), { recursive: true, mode: 0o700 });
  git(root, ["init", "-b", "main", repository]);
  writeFileSync(join(repository, ".gitignore"), ".env*\n", { mode: 0o600 });
  writeFileSync(join(repository, "src", "value.txt"), "before\n", { mode: 0o600 });
  git(repository, ["add", "."]);
  git(repository, [
    "-c", "user.name=Pilot Fixture",
    "-c", "user.email=pilot@local.invalid",
    "commit", "-m", "pilot base",
  ]);
  const sentinelPath = join(repository, "local-sentinel.txt");
  writeFileSync(sentinelPath, SENTINEL, { mode: 0o600 });
  return { repository: realpathSync(repository), baseSha: git(repository, ["rev-parse", "HEAD"]), sentinelPath };
}

function repositoryState(repository: string, sentinelPath: string): RepositoryStateEvidence {
  return {
    defaultBranchSha: git(repository, ["rev-parse", "main"]),
    indexHash: sha256(gitBuffer(repository, ["ls-files", "--stage", "-z"])),
    statusHash: sha256(gitBuffer(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])),
    sentinelHash: sha256(readFileSync(sentinelPath)),
  };
}

function sender(staffId: string, label: string): DingTalkSender {
  return {
    senderCorpId: OWNER_CORP_ID,
    senderStaffId: staffId,
    senderId: `sender-${staffId}`,
    displayName: label,
  };
}

function inbound(sourceEventId: string, text: string, receivedAt: number, replyToSourceEventId?: string): DingTalkInboundMessage {
  return {
    sourceEventId,
    transportMessageId: `transport-${sourceEventId}`,
    conversationId: CONVERSATION_ID,
    addressedToBot: true,
    text,
    sender: sender(NON_OWNER_STAFF_ID, "Contributor"),
    receivedAt,
    ...(replyToSourceEventId ? { replyToSourceEventId } : {}),
  };
}

function planningPolicy(repository: string): PlanningPolicy {
  return {
    allowedRepositories: [repository],
    supportedAgents: {
      analyze: ["pilot-coordinator"],
      modify: ["pilot-developer"],
      validate: ["pilot-validator"],
      report: ["pilot-coordinator"],
    },
    allowedCommands: [COMMAND_ID],
    requiredDenyScopes: [".env*", ".git/**"],
    limits: {
      maxCommandsPerPlan: 2,
      maxMinutesPerNode: 10,
      maxAttemptsPerNode: 3,
      maxTokensPerNode: 10_000,
      maxTokensPerPlan: 30_000,
    },
  };
}

function workItemState(databaseFile: string, workItemId: string): { version: number; status: string; controlState: string } {
  const database = new DatabaseSync(databaseFile);
  const row = database.prepare(
    "SELECT version, status, control_state AS controlState FROM collaboration_work_items WHERE id = ?",
  ).get(workItemId) as { version: number; status: string; controlState: string };
  database.close();
  return row;
}

function control(
  scenarioId: string,
  workItemId: string,
  action: ControlOutcome["action"],
  outcome: OwnerActionOutcome,
  stateChanged: boolean,
): ControlOutcome {
  return {
    scenarioId,
    workItemId,
    action,
    status: outcome.allowed || (!stateChanged && outcome.reason) ? "pass" : "fail",
    stateChanged,
    evidenceHash: evidence({
      allowed: outcome.allowed,
      duplicate: outcome.duplicate,
      action: outcome.action,
      version: outcome.workItemVersion,
      state: outcome.controlState,
      reason: outcome.reason,
      revisedSnapshotRevision: outcome.revisedSnapshotRevision,
    }),
    auditEventIds: [],
  };
}

interface SeededActionFixture {
  scenarioId: string;
  workItemId: string;
  candidateSha: string;
  runId: string;
}

function seedActionFixture(databaseFile: string, scenarioId: string, workItemId: string, now: number): SeededActionFixture {
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA foreign_keys = ON");
  const candidateSha = "a".repeat(40);
  const snapshot = database.prepare(
    "SELECT max(revision) AS revision FROM collaboration_work_item_snapshots WHERE work_item_id = ?",
  ).get(workItemId) as { revision: number };
  database.prepare(
    "INSERT INTO collaboration_plan_revisions " +
      "(id, work_item_id, revision, snapshot_revision, status, summary, proposal_hash, created_at) " +
      "VALUES (?, ?, 1, ?, 'published', 'fixture plan', 'fixture-hash', ?)",
  ).run(randomUUID(), workItemId, snapshot.revision, now);
  const insertNode = database.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, input_evidence_json, " +
      "instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, expected_artifacts_json, " +
      "completion_definition, risk, budget_json, execution_status, created_at) " +
      "VALUES (?, 1, ?, ?, ?, 'pilot-developer', 'fixture', '[]', 'fixture', '[]', '[]', '[]', ?, '[]', " +
      "'done', 'low', '{}', ?, ?)",
  );
  insertNode.run(workItemId, "analyze", "analyze", "ready", "[]", "candidate_ready", now);
  insertNode.run(workItemId, "modify", "modify", "pending", "[]", "failed", now);
  insertNode.run(workItemId, "validate", "validate", "pending", "[\"fixture-target\"]", "candidate_ready", now);
  insertNode.run(workItemId, "report", "report", "pending", "[]", "candidate_ready", now);
  database.prepare(
    "UPDATE collaboration_work_items SET definition_status = 'ready_for_execution', current_plan_revision = 1 WHERE id = ?",
  ).run(workItemId);
  const runId = randomUUID();
  database.prepare(
    "INSERT INTO collaboration_runs " +
      "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
      "worktree_path, branch, base_sha, result_sha, started_at, finished_at) " +
      "VALUES (?, ?, 1, 'modify', 1, 'pilot-developer', 'fixture-thread', 'fixture-turn', 'succeeded', " +
      "'fixture-repository', 'fixture-worktree', 'ai/fixture', ?, ?, ?, ?)",
  ).run(runId, workItemId, "b".repeat(40), candidateSha, now, now + 1);
  database.prepare(
    "INSERT INTO collaboration_candidates " +
      "(id, run_id, state, base_sha, result_sha, changed_paths_json, violations_json, quality_json, created_at) " +
      "VALUES (?, ?, 'test_failed', ?, ?, '[\"src/value.txt\"]', '[]', '{}', ?)",
  ).run(randomUUID(), runId, "b".repeat(40), candidateSha, now + 1);
  database.close();
  return { scenarioId, workItemId, candidateSha, runId };
}

function runRetryRejectAndCancel(
  actions: OwnerActionController,
  retryReject: SeededActionFixture,
  cancelled: SeededActionFixture,
  clock: ManualPilotClock,
): { owner: ControlOutcome[]; nonOwner: ControlOutcome[] } {
  const owner = sender(OWNER_STAFF_ID, "Owner");
  const nonOwner = sender(NON_OWNER_STAFF_ID, "Contributor");
  const ownerOutcomes: ControlOutcome[] = [];
  const nonOwnerOutcomes: ControlOutcome[] = [];
  const retryToken = actions.issue({
    action: "retry", workItemId: retryReject.workItemId, expectedVersion: 1, now: clock.advance(10),
  });
  nonOwnerOutcomes.push(control(retryReject.scenarioId, retryReject.workItemId, "retry", actions.perform({
    actionToken: retryToken.token, sender: nonOwner, now: clock.advance(10),
  }), false));
  const retry = actions.perform({ actionToken: retryToken.token, sender: owner, now: clock.advance(10) });
  ownerOutcomes.push(control(retryReject.scenarioId, retryReject.workItemId, "retry", retry, true));
  const rejectToken = actions.issue({
    action: "reject",
    workItemId: retryReject.workItemId,
    expectedVersion: 2,
    candidateSha: retryReject.candidateSha,
    now: clock.advance(10),
  });
  nonOwnerOutcomes.push(control(retryReject.scenarioId, retryReject.workItemId, "reject", actions.perform({
    actionToken: rejectToken.token, sender: nonOwner, reason: "denied", now: clock.advance(10),
  }), false));
  const reject = actions.perform({
    actionToken: rejectToken.token,
    sender: owner,
    reason: "Pilot feedback requires a fresh definition revision",
    now: clock.advance(10),
  });
  ownerOutcomes.push(control(retryReject.scenarioId, retryReject.workItemId, "reject", reject, true));

  const cancelToken = actions.issue({
    action: "cancel", workItemId: cancelled.workItemId, expectedVersion: 1, now: clock.advance(10),
  });
  nonOwnerOutcomes.push(control(cancelled.scenarioId, cancelled.workItemId, "cancel", actions.perform({
    actionToken: cancelToken.token, sender: nonOwner, now: clock.advance(10),
  }), false));
  const cancel = actions.perform({ actionToken: cancelToken.token, sender: owner, now: clock.advance(10) });
  ownerOutcomes.push(control(cancelled.scenarioId, cancelled.workItemId, "cancel", cancel, true));
  return { owner: ownerOutcomes, nonOwner: nonOwnerOutcomes };
}

function seedRecoveryRun(databaseFile: string, fixture: SeededActionFixture, now: number): string {
  const runId = randomUUID();
  const database = new DatabaseSync(databaseFile);
  database.prepare(
    "INSERT INTO collaboration_runs " +
      "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
      "worktree_path, branch, base_sha, started_at) " +
      "VALUES (?, ?, 1, 'report', 1, 'pilot-coordinator', 'recovery-thread', 'recovery-turn', 'running', " +
      "'fixture-repository', 'fixture-worktree-recovery', 'ai/recovery', ?, ?)",
  ).run(runId, fixture.workItemId, "b".repeat(40), now);
  database.close();
  return runId;
}

async function verifyLowDiskFailClosed(root: string): Promise<string> {
  const dataDirectory = join(root, "low-disk");
  const clock = new ManualPilotClock(8_000);
  const capacity = new ScriptedPilotDiskCapacity([
    { availableBytes: 1n, totalBytes: 10_000n },
  ]);
  const alerts = new RecordingPilotPrivateAlerts();
  const runtime = new CollaborationHeadlessRuntime({
    dataDirectory,
    ownerId: "pilot-low-disk-runtime",
    platform: "linux",
    clock,
    maintenanceFactory: ({ database }) => new CollaborationDiskMonitor(
      database,
      new CollaborationDegradationController(database),
      alerts,
      capacity,
      { dataDirectory, minimumAvailableBytes: 100n, minimumAvailableRatio: 0.1 },
    ),
  });
  await runtime.start();
  await runtime.drainOnce();
  let rejection = "";
  try {
    runtime.ingestDingTalkMessage(inbound("low-disk-event", "Must remain gated", clock.now()));
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
  }
  const health = runtime.health();
  await runtime.stop();
  if (rejection !== "collaboration_runtime_low_disk" || health.reason !== "low_disk" || alerts.calls.length !== 1) {
    throw new Error("pilot_low_disk_did_not_fail_closed");
  }
  return evidence({ rejection, reason: health.reason, alerts: alerts.calls.map((call) => call.code) });
}

function buildChecks(evidenceByCheck: Partial<Record<AcceptanceCheckId, string[]>>): Record<AcceptanceCheckId, CheckResult> {
  return Object.fromEntries(ACCEPTANCE_CHECK_IDS.map((id) => {
    if ((OUT_OF_SCOPE_CHECKS as readonly string[]).includes(id)) {
      return [id, { status: "not_applicable", evidenceHashes: [], summaryCode: "outside_first_milestone" }];
    }
    if ((AUTOMATED_FAKE_PENDING_CHECKS as readonly string[]).includes(id)) {
      return [id, { status: "pending", evidenceHashes: [], summaryCode: "requires_real_owner_pilot" }];
    }
    const evidenceHashes = evidenceByCheck[id] ?? [];
    if (evidenceHashes.length === 0) throw new Error(`pilot_check_evidence_missing:${id}`);
    return [id, {
      status: "pass",
      evidenceHashes,
      summaryCode: "automated_fake_verified",
    }];
  })) as Record<AcceptanceCheckId, CheckResult>;
}

export async function runAutomatedFakePilot(input: { scratchRoot?: string } = {}): Promise<AutomatedFakePilotResult> {
  const scratchDirectory = mkdtempSync(join(input.scratchRoot ?? tmpdir(), "openmausbot-pilot-"));
  const dispose = () => rmSync(scratchDirectory, { recursive: true, force: true });
  try {
    const { repository, baseSha, sentinelPath } = createDisposableRepository(scratchDirectory);
    const initialRepositoryState = repositoryState(repository, sentinelPath);
    const dataDirectory = join(scratchDirectory, "runtime-data");
    const managedWorktreeRoot = join(scratchDirectory, "managed-worktrees");
    mkdirSync(managedWorktreeRoot, { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    const clock = new ManualPilotClock(startedAt);
    const planner = new FixedSequentialPilotPlanner();
    const containment = new VerifiableFakeContainment();
    const agent = new ScriptedPilotAgent({ containment, mutations: [{ path: "src/value.txt", contents: "after\n" }] });
    const targetArgv: [string, ...string[]] = [
      process.execPath,
      "-e",
      "const fs=require('node:fs');process.exit(fs.readFileSync('src/value.txt','utf8')==='after\\n'?0:2)",
    ];
    const commandRunner = new AllowlistedPilotCommandRunner({
      containment,
      worktreeRoot: managedWorktreeRoot,
      commands: { [COMMAND_ID]: { argv: targetArgv } },
    });
    const delivery = new ScriptedPilotOutboxDelivery([
      { outcome: "retryable", error: "pilot_transport_temporary_failure" },
      { outcome: "sent", transportId: "pilot-transport-retry" },
    ]);
    const policy = planningPolicy(repository);
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory,
      ownerId: "pilot-runtime-one",
      platform: "linux",
      clock,
      planner,
      planningPolicy: policy,
      agent,
      containment,
      commandRunner,
      execution: {
        managedWorktreeRoot,
        repositories: {
          [repository]: { baseSha, targetCommands: { [COMMAND_ID]: { argv: targetArgv, timeoutMs: 5_000, maxOutputBytes: 32_000 } } },
        },
        limits: { maxAttempts: 2, agentTimeoutMs: 5_000, maxAgentEventBytes: 32_000, interruptGraceMs: 500 },
      },
      outboxDelivery: delivery,
      outbox: { baseBackoffMs: 1_000, maxBackoffMs: 1_000, claimTtlMs: 5_000, maxAttempts: 3, jitter: () => 0 },
    });
    const started = await runtime.start();
    if (!started.ready) throw new Error(`pilot_runtime_not_ready:${started.reason ?? "unknown"}`);
    const databaseFile = join(dataDirectory, "collaboration", "collaboration.sqlite");
    const ownerRegistry = new LocalOwnerRegistry(databaseFile);
    ownerRegistry.bootstrap({ senderCorpId: OWNER_CORP_ID, senderStaffId: OWNER_STAFF_ID, now: clock.now() });
    if (ownerRegistry.active()?.generation !== 1) throw new Error("pilot_single_owner_not_active");
    const actions = new OwnerActionController(databaseFile);
    const coordinator = new PlanningCoordinator(databaseFile, { planner, policy });

    const initialMessage = inbound("pilot-event-1", "Update the disposable fixture value", clock.advance(100));
    const firstIngress = runtime.ingestDingTalkMessage(initialMessage);
    const duplicateIngress = runtime.ingestDingTalkMessage(initialMessage);
    if (!firstIngress.workItemId || firstIngress.duplicate || !duplicateIngress.duplicate) {
      throw new Error("pilot_duplicate_ingress_invariant_failed");
    }
    const workItemId = firstIngress.workItemId;
    const staleToken = actions.issue({ action: "pause", workItemId, expectedVersion: 1, now: clock.advance(100) });
    runtime.ingestDingTalkMessage({ ...inbound(
      "pilot-event-2",
      "Use the deterministic target observation",
      clock.advance(100),
      initialMessage.sourceEventId,
    ), sender: sender("test-contributor", "Test Contributor") });
    const stale = actions.perform({ actionToken: staleToken.token, sender: sender(OWNER_STAFF_ID, "Owner"), now: clock.advance(100) });
    if (stale.allowed || stale.reason !== "work_item_version_changed") throw new Error("pilot_stale_action_not_denied");

    const planning = coordinator.reviseDefinition(workItemId, {
      goal: "Change src/value.txt from before to after",
      goalConfirmed: true,
      repository,
      acceptanceConditions: [{ description: "fixture value changed", observation: "allowlisted target reads after" }],
      blockingAmbiguities: [],
    }, clock.advance(100));
    if (planning.definitionStatus !== "ready_for_execution" || planning.planRevision === null) {
      throw new Error("pilot_plan_not_ready");
    }

    const pauseToken = actions.issue({ action: "pause", workItemId, expectedVersion: 2, now: clock.advance(100) });
    const nonOwner = actions.perform({
      actionToken: pauseToken.token,
      sender: sender(NON_OWNER_STAFF_ID, "Contributor"),
      now: clock.advance(100),
    });
    if (nonOwner.allowed || nonOwner.reason !== "not_active_owner") throw new Error("pilot_non_owner_was_not_denied");

    const auditDatabase = new DatabaseSync(databaseFile);
    auditDatabase.exec(`
      CREATE TRIGGER pilot_reject_pause_audit
      BEFORE INSERT ON collaboration_audit_events
      WHEN NEW.action = 'control.pause' AND NEW.outcome = 'allow'
      BEGIN SELECT RAISE(ABORT, 'pilot audit unavailable'); END;
    `);
    auditDatabase.close();
    let auditFailure = "";
    try {
      actions.perform({ actionToken: pauseToken.token, sender: sender(OWNER_STAFF_ID, "Owner"), now: clock.advance(100) });
    } catch (error) {
      auditFailure = error instanceof Error ? error.message : String(error);
    }
    const afterAuditFailure = workItemState(databaseFile, workItemId);
    const auditRepair = new DatabaseSync(databaseFile);
    auditRepair.exec("DROP TRIGGER pilot_reject_pause_audit");
    auditRepair.close();
    if (!auditFailure.includes("pilot audit unavailable") || afterAuditFailure.version !== 2 || afterAuditFailure.controlState !== "active") {
      throw new Error("pilot_audit_failure_did_not_roll_back");
    }
    const pause = actions.perform({ actionToken: pauseToken.token, sender: sender(OWNER_STAFF_ID, "Owner"), now: clock.advance(100) });
    const replayBeforeDatabase = new DatabaseSync(databaseFile);
    const replayOutboxBefore = (replayBeforeDatabase.prepare(
      "SELECT count(*) AS count FROM collaboration_outbox",
    ).get() as { count: number }).count;
    replayBeforeDatabase.close();
    const pauseReplay = actions.perform({
      actionToken: pauseToken.token,
      sender: sender(OWNER_STAFF_ID, "Owner"),
      now: clock.advance(100),
    });
    const replayAfterDatabase = new DatabaseSync(databaseFile);
    const replayOutboxAfter = (replayAfterDatabase.prepare(
      "SELECT count(*) AS count FROM collaboration_outbox",
    ).get() as { count: number }).count;
    replayAfterDatabase.close();
    if (!pauseReplay.allowed || !pauseReplay.duplicate || workItemState(databaseFile, workItemId).version !== 3 ||
        replayOutboxAfter !== replayOutboxBefore) {
      throw new Error("pilot_consumed_action_replay_changed_state");
    }
    const resumeToken = actions.issue({ action: "resume", workItemId, expectedVersion: 3, now: clock.advance(100) });
    const nonOwnerResume = actions.perform({
      actionToken: resumeToken.token,
      sender: sender(NON_OWNER_STAFF_ID, "Contributor"),
      now: clock.advance(100),
    });
    const resume = actions.perform({ actionToken: resumeToken.token, sender: sender(OWNER_STAFF_ID, "Owner"), now: clock.advance(100) });

    const firstPlanDatabase = new DatabaseSync(databaseFile);
    const firstPlanBeforeRevision = firstPlanDatabase.prepare(
      "SELECT revision, snapshot_revision, status, summary, proposal_hash FROM collaboration_plan_revisions " +
        "WHERE work_item_id = ? AND revision = 1",
    ).get(workItemId) as Record<string, unknown>;
    firstPlanDatabase.close();
    runtime.ingestDingTalkMessage({ ...inbound(
      "pilot-event-3",
      "Add the acceptance condition while the first plan exists",
      clock.advance(100),
      initialMessage.sourceEventId,
    ), sender: sender("developer-contributor", "Developer Contributor") });
    const revisionDatabase = new DatabaseSync(databaseFile);
    const revisionState = revisionDatabase.prepare(
      "SELECT current_plan_revision AS currentPlanRevision, " +
        "(SELECT count(*) FROM collaboration_plan_revisions WHERE work_item_id = ?) AS planCount, " +
        "(SELECT max(revision) FROM collaboration_work_item_snapshots WHERE work_item_id = ?) AS snapshotRevision " +
        "FROM collaboration_work_items WHERE id = ?",
    ).get(workItemId, workItemId, workItemId) as {
      currentPlanRevision: number; planCount: number; snapshotRevision: number;
    };
    const firstPlanAfterRevision = revisionDatabase.prepare(
      "SELECT revision, snapshot_revision, status, summary, proposal_hash FROM collaboration_plan_revisions " +
        "WHERE work_item_id = ? AND revision = 1",
    ).get(workItemId) as Record<string, unknown>;
    revisionDatabase.close();
    if (revisionState.currentPlanRevision !== 2 || revisionState.planCount !== 2 ||
        canonical(firstPlanAfterRevision) !== canonical(firstPlanBeforeRevision)) {
      throw new Error("pilot_runtime_change_did_not_create_plan_revision");
    }

    const execution = await runtime.executeCurrentPlan(workItemId, 1);
    if (!execution.resultSha || execution.report.state !== "target_tests_passed") {
      throw new Error(`pilot_candidate_failed:${execution.report.state}`);
    }
    const acceptToken = actions.issue({
      action: "accept",
      workItemId,
      expectedVersion: 5,
      candidateSha: execution.resultSha,
      now: clock.advance(100),
    });
    const nonOwnerAccept = actions.perform({
      actionToken: acceptToken.token,
      sender: sender(NON_OWNER_STAFF_ID, "Contributor"),
      now: clock.advance(100),
    });
    const accept = actions.perform({ actionToken: acceptToken.token, sender: sender(OWNER_STAFF_ID, "Owner"), now: clock.advance(100) });
    if (!accept.allowed || accept.controlState !== "accepted") throw new Error("pilot_candidate_not_accepted");

    const retryRejectIngress = runtime.ingestDingTalkMessage({
      ...inbound("pilot-retry-reject-event", "Exercise retry and rejection", clock.advance(100)),
      conversationId: `${CONVERSATION_ID}-retry-reject`,
    });
    const cancelIngress = runtime.ingestDingTalkMessage({
      ...inbound("pilot-cancel-event", "Exercise separate cancellation", clock.advance(100)),
      conversationId: `${CONVERSATION_ID}-cancel`,
    });
    const recoveryIngress = runtime.ingestDingTalkMessage({
      ...inbound("pilot-recovery-event", "Exercise restart classification", clock.advance(100)),
      conversationId: `${CONVERSATION_ID}-recovery`,
    });
    if (!retryRejectIngress.workItemId || !cancelIngress.workItemId || !recoveryIngress.workItemId) {
      throw new Error("pilot_supporting_scenario_work_item_missing");
    }
    const retryRejectFixture = seedActionFixture(
      databaseFile, "retry_reject", retryRejectIngress.workItemId, clock.advance(10),
    );
    const cancelFixture = seedActionFixture(databaseFile, "cancel", cancelIngress.workItemId, clock.advance(10));
    const recoveryFixture = seedActionFixture(
      databaseFile, "restart_recovery", recoveryIngress.workItemId, clock.advance(10),
    );
    const extraControls = runRetryRejectAndCancel(actions, retryRejectFixture, cancelFixture, clock);

    const outboxBeforeDrainDatabase = new DatabaseSync(databaseFile);
    const outboxBeforeDrain = outboxBeforeDrainDatabase.prepare(
      "SELECT id, delivery_state, created_at, next_attempt_at, superseded_at FROM collaboration_outbox ORDER BY created_at, id",
    ).all();
    outboxBeforeDrainDatabase.close();
    const drainOutcomes = [];
    let retryDrain: Awaited<ReturnType<CollaborationHeadlessRuntime["drainOnce"]>> | undefined;
    let sentDrain: Awaited<ReturnType<CollaborationHeadlessRuntime["drainOnce"]>> | undefined;
    for (let index = 0; index < 20 && !sentDrain; index += 1) {
      const drained = await runtime.drainOnce();
      drainOutcomes.push(drained);
      if (drained.dispatched?.state === "retry_scheduled") {
        retryDrain = drained;
        clock.advance(1_000);
      } else if (retryDrain && drained.dispatched?.state === "sent") {
        sentDrain = drained;
      } else {
        clock.advance(1);
      }
    }
    if (!retryDrain || !sentDrain || delivery.calls.length !== 2 || delivery.calls[0]?.id !== delivery.calls[1]?.id) {
      throw new Error(`pilot_outbox_retry_failed:${canonical({ now: clock.now(), health: runtime.health(), outboxBeforeDrain, drainOutcomes, calls: delivery.calls.map((call) => ({ id: call.id, dedupeKey: call.dedupeKey })) })}`);
    }
    coordinator.close();
    actions.close();
    ownerRegistry.close();
    await runtime.stop();
    const recoveryRunId = seedRecoveryRun(databaseFile, recoveryFixture, clock.advance(10));

    const restartDelivery = new ScriptedPilotOutboxDelivery();
    const restarted = new CollaborationHeadlessRuntime({
      dataDirectory,
      ownerId: "pilot-runtime-restarted",
      platform: "linux",
      clock,
      outboxDelivery: restartDelivery,
    });
    const restartHealth = await restarted.start();
    const persistedState = workItemState(databaseFile, workItemId);
    const restartRecovery = restarted.recovery();
    const classifiedRecovery = restartRecovery.find((decision) => decision.runId === recoveryRunId);
    if (!classifiedRecovery || classifiedRecovery.classification !== "needs_configuration" ||
        classifiedRecovery.reason !== "containment_binding_missing") {
      throw new Error("pilot_recovery_did_not_classify_unbound_run");
    }
    await restarted.drainOnce();
    await restarted.stop();
    if (!restartHealth.ready || persistedState.status !== "accepted") throw new Error("pilot_restart_state_not_recovered");

    const finalRepositoryState = repositoryState(repository, sentinelPath);
    if (canonical(finalRepositoryState) !== canonical(initialRepositoryState)) {
      throw new Error("pilot_default_worktree_changed");
    }
    if (readFileSync(sentinelPath, "utf8") !== SENTINEL || git(repository, ["remote"]).length !== 0) {
      throw new Error("pilot_repository_sentinel_or_remote_invariant_failed");
    }
    const branchSha = git(execution.worktreePath, ["rev-parse", execution.branch]);
    if (branchSha !== execution.resultSha || !execution.worktreePath.startsWith(`${realpathSync(managedWorktreeRoot)}/`)) {
      throw new Error("pilot_candidate_not_on_managed_local_branch");
    }
    const lowDiskEvidence = await verifyLowDiskFailClosed(scratchDirectory);

    const database = new DatabaseSync(databaseFile);
    const schemaVersion = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const events = database.prepare(
      "SELECT id, source_event_id, work_item_id FROM collaboration_external_events ORDER BY received_at, id",
    ).all() as unknown as Array<{ id: string; source_event_id: string; work_item_id: string | null }>;
    const run = database.prepare(
      "SELECT id, plan_revision, node_id, attempt, base_sha, result_sha, branch FROM collaboration_runs " +
        "WHERE work_item_id = ? ORDER BY started_at, id",
    ).get(workItemId) as {
      id: string; plan_revision: number; node_id: string; attempt: number; base_sha: string; result_sha: string; branch: string;
    };
    const recoveredRun = database.prepare(
      "SELECT id, node_id, attempt, base_sha, result_sha, branch FROM collaboration_runs WHERE id = ?",
    ).get(recoveryRunId) as {
      id: string; node_id: string; attempt: number; base_sha: string; result_sha: null; branch: string;
    };
    const supportingRuns = database.prepare(
      "SELECT id, work_item_id, node_id, attempt, base_sha, result_sha, branch FROM collaboration_runs " +
        "WHERE id IN (?, ?, ?) ORDER BY started_at, id",
    ).all(retryRejectFixture.runId, cancelFixture.runId, recoveryFixture.runId) as unknown as Array<{
      id: string; work_item_id: string; node_id: string; attempt: number; base_sha: string; result_sha: string; branch: string;
    }>;
    const duplicateCounts = database.prepare(
      "SELECT " +
        "(SELECT count(*) FROM collaboration_external_events WHERE source = 'dingtalk' AND source_event_id = 'pilot-event-1') AS inboundCount, " +
        "(SELECT count(*) FROM collaboration_work_item_events item_event " +
        "JOIN collaboration_external_events external_event ON external_event.id = item_event.external_event_id " +
        "WHERE external_event.source = 'dingtalk' AND external_event.source_event_id = 'pilot-event-1') AS workItemEventCount, " +
        "(SELECT count(*) FROM collaboration_runs WHERE work_item_id = ?) AS runCount, " +
        "(SELECT count(DISTINCT principal_id) FROM collaboration_work_item_events WHERE work_item_id = ?) AS contributorCount",
    ).get(workItemId, workItemId) as {
      inboundCount: number; workItemEventCount: number; runCount: number; contributorCount: number;
    };
    if (duplicateCounts.inboundCount !== 1 || duplicateCounts.workItemEventCount !== 1 ||
        duplicateCounts.runCount !== 1 || duplicateCounts.contributorCount !== 3) {
      throw new Error("pilot_duplicate_created_extra_durable_work");
    }
    const testRows = database.prepare(
      "SELECT command_id, argv_json, exit_code, duration_ms, stdout, stderr, state FROM collaboration_test_evidence WHERE run_id = ? ORDER BY created_at, id",
    ).all(run.id) as unknown as Array<{
      command_id: string; argv_json: string; exit_code: number; duration_ms: number; stdout: string; stderr: string; state: string;
    }>;
    if (testRows.some((test) => test.command_id !== COMMAND_ID)) throw new Error("pilot_untrusted_test_command_evidence");
    const auditRows = database.prepare(
      "SELECT id, work_item_id, action, outcome, policy_rule, before_hash, after_hash, error, created_at " +
        "FROM collaboration_audit_events ORDER BY created_at, id",
    ).all() as unknown as Array<Record<string, unknown>>;
    const superseded = database.prepare(
      "SELECT count(*) AS count FROM collaboration_outbox WHERE delivery_state = 'superseded'",
    ).get() as { count: number };
    database.close();
    if (superseded.count < 1) throw new Error("pilot_outbox_supersession_not_observed");

    const rawOwnerOutcomes: ControlOutcome[] = [
      control(PRIMARY_SCENARIO_ID, workItemId, "stale_action", stale, false),
      {
        scenarioId: PRIMARY_SCENARIO_ID,
        workItemId,
        action: "audit_write_failure",
        status: "pass",
        stateChanged: false,
        evidenceHash: evidence({ auditFailure, afterAuditFailure }),
        auditEventIds: [],
      },
      control(PRIMARY_SCENARIO_ID, workItemId, "pause", pause, true),
      control(PRIMARY_SCENARIO_ID, workItemId, "pause_replay", pauseReplay, false),
      control(PRIMARY_SCENARIO_ID, workItemId, "resume", resume, true),
      ...extraControls.owner,
      control(PRIMARY_SCENARIO_ID, workItemId, "accept", accept, true),
    ];
    const rawNonOwnerOutcomes = [
      control(PRIMARY_SCENARIO_ID, workItemId, "pause", nonOwner, false),
      control(PRIMARY_SCENARIO_ID, workItemId, "resume", nonOwnerResume, false),
      ...extraControls.nonOwner,
      control(PRIMARY_SCENARIO_ID, workItemId, "accept", nonOwnerAccept, false),
    ];
    const auditIdsByWorkItem = new Map<string, string[]>();
    for (const row of auditRows) {
      const itemId = typeof row.work_item_id === "string" ? row.work_item_id : null;
      if (!itemId) continue;
      const ids = auditIdsByWorkItem.get(itemId) ?? [];
      ids.push(String(row.id));
      auditIdsByWorkItem.set(itemId, ids);
    }
    const bindAudit = (outcome: ControlOutcome): ControlOutcome => {
      if (outcome.action === "audit_write_failure") return { ...outcome, auditEventIds: [] };
      const persistedAction = outcome.action === "stale_action"
        ? "control.pause"
        : outcome.action === "pause_replay"
          ? "control.pause.replay"
          : `control.${outcome.action}`;
      const persistedOutcome = outcome.action === "pause_replay" || outcome.stateChanged ? "allow" : "deny";
      const persistedError = outcome.action === "stale_action"
        ? "work_item_version_changed"
        : persistedOutcome === "deny"
          ? "not_active_owner"
          : null;
      const auditEventIds = auditRows.filter((row) =>
        row.work_item_id === outcome.workItemId && row.action === persistedAction && row.outcome === persistedOutcome &&
        (row.error ?? null) === persistedError,
      ).map((row) => String(row.id));
      if (auditEventIds.length !== 1) {
        throw new Error(`pilot_control_audit_ambiguous:${outcome.scenarioId}:${outcome.action}`);
      }
      return { ...outcome, auditEventIds };
    };
    const ownerOutcomes = rawOwnerOutcomes.map(bindAudit);
    const nonOwnerOutcomes = rawNonOwnerOutcomes.map(bindAudit);
    const repositoryEvidence = evidence({ initialRepositoryState, finalRepositoryState, remoteCount: 0, remotePushes: agent.evidence[0]?.remotePushes });
    const ingressEvidence = evidence({
      first: firstIngress.duplicate,
      duplicate: duplicateIngress.duplicate,
      duplicateCounts,
    });
    const planningEvidence = evidence({
      firstSnapshotRevision: planning.snapshotRevision,
      firstPlanRevision: planning.planRevision,
      firstPlanImmutable: canonical(firstPlanBeforeRevision) === canonical(firstPlanAfterRevision),
      revised: revisionState,
      nodeCount: 4,
    });
    const controlsEvidence = evidence({ ownerOutcomes, nonOwnerOutcomes });
    const outboxEvidence = evidence({ drainOutcomes, calls: delivery.calls.length });
    const recoveryEvidence = evidence({
      ready: restartHealth.ready,
      persistedState,
      restartRecovery,
      classifiedRecovery,
      restartDeliveries: restartDelivery.calls.length,
    });
    const candidateEvidence = evidence({
      baseSha: execution.baseSha,
      resultSha: execution.resultSha,
      branch: execution.branch,
      changedPaths: execution.changedPaths,
      tests: testRows,
      agent: agent.evidence.map(({ runId, changedPaths, invokedGit, remotePushes }) => ({ runId, changedPaths, invokedGit, remotePushes })),
    });
    const auditEvidence = evidence(auditRows);
    const eventIdsFor = (itemId: string) => events.filter((event) => event.work_item_id === itemId).map((event) => event.id);
    const scenarioTraces = [
      {
        scenarioId: PRIMARY_SCENARIO_ID,
        workItemId,
        eventIds: eventIdsFor(workItemId),
        runIds: [run.id],
        auditEventIds: auditIdsByWorkItem.get(workItemId) ?? [],
      },
      {
        scenarioId: retryRejectFixture.scenarioId,
        workItemId: retryRejectFixture.workItemId,
        eventIds: eventIdsFor(retryRejectFixture.workItemId),
        runIds: [retryRejectFixture.runId],
        auditEventIds: auditIdsByWorkItem.get(retryRejectFixture.workItemId) ?? [],
      },
      {
        scenarioId: cancelFixture.scenarioId,
        workItemId: cancelFixture.workItemId,
        eventIds: eventIdsFor(cancelFixture.workItemId),
        runIds: [cancelFixture.runId],
        auditEventIds: auditIdsByWorkItem.get(cancelFixture.workItemId) ?? [],
      },
      {
        scenarioId: recoveryFixture.scenarioId,
        workItemId: recoveryFixture.workItemId,
        eventIds: eventIdsFor(recoveryFixture.workItemId),
        runIds: [recoveryFixture.runId, recoveredRun.id],
        auditEventIds: auditIdsByWorkItem.get(recoveryFixture.workItemId) ?? [],
      },
    ];
    const supportingNodeTraces = supportingRuns.map((supportingRun) => ({
      nodeId: supportingRun.node_id,
      runId: supportingRun.id,
      attemptIds: [`${supportingRun.id}-attempt-${supportingRun.attempt}`],
      baseSha: supportingRun.base_sha,
      resultSha: supportingRun.result_sha,
      managedBranch: supportingRun.branch,
      changedPaths: ["src/value.txt"],
      tests: [],
    }));

    const buildRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
    const buildSha = git(buildRoot, ["rev-parse", "HEAD"]);
    const buildDirty = gitBuffer(buildRoot, ["status", "--porcelain=v1", "-z"]).length > 0;
    const ownerIdentityHash = sha256(`${OWNER_CORP_ID}\0${OWNER_STAFF_ID}`);
    const report: AcceptanceReport = {
      reportVersion: 1,
      scope: "automated_fake",
      status: "pending",
      build: { sha: buildSha, dirty: buildDirty },
      times: {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(clock.now()).toISOString(),
      },
      ledger: { schemaVersion },
      externalReferences: {
        repositoryPathHash: sha256(repository),
        ownerIdentityHash,
        nonOwnerIdentityHashes: [
          sha256(`${OWNER_CORP_ID}\0${NON_OWNER_STAFF_ID}`),
          sha256(`${OWNER_CORP_ID}\0test-contributor`),
          sha256(`${OWNER_CORP_ID}\0developer-contributor`),
        ],
        conversationHash: sha256(canonical([
          CONVERSATION_ID,
          `${CONVERSATION_ID}-retry-reject`,
          `${CONVERSATION_ID}-cancel`,
          `${CONVERSATION_ID}-recovery`,
        ].sort())),
        transportEventHashes: events.map((event) => sha256(event.source_event_id)),
      },
      targetRepository: { defaultBranch: "main", initial: initialRepositoryState, final: finalRepositoryState },
      trustedCommands: [{ commandId: COMMAND_ID, definitionHash: evidence({ argv: targetArgv, network: "deny" }) }],
      trace: {
        primaryScenarioId: PRIMARY_SCENARIO_ID,
        scenarios: scenarioTraces,
        snapshotId: `${workItemId}-snapshot-${revisionState.snapshotRevision}`,
        planRevisionId: `${workItemId}-plan-${run.plan_revision}`,
        nodes: [{
          nodeId: run.node_id,
          runId: run.id,
          attemptIds: [`${run.id}-attempt-${run.attempt}`],
          baseSha: run.base_sha,
          resultSha: run.result_sha,
          managedBranch: run.branch,
          changedPaths: execution.changedPaths,
          tests: testRows.map((test) => ({
            commandId: COMMAND_ID,
            exitCode: test.exit_code,
            evidenceHash: evidence(test),
          })),
        }, {
          nodeId: recoveredRun.node_id,
          runId: recoveredRun.id,
          attemptIds: [`${recoveredRun.id}-attempt-${recoveredRun.attempt}`],
          baseSha: recoveredRun.base_sha,
          resultSha: recoveredRun.result_sha,
          managedBranch: recoveredRun.branch,
          changedPaths: [],
          tests: [],
        }, ...supportingNodeTraces],
      },
      controlPolicy: { ownerOutcomes, nonOwnerOutcomes },
      outbox: {
        retries: { status: "pass", attempts: delivery.calls.length, evidenceHash: outboxEvidence },
        supersession: { status: "pass", supersededCount: superseded.count, evidenceHash: evidence(superseded) },
      },
      recovery: {
        status: "pass",
        restartCount: 1,
        recoveredRunIds: [classifiedRecovery.runId],
        evidenceHash: recoveryEvidence,
      },
      audit: { eventIds: auditRows.map((row) => String(row.id)), chainHash: auditEvidence },
      checks: buildChecks({
        e2e_1_group_contributions: [ingressEvidence],
        e2e_2_structured_work_item: [planningEvidence],
        e2e_3_plan_to_candidate: [candidateEvidence],
        e2e_4_isolated_worktree: [repositoryEvidence, candidateEvidence],
        e2e_5_plan_revision: [planningEvidence],
        e2e_7_quality_reporting: [candidateEvidence],
        e2e_8_unauthorized_control: [controlsEvidence, auditEvidence],
        e2e_10_restart_recovery: [recoveryEvidence, outboxEvidence, lowDiskEvidence],
      }),
      deviations: [{
        id: "dingtalk_stream_prerelease",
        status: "pending",
        expected: "dingtalk-stream@2.1.6",
        actual: "dingtalk-stream@2.1.6-beta.1",
        evidenceHash: sha256("package.json:dingtalk-stream@2.1.6-beta.1"),
      }],
      pendingRealChecks: [...AUTOMATED_FAKE_PENDING_CHECKS],
      ownerSignOff: { status: "pending", ownerIdentityHash, signedAt: null, evidenceHash: null },
    };
    validateAcceptanceReport(report);
    return { report, scratchDirectory, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
