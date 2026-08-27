import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { DingTalkSender } from "../integrations/dingtalk/types.ts";
import { appendControlAudit } from "./audit.ts";
import {
  capabilityForAction,
  evaluateOwnerPolicy,
  type WorkItemControlAction,
} from "./policy.ts";
import { assertLedgerArmed } from "./restore-guard.ts";

const TOKEN_VERSION = 1 as const;
const DEFAULT_TOKEN_TTL_MS = 15 * 60_000;
const MAX_TOKEN_TTL_MS = 30 * 60_000;
const MIN_TOKEN_TTL_MS = 1_000;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type WorkItemControlState = "active" | "paused" | "cancelled" | "accepted";

export interface IssuedOwnerAction {
  token: string;
  tokenVersion: typeof TOKEN_VERSION;
  action: WorkItemControlAction;
  workItemId: string;
  aggregateVersion: number;
  candidateSha: string | null;
  expiresAt: number;
}

export interface IssueOwnerActionInput {
  action: WorkItemControlAction;
  workItemId: string;
  expectedVersion: number;
  candidateSha?: string;
  ttlMs?: number;
  now?: number;
}

export interface PerformOwnerActionInput {
  actionToken: string;
  sender: DingTalkSender;
  reason?: string;
  now?: number;
}

export interface OwnerActionOutcome {
  allowed: boolean;
  duplicate: boolean;
  action: WorkItemControlAction | null;
  workItemId: string | null;
  workItemVersion: number | null;
  controlState: WorkItemControlState | null;
  candidateSha: string | null;
  reason: string;
  revisedSnapshotRevision: number | null;
  interruptRequestedRunIds: string[];
}

interface ActionTokenRow {
  id: string;
  token_version: number;
  action: WorkItemControlAction;
  work_item_id: string;
  aggregate_version: number;
  candidate_sha: string | null;
  owner_generation: number;
  expires_at: number;
  consumed_at: number | null;
  decision_json: string | null;
}

interface WorkItemRow {
  id: string;
  status: "collecting" | "waiting_clarification" | "cancelled" | "accepted";
  version: number;
  control_state: WorkItemControlState;
  current_plan_revision: number | null;
}

interface CandidateRow {
  id: string;
  run_id: string;
  state: "target_tests_passed" | "test_failed" | "not_verified" | "invalid" | "needs_configuration";
  result_sha: string;
}

interface SnapshotRow {
  revision: number;
  goal: string | null;
  goal_confirmed: number;
  repository: string | null;
  facts_json: string;
  assumptions_json: string;
  acceptance_json: string;
  blocking_ambiguities_json: string;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function stateHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function tokenTtl(ttlMs: number | undefined): number {
  const value = ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  if (!Number.isInteger(value) || value < MIN_TOKEN_TTL_MS || value > MAX_TOKEN_TTL_MS) {
    throw new Error(`Action token TTL must be between ${MIN_TOKEN_TTL_MS} and ${MAX_TOKEN_TTL_MS} milliseconds`);
  }
  return value;
}

function rejectionReason(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error("Reject requires a reason");
  if (normalized.length > 2_000) throw new Error("Reject reason exceeds 2000 characters");
  return normalized;
}

function readWorkItem(database: DatabaseSync, workItemId: string): WorkItemRow {
  const row = database
    .prepare(
      "SELECT id, status, version, control_state, current_plan_revision " +
        "FROM collaboration_work_items WHERE id = ?",
    )
    .get(workItemId) as WorkItemRow | undefined;
  if (!row) throw new Error(`Unknown Work Item: ${workItemId}`);
  return row;
}

function readCandidate(
  database: DatabaseSync,
  workItem: WorkItemRow,
  candidateSha: string,
): CandidateRow | null {
  if (workItem.current_plan_revision === null) return null;
  return (
    (database
      .prepare(
        "SELECT c.id, c.run_id, c.state, c.result_sha " +
          "FROM collaboration_candidates c JOIN collaboration_runs r ON r.id = c.run_id " +
          "WHERE r.work_item_id = ? AND r.plan_revision = ? AND c.result_sha = ? " +
          "ORDER BY c.created_at DESC LIMIT 1",
      )
      .get(workItem.id, workItem.current_plan_revision, candidateSha) as CandidateRow | undefined) ?? null
  );
}

function hasRequiredEvidence(database: DatabaseSync, workItem: WorkItemRow, candidate: CandidateRow): boolean {
  if (candidate.state !== "target_tests_passed" || workItem.current_plan_revision === null) return false;
  const validate = database
    .prepare(
      "SELECT commands_json FROM collaboration_work_nodes " +
        "WHERE work_item_id = ? AND plan_revision = ? AND node_type = 'validate' AND active = 1",
    )
    .get(workItem.id, workItem.current_plan_revision) as { commands_json: string } | undefined;
  if (!validate) return false;
  const required = JSON.parse(validate.commands_json) as unknown;
  if (!Array.isArray(required) || required.length === 0 || required.some((value) => typeof value !== "string")) return false;
  const evidence = database
    .prepare("SELECT command_id, state FROM collaboration_test_evidence WHERE run_id = ?")
    .all(candidate.run_id) as unknown as Array<{ command_id: string; state: string }>;
  const passed = new Set(evidence.filter((item) => item.state === "target_passed").map((item) => item.command_id));
  return required.every((commandId) => passed.has(commandId));
}

function hasRetryableResult(database: DatabaseSync, workItem: WorkItemRow): boolean {
  if (workItem.current_plan_revision === null) return false;
  const row = database
    .prepare(
      "SELECT 1 FROM collaboration_work_nodes WHERE work_item_id = ? AND plan_revision = ? AND active = 1 " +
        "AND execution_status IN ('invalid', 'needs_configuration', 'failed') " +
        "UNION ALL " +
        "SELECT 1 FROM collaboration_candidates c JOIN collaboration_runs r ON r.id = c.run_id " +
        "WHERE r.work_item_id = ? AND r.plan_revision = ? " +
        "AND c.state IN ('test_failed', 'not_verified', 'invalid', 'needs_configuration') LIMIT 1",
    )
    .get(workItem.id, workItem.current_plan_revision, workItem.id, workItem.current_plan_revision);
  return Boolean(row);
}

function transitionProblem(
  database: DatabaseSync,
  action: WorkItemControlAction,
  workItem: WorkItemRow,
  candidate: CandidateRow | null,
): string | null {
  if (workItem.control_state === "accepted") return "work_item_already_accepted";
  if (workItem.control_state === "cancelled") return "work_item_cancelled";
  if (action === "pause") return workItem.control_state === "active" ? null : "work_item_not_active";
  if (action === "resume") return workItem.control_state === "paused" ? null : "work_item_not_paused";
  if (action === "retry") return hasRetryableResult(database, workItem) ? null : "work_item_not_retryable";
  if (action === "cancel") return null;
  if (!candidate) return "candidate_not_current";
  if (action === "accept" && !hasRequiredEvidence(database, workItem, candidate)) return "required_evidence_missing";
  return null;
}

function outcome(input: Partial<OwnerActionOutcome> & Pick<OwnerActionOutcome, "allowed" | "reason">): OwnerActionOutcome {
  return {
    allowed: input.allowed,
    duplicate: input.duplicate ?? false,
    action: input.action ?? null,
    workItemId: input.workItemId ?? null,
    workItemVersion: input.workItemVersion ?? null,
    controlState: input.controlState ?? null,
    candidateSha: input.candidateSha ?? null,
    reason: input.reason,
    revisedSnapshotRevision: input.revisedSnapshotRevision ?? null,
    interruptRequestedRunIds: input.interruptRequestedRunIds ?? [],
  };
}

export class OwnerActionController {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databaseFile: string) {
    this.database = new DatabaseSync(databaseFile);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 5) throw new Error("Owner action schema is not installed");
  }

  issue(input: IssueOwnerActionInput): IssuedOwnerAction {
    this.assertOpen();
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error("expectedVersion must be a positive integer");
    }
    const now = input.now ?? Date.now();
    const ttlMs = tokenTtl(input.ttlMs);
    const candidateSha = input.candidateSha?.trim().toLowerCase() ?? null;
    if ((input.action === "accept" || input.action === "reject") && (!candidateSha || !FULL_SHA.test(candidateSha))) {
      throw new Error(`${input.action} requires a full candidate SHA`);
    }
    if (input.action !== "accept" && input.action !== "reject" && candidateSha) {
      throw new Error(`${input.action} does not accept a candidate SHA`);
    }
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const expiresAt = now + ttlMs;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertLedgerArmed(this.database);
      const owner = this.database
        .prepare("SELECT generation FROM collaboration_owner_bindings WHERE active = 1")
        .get() as { generation: number } | undefined;
      if (!owner) throw new Error("No active Owner is configured");
      const workItem = readWorkItem(this.database, input.workItemId);
      if (workItem.version !== input.expectedVersion) throw new Error("Work Item version changed before action issuance");
      const candidate = candidateSha ? readCandidate(this.database, workItem, candidateSha) : null;
      const problem = transitionProblem(this.database, input.action, workItem, candidate);
      if (problem) throw new Error(`Action is not currently available: ${problem}`);
      this.database
        .prepare(
          "INSERT INTO collaboration_action_tokens " +
            "(id, token_version, token_hash, action, work_item_id, aggregate_version, candidate_sha, owner_generation, created_at, expires_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          TOKEN_VERSION,
          tokenHash(token),
          input.action,
          workItem.id,
          workItem.version,
          candidateSha,
          owner.generation,
          now,
          expiresAt,
        );
      appendControlAudit(this.database, {
        workItemId: workItem.id,
        requestId: id,
        action: "control.token_issued",
        outcome: "allow",
        policyRule: "opaque-owner-action-v1",
        resource: {
          tokenId: id,
          tokenVersion: TOKEN_VERSION,
          action: input.action,
          aggregateVersion: workItem.version,
          candidateSha,
          ownerGeneration: owner.generation,
          expiresAt,
        },
        now,
      });
      this.database.exec("COMMIT");
      return {
        token,
        tokenVersion: TOKEN_VERSION,
        action: input.action,
        workItemId: workItem.id,
        aggregateVersion: workItem.version,
        candidateSha,
        expiresAt,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  perform(input: PerformOwnerActionInput): OwnerActionOutcome {
    this.assertOpen();
    const now = input.now ?? Date.now();
    const requestId = randomUUID();
    const suppliedToken = input.actionToken.trim();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertLedgerArmed(this.database);
      const token = suppliedToken
        ? (this.database
            .prepare(
              "SELECT id, token_version, action, work_item_id, aggregate_version, candidate_sha, owner_generation, " +
                "expires_at, consumed_at, decision_json FROM collaboration_action_tokens WHERE token_hash = ?",
            )
            .get(tokenHash(suppliedToken)) as ActionTokenRow | undefined)
        : undefined;
      const policy = evaluateOwnerPolicy(this.database, {
        sender: input.sender,
        capability: token ? capabilityForAction(token.action) : "control.consume",
        now,
      });
      if (!token) {
        const denied = outcome({ allowed: false, reason: "invalid_action_token" });
        appendControlAudit(this.database, {
          actorPrincipalId: policy.principalId,
          requestId,
          action: "control.consume",
          outcome: "deny",
          policyRule: policy.ruleId,
          resource: { tokenRecognized: false },
          error: denied.reason,
          now,
        });
        this.database.exec("COMMIT");
        return denied;
      }
      if (policy.decision !== "allow") {
        const denied = outcome({
          allowed: false,
          action: token.action,
          workItemId: token.work_item_id,
          candidateSha: token.candidate_sha,
          reason: policy.reason,
        });
        appendControlAudit(this.database, {
          actorPrincipalId: policy.principalId,
          workItemId: token.work_item_id,
          requestId,
          action: `control.${token.action}`,
          outcome: "deny",
          policyRule: policy.ruleId,
          resource: { tokenId: token.id, aggregateVersion: token.aggregate_version },
          error: denied.reason,
          now,
        });
        this.database.exec("COMMIT");
        return denied;
      }
      if (policy.ownerGeneration !== token.owner_generation) {
        const denied = outcome({
          allowed: false,
          action: token.action,
          workItemId: token.work_item_id,
          candidateSha: token.candidate_sha,
          reason: "owner_generation_changed",
        });
        appendControlAudit(this.database, {
          actorPrincipalId: policy.principalId,
          workItemId: token.work_item_id,
          requestId,
          action: `control.${token.action}`,
          outcome: "deny",
          policyRule: "action-owner-generation-v1",
          resource: { tokenId: token.id, tokenOwnerGeneration: token.owner_generation },
          error: denied.reason,
          now,
        });
        this.database.exec("COMMIT");
        return denied;
      }
      if (token.consumed_at !== null) {
        if (!token.decision_json) throw new Error("Consumed action token has no decision");
        const previous = JSON.parse(token.decision_json) as OwnerActionOutcome;
        appendControlAudit(this.database, {
          actorPrincipalId: policy.principalId,
          workItemId: token.work_item_id,
          requestId,
          action: `control.${token.action}.replay`,
          outcome: previous.allowed ? "allow" : "deny",
          policyRule: "single-use-action-token-v1",
          resource: { tokenId: token.id, originalReason: previous.reason },
          now,
        });
        this.database.exec("COMMIT");
        return { ...previous, duplicate: true };
      }

      let deniedReason: string | null = null;
      let workItem: WorkItemRow | null = null;
      let candidate: CandidateRow | null = null;
      let reason: string | null = null;
      if (token.token_version !== TOKEN_VERSION) deniedReason = "unsupported_action_token_version";
      else if (now >= token.expires_at) deniedReason = "action_token_expired";
      else {
        workItem = readWorkItem(this.database, token.work_item_id);
        if (workItem.version !== token.aggregate_version) deniedReason = "work_item_version_changed";
        else {
          candidate = token.candidate_sha ? readCandidate(this.database, workItem, token.candidate_sha) : null;
          deniedReason = transitionProblem(this.database, token.action, workItem, candidate);
          if (!deniedReason && token.action === "reject") {
            try {
              reason = rejectionReason(input.reason);
            } catch (error) {
              deniedReason = error instanceof Error ? error.message : String(error);
            }
          }
        }
      }
      if (deniedReason) {
        const denied = outcome({
          allowed: false,
          action: token.action,
          workItemId: token.work_item_id,
          workItemVersion: workItem?.version ?? null,
          controlState: workItem?.control_state ?? null,
          candidateSha: token.candidate_sha,
          reason: deniedReason,
        });
        this.consumeToken(token.id, policy.principalId, "denied", denied, now);
        appendControlAudit(this.database, {
          actorPrincipalId: policy.principalId,
          workItemId: token.work_item_id,
          requestId,
          action: `control.${token.action}`,
          outcome: "deny",
          policyRule: "owner-action-preconditions-v1",
          resource: { tokenId: token.id, aggregateVersion: token.aggregate_version, candidateSha: token.candidate_sha },
          error: deniedReason,
          now,
        });
        this.database.exec("COMMIT");
        return denied;
      }
      if (!workItem) throw new Error("Action preconditions did not load a Work Item");
      const beforeHash = stateHash(workItem);
      const applied = this.applyAction(token, workItem, candidate, policy.principalId, reason, now);
      const allowed = outcome({
        allowed: true,
        action: token.action,
        workItemId: workItem.id,
        workItemVersion: applied.workItem.version,
        controlState: applied.workItem.control_state,
        candidateSha: token.candidate_sha,
        reason: "owner_action_applied",
        revisedSnapshotRevision: applied.revisedSnapshotRevision,
        interruptRequestedRunIds: applied.interruptRequestedRunIds,
      });
      this.consumeToken(token.id, policy.principalId, "allowed", allowed, now);
      this.database
        .prepare(
          "INSERT INTO collaboration_control_events " +
            "(id, work_item_id, work_item_version, action, principal_id, token_id, candidate_sha, reason, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          workItem.id,
          applied.workItem.version,
          token.action,
          policy.principalId,
          token.id,
          token.candidate_sha,
          reason,
          now,
        );
      appendControlAudit(this.database, {
        actorPrincipalId: policy.principalId,
        workItemId: workItem.id,
        requestId,
        action: `control.${token.action}`,
        outcome: "allow",
        policyRule: policy.ruleId,
        resource: {
          tokenId: token.id,
          aggregateVersion: token.aggregate_version,
          candidateSha: token.candidate_sha,
          interruptRequestedRunIds: applied.interruptRequestedRunIds,
        },
        beforeHash,
        afterHash: stateHash(applied.workItem),
        now,
      });
      this.database.exec("COMMIT");
      return allowed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private applyAction(
    token: ActionTokenRow,
    workItem: WorkItemRow,
    candidate: CandidateRow | null,
    principalId: string,
    reason: string | null,
    now: number,
  ): { workItem: WorkItemRow; revisedSnapshotRevision: number | null; interruptRequestedRunIds: string[] } {
    const interruptRequestedRunIds = ["pause", "cancel", "reject"].includes(token.action)
      ? ((this.database
          .prepare("SELECT id FROM collaboration_runs WHERE work_item_id = ? AND status = 'running'")
          .all(workItem.id) as unknown as Array<{ id: string }>).map((row) => row.id))
      : [];
    if (interruptRequestedRunIds.length) {
      this.database
        .prepare(
          "UPDATE collaboration_runs SET interrupt_requested_at = coalesce(interrupt_requested_at, ?), " +
            "version = version + 1 " +
            "WHERE work_item_id = ? AND status = 'running'",
        )
        .run(now, workItem.id);
    }
    let revisedSnapshotRevision: number | null = null;
    if (token.action === "pause") {
      this.updateWorkItem(workItem, "control_state = 'paused', paused_at = ?", [now], now);
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET control_state = 'paused', version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND active = 1 AND control_state = 'active'",
        )
        .run(workItem.id, workItem.current_plan_revision);
    } else if (token.action === "resume") {
      this.updateWorkItem(workItem, "control_state = 'active', paused_at = NULL", [], now);
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET control_state = 'active', " +
            "execution_status = CASE WHEN execution_status IN ('running', 'invalid', 'failed') " +
            "THEN 'not_started' ELSE execution_status END, version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND active = 1 AND control_state = 'paused'",
        )
        .run(workItem.id, workItem.current_plan_revision);
    } else if (token.action === "retry") {
      this.updateWorkItem(workItem, "control_state = 'active', paused_at = NULL", [], now);
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET control_state = 'active', " +
            "execution_status = CASE WHEN node_type IN ('modify', 'validate', 'report') " +
            "THEN 'not_started' ELSE execution_status END, version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
        )
        .run(workItem.id, workItem.current_plan_revision);
    } else if (token.action === "cancel") {
      this.updateWorkItem(
        workItem,
        "status = 'cancelled', control_state = 'cancelled', cancelled_at = ?, paused_at = NULL",
        [now],
        now,
      );
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET control_state = 'cancelled', version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
        )
        .run(workItem.id, workItem.current_plan_revision);
    } else if (token.action === "accept") {
      if (!candidate || !token.candidate_sha) throw new Error("Accept candidate disappeared during transition");
      this.updateWorkItem(
        workItem,
        "status = 'accepted', control_state = 'accepted', accepted_candidate_sha = ?, accepted_by = ?, accepted_at = ?, paused_at = NULL",
        [token.candidate_sha, principalId, now],
        now,
      );
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET control_state = 'cancelled', version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
        )
        .run(workItem.id, workItem.current_plan_revision);
    } else {
      if (!candidate || !token.candidate_sha || !reason) throw new Error("Reject transition lost its candidate or reason");
      revisedSnapshotRevision = this.appendRejectedSnapshot(workItem, token.candidate_sha, reason, now);
      this.updateWorkItem(
        workItem,
        "status = 'collecting', control_state = 'active', definition_status = 'collecting', " +
          "current_plan_revision = NULL, paused_at = NULL",
        [],
        now,
      );
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET active = 0, control_state = 'cancelled', version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
        )
        .run(workItem.id, workItem.current_plan_revision);
    }
    return {
      workItem: readWorkItem(this.database, workItem.id),
      revisedSnapshotRevision,
      interruptRequestedRunIds,
    };
  }

  private appendRejectedSnapshot(workItem: WorkItemRow, candidateSha: string, reason: string, now: number): number {
    const previous = this.database
      .prepare(
        "SELECT revision, goal, goal_confirmed, repository, facts_json, assumptions_json, acceptance_json, " +
          "blocking_ambiguities_json FROM collaboration_work_item_snapshots " +
          "WHERE work_item_id = ? ORDER BY revision DESC LIMIT 1",
      )
      .get(workItem.id) as SnapshotRow | undefined;
    if (!previous) throw new Error("Reject requires a current Work Item snapshot");
    const revision = previous.revision + 1;
    const feedback = `Owner rejected candidate ${candidateSha}: ${reason}`;
    const facts = JSON.parse(previous.facts_json) as unknown;
    if (!Array.isArray(facts)) throw new Error("Work Item snapshot facts are invalid");
    this.database
      .prepare(
        "INSERT INTO collaboration_work_item_snapshots " +
          "(work_item_id, revision, source_work_item_version, goal, goal_confirmed, repository, facts_json, " +
          "assumptions_json, acceptance_json, blocking_ambiguities_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        workItem.id,
        revision,
        workItem.version + 1,
        previous.goal,
        previous.goal_confirmed,
        previous.repository,
        JSON.stringify([...facts, feedback]),
        previous.assumptions_json,
        previous.acceptance_json,
        previous.blocking_ambiguities_json,
        now,
      );
    return revision;
  }

  private updateWorkItem(
    workItem: WorkItemRow,
    assignments: string,
    values: Array<string | number | null>,
    now: number,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE collaboration_work_items SET ${assignments}, version = version + 1, updated_at = ? ` +
          "WHERE id = ? AND version = ?",
      )
      .run(...values, now, workItem.id, workItem.version);
    if (Number(result.changes) !== 1) throw new Error("Work Item changed during Owner action");
  }

  private consumeToken(
    tokenId: string,
    principalId: string,
    consumedOutcome: "allowed" | "denied",
    decision: OwnerActionOutcome,
    now: number,
  ): void {
    const result = this.database
      .prepare(
        "UPDATE collaboration_action_tokens SET consumed_at = ?, consumed_by_principal_id = ?, " +
          "consumed_outcome = ?, decision_json = ? WHERE id = ? AND consumed_at IS NULL",
      )
      .run(now, principalId, consumedOutcome, JSON.stringify(decision), tokenId);
    if (Number(result.changes) !== 1) throw new Error("Action token was consumed concurrently");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Owner action controller is closed");
  }
}
