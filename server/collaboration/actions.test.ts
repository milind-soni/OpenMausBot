import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { DingTalkInboundMessage, DingTalkSender } from "../integrations/dingtalk/types.ts";
import { startCollaborationService, type CollaborationService } from "./service.ts";

const scratch: string[] = [];
const CANDIDATE_SHA = "a".repeat(40);

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function ownerSender(staffId = "owner-1"): DingTalkSender {
  return {
    senderCorpId: "corp-1",
    senderStaffId: staffId,
    senderId: `sender-${staffId}`,
    displayName: "Owner",
  };
}

function contributorSender(): DingTalkSender {
  return {
    senderCorpId: "corp-1",
    senderStaffId: "contributor-1",
    senderId: "sender-contributor-1",
    displayName: "Contributor",
  };
}

function message(input: {
  sourceEventId: string;
  text: string;
  sender?: DingTalkSender;
  replyToSourceEventId?: string;
}): DingTalkInboundMessage {
  return {
    sourceEventId: input.sourceEventId,
    transportMessageId: `transport-${input.sourceEventId}`,
    conversationId: "control-conversation",
    addressedToBot: true,
    text: input.text,
    ...(input.replyToSourceEventId ? { replyToSourceEventId: input.replyToSourceEventId } : {}),
    sender: input.sender ?? contributorSender(),
    receivedAt: 1_000,
  };
}

function harness(): {
  root: string;
  databaseFile: string;
  service: CollaborationService;
  workItemId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "openmausbot-owner-action-"));
  scratch.push(root);
  const service = startCollaborationService({ dataDirectory: root });
  service.bootstrapOwnerLocally({ senderCorpId: "corp-1", senderStaffId: "owner-1", now: 500 });
  const accepted = service.ingestDingTalkMessage(message({ sourceEventId: "event-1", text: "Create controlled task" }));
  if (!accepted.workItemId) throw new Error("Expected Work Item");
  return {
    root,
    databaseFile: join(root, "collaboration", "collaboration.sqlite"),
    service,
    workItemId: accepted.workItemId,
  };
}

function seedExecution(
  databaseFile: string,
  workItemId: string,
  input: {
    runStatus?: "running" | "succeeded";
    candidateState?: "target_tests_passed" | "test_failed" | "not_verified";
    evidence?: boolean;
  } = {},
): { runId: string; candidateSha: string } {
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA foreign_keys = ON");
  const item = database.prepare("SELECT version FROM collaboration_work_items WHERE id = ?").get(workItemId) as {
    version: number;
  };
  database
    .prepare(
      "INSERT INTO collaboration_work_item_snapshots " +
        "(work_item_id, revision, source_work_item_version, goal, goal_confirmed, repository, facts_json, " +
        "assumptions_json, acceptance_json, blocking_ambiguities_json, created_at) " +
        "VALUES (?, 1, ?, 'Fix fixture', 1, '/tmp/repo', '[]', '[]', ?, '[]', 1000)",
    )
    .run(workItemId, item.version, JSON.stringify([{ description: "passes", observation: "target command" }]));
  database
    .prepare(
      "INSERT INTO collaboration_plan_revisions " +
        "(id, work_item_id, revision, snapshot_revision, status, summary, proposal_hash, created_at) " +
        "VALUES (?, ?, 1, 1, 'published', 'fixture plan', 'hash', 1000)",
    )
    .run(randomUUID(), workItemId);
  const insertNode = database.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, input_evidence_json, " +
      "instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, expected_artifacts_json, " +
      "completion_definition, risk, budget_json, execution_status, created_at) " +
      "VALUES (?, 1, ?, ?, ?, 'developer-1', 'fixture', '[]', 'fixture', '[]', '[]', '[]', ?, '[]', " +
      "'done', 'low', '{}', ?, 1000)",
  );
  insertNode.run(workItemId, "analyze", "analyze", "ready", "[]", "candidate_ready");
  insertNode.run(
    workItemId,
    "modify",
    "modify",
    "pending",
    "[]",
    input.runStatus === "running" ? "running" : (input.candidateState === "target_tests_passed" ? "candidate_ready" : "failed"),
  );
  insertNode.run(workItemId, "validate", "validate", "pending", JSON.stringify(["target"]), "candidate_ready");
  insertNode.run(workItemId, "report", "report", "pending", "[]", "candidate_ready");
  database
    .prepare(
      "UPDATE collaboration_work_items SET definition_status = 'ready_for_execution', current_plan_revision = 1 WHERE id = ?",
    )
    .run(workItemId);
  const runId = randomUUID();
  const runStatus = input.runStatus ?? "succeeded";
  database
    .prepare(
      "INSERT INTO collaboration_runs " +
        "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
        "worktree_path, branch, base_sha, result_sha, started_at, finished_at) " +
        "VALUES (?, ?, 1, 'modify', 1, 'developer-1', 'thread', 'turn', ?, '/tmp/repo', '/tmp/worktree', " +
        "'ai/fixture', ?, ?, 1000, ?)",
    )
    .run(runId, workItemId, runStatus, "b".repeat(40), runStatus === "succeeded" ? CANDIDATE_SHA : null, runStatus === "succeeded" ? 1100 : null);
  if (input.candidateState) {
    database
      .prepare(
        "INSERT INTO collaboration_candidates " +
          "(id, run_id, state, base_sha, result_sha, changed_paths_json, violations_json, quality_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, '[\"src/value.ts\"]', '[]', '{}', 1100)",
      )
      .run(randomUUID(), runId, input.candidateState, "b".repeat(40), CANDIDATE_SHA);
    if (input.evidence ?? input.candidateState === "target_tests_passed") {
      database
        .prepare(
          "INSERT INTO collaboration_test_evidence " +
            "(id, run_id, command_id, argv_json, cwd, exit_code, duration_ms, stdout, stderr, state, created_at) " +
            "VALUES (?, ?, 'target', '[\"test\"]', '/tmp/worktree', 0, 5, 'ok', '', 'target_passed', 1100)",
        )
        .run(randomUUID(), runId);
    }
  }
  database.close();
  return { runId, candidateSha: CANDIDATE_SHA };
}

function item(databaseFile: string, workItemId: string): Record<string, unknown> {
  const database = new DatabaseSync(databaseFile);
  const row = database
    .prepare(
      "SELECT status, version, control_state, current_plan_revision, accepted_candidate_sha FROM collaboration_work_items WHERE id = ?",
    )
    .get(workItemId) as Record<string, unknown>;
  database.close();
  return row;
}

describe("Owner action tokens and Work Item controls", () => {
  it("denies contributors without consuming the opaque token and returns the Owner's decision on replay", () => {
    const context = harness();
    const issued = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 1,
      now: 2_000,
    });
    const database = new DatabaseSync(context.databaseFile);
    const persisted = database.prepare("SELECT token_hash, consumed_at FROM collaboration_action_tokens").get() as {
      token_hash: string;
      consumed_at: number | null;
    };
    expect(persisted.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted.token_hash).not.toContain(issued.token);
    expect(persisted.consumed_at).toBeNull();
    expect(JSON.stringify(database.prepare("SELECT * FROM collaboration_action_tokens").get())).not.toContain(issued.token);
    database.close();

    expect(context.service.performOwnerAction({
      actionToken: issued.token,
      sender: contributorSender(),
      now: 2_100,
    })).toMatchObject({ allowed: false, reason: "not_active_owner" });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ version: 1, control_state: "active" });
    const deniedAudit = new DatabaseSync(context.databaseFile);
    expect(deniedAudit
      .prepare("SELECT outcome, error FROM collaboration_audit_events WHERE action = 'control.pause' AND outcome = 'deny'")
      .get()).toEqual({ outcome: "deny", error: "not_active_owner" });
    deniedAudit.close();

    const applied = context.service.performOwnerAction({ actionToken: issued.token, sender: ownerSender(), now: 2_200 });
    expect(applied).toMatchObject({
      allowed: true,
      duplicate: false,
      action: "pause",
      workItemVersion: 2,
      controlState: "paused",
    });
    expect(context.service.performOwnerAction({
      actionToken: issued.token,
      sender: ownerSender(),
      now: 2_300,
    })).toMatchObject({ allowed: true, duplicate: true, workItemVersion: 2, controlState: "paused" });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ version: 2, control_state: "paused" });

    const resume = context.service.issueOwnerAction({
      action: "resume",
      workItemId: context.workItemId,
      expectedVersion: 2,
      now: 2_400,
    });
    expect(context.service.performOwnerAction({
      actionToken: resume.token,
      sender: ownerSender(),
      now: 2_500,
    })).toMatchObject({ allowed: true, controlState: "active", workItemVersion: 3 });
    context.service.close();
  });

  it("consumes stale Owner actions once and invalidates old cards after local recovery", () => {
    const context = harness();
    const stale = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 1,
      now: 2_000,
    });
    context.service.ingestDingTalkMessage(
      message({ sourceEventId: "event-2", text: "More evidence", replyToSourceEventId: "event-1" }),
    );
    expect(context.service.performOwnerAction({
      actionToken: stale.token,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: false, reason: "work_item_version_changed", workItemVersion: 2 });
    expect(context.service.performOwnerAction({
      actionToken: stale.token,
      sender: ownerSender(),
      now: 2_200,
    })).toMatchObject({ allowed: false, duplicate: true, reason: "work_item_version_changed" });

    const expiring = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 2,
      ttlMs: 1_000,
      now: 2_300,
    });
    expect(context.service.performOwnerAction({
      actionToken: expiring.token,
      sender: ownerSender(),
      now: 3_300,
    })).toMatchObject({ allowed: false, reason: "action_token_expired" });

    const oldOwnerCard = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 2,
      now: 3_400,
    });
    context.service.recoverOwnerLocally({
      expectedGeneration: 1,
      senderCorpId: "corp-1",
      senderStaffId: "owner-2",
      now: 3_500,
    });
    expect(context.service.performOwnerAction({
      actionToken: oldOwnerCard.token,
      sender: ownerSender("owner-2"),
      now: 3_600,
    })).toMatchObject({ allowed: false, reason: "owner_generation_changed" });
    expect(context.service.performOwnerAction({
      actionToken: "forged-token",
      sender: ownerSender("owner-2"),
      now: 3_700,
    })).toMatchObject({ allowed: false, reason: "invalid_action_token" });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ version: 2, control_state: "active" });
    context.service.close();
  });

  it("accepts only the current candidate with every required target-test evidence row", () => {
    const context = harness();
    seedExecution(context.databaseFile, context.workItemId, { candidateState: "target_tests_passed", evidence: true });
    const accept = context.service.issueOwnerAction({
      action: "accept",
      workItemId: context.workItemId,
      expectedVersion: 1,
      candidateSha: CANDIDATE_SHA,
      now: 2_000,
    });
    expect(context.service.performOwnerAction({
      actionToken: accept.token,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: true, action: "accept", controlState: "accepted", candidateSha: CANDIDATE_SHA });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({
      status: "accepted",
      version: 2,
      control_state: "accepted",
      current_plan_revision: 1,
      accepted_candidate_sha: CANDIDATE_SHA,
    });
    const database = new DatabaseSync(context.databaseFile);
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_candidates").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_test_evidence").get()).toEqual({ count: 1 });
    database.close();
    context.service.close();

    const missing = harness();
    seedExecution(missing.databaseFile, missing.workItemId, { candidateState: "target_tests_passed", evidence: false });
    expect(() =>
      missing.service.issueOwnerAction({
        action: "accept",
        workItemId: missing.workItemId,
        expectedVersion: 1,
        candidateSha: CANDIDATE_SHA,
        now: 2_000,
      }),
    ).toThrow("required_evidence_missing");
    missing.service.close();
  });

  it("requires rejection feedback, preserves candidates, creates a new revision, and keeps cancellation separate", () => {
    const rejected = harness();
    seedExecution(rejected.databaseFile, rejected.workItemId, { candidateState: "test_failed", evidence: false });
    const missingReason = rejected.service.issueOwnerAction({
      action: "reject",
      workItemId: rejected.workItemId,
      expectedVersion: 1,
      candidateSha: CANDIDATE_SHA,
      now: 2_000,
    });
    expect(rejected.service.performOwnerAction({
      actionToken: missingReason.token,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: false, reason: "Reject requires a reason" });
    const reject = rejected.service.issueOwnerAction({
      action: "reject",
      workItemId: rejected.workItemId,
      expectedVersion: 1,
      candidateSha: CANDIDATE_SHA,
      now: 2_200,
    });
    expect(rejected.service.performOwnerAction({
      actionToken: reject.token,
      sender: ownerSender(),
      reason: "错误提示仍然不符合验收条件",
      now: 2_300,
    })).toMatchObject({
      allowed: true,
      action: "reject",
      workItemVersion: 2,
      controlState: "active",
      revisedSnapshotRevision: 2,
    });
    expect(item(rejected.databaseFile, rejected.workItemId)).toMatchObject({
      status: "collecting",
      version: 2,
      control_state: "active",
      current_plan_revision: null,
    });
    const rejectedDb = new DatabaseSync(rejected.databaseFile);
    expect(rejectedDb.prepare("SELECT count(*) AS count FROM collaboration_candidates").get()).toEqual({ count: 1 });
    expect(rejectedDb.prepare("SELECT count(*) AS count FROM collaboration_work_item_snapshots").get()).toEqual({ count: 2 });
    expect(rejectedDb.prepare("SELECT action, reason FROM collaboration_control_events").get()).toEqual({
      action: "reject",
      reason: "错误提示仍然不符合验收条件",
    });
    expect((rejectedDb.prepare("SELECT facts_json FROM collaboration_work_item_snapshots WHERE revision = 2").get() as {
      facts_json: string;
    }).facts_json).toContain("错误提示仍然不符合验收条件");
    rejectedDb.close();
    rejected.service.close();

    const cancelled = harness();
    seedExecution(cancelled.databaseFile, cancelled.workItemId, { candidateState: "test_failed", evidence: false });
    const cancel = cancelled.service.issueOwnerAction({
      action: "cancel",
      workItemId: cancelled.workItemId,
      expectedVersion: 1,
      now: 3_000,
    });
    expect(cancelled.service.performOwnerAction({
      actionToken: cancel.token,
      sender: ownerSender(),
      now: 3_100,
    })).toMatchObject({ allowed: true, action: "cancel", controlState: "cancelled", revisedSnapshotRevision: null });
    const cancelledDb = new DatabaseSync(cancelled.databaseFile);
    expect(cancelledDb.prepare("SELECT count(*) AS count FROM collaboration_work_item_snapshots").get()).toEqual({ count: 1 });
    expect(cancelledDb.prepare("SELECT action, reason FROM collaboration_control_events").get()).toEqual({
      action: "cancel",
      reason: null,
    });
    cancelledDb.close();
    cancelled.service.close();
  });

  it("rolls back state and interrupt requests when the mandatory audit insert fails", () => {
    const context = harness();
    const running = seedExecution(context.databaseFile, context.workItemId, { runStatus: "running" });
    const pause = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 1,
      now: 2_000,
    });
    const database = new DatabaseSync(context.databaseFile);
    database.exec(`
      CREATE TRIGGER reject_pause_audit
      BEFORE INSERT ON collaboration_audit_events
      WHEN NEW.action = 'control.pause'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `);
    database.close();
    expect(() =>
      context.service.performOwnerAction({ actionToken: pause.token, sender: ownerSender(), now: 2_100 }),
    ).toThrow("audit unavailable");
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ version: 1, control_state: "active" });
    const afterFailure = new DatabaseSync(context.databaseFile);
    expect(afterFailure.prepare("SELECT consumed_at FROM collaboration_action_tokens WHERE token_hash IS NOT NULL").get()).toEqual({
      consumed_at: null,
    });
    expect(afterFailure.prepare("SELECT interrupt_requested_at FROM collaboration_runs WHERE id = ?").get(running.runId)).toEqual({
      interrupt_requested_at: null,
    });
    afterFailure.exec("DROP TRIGGER reject_pause_audit");
    afterFailure.close();

    const applied = context.service.performOwnerAction({ actionToken: pause.token, sender: ownerSender(), now: 2_200 });
    expect(applied).toMatchObject({ allowed: true, controlState: "paused" });
    expect(applied.interruptRequestedRunIds).toEqual([running.runId]);
    const afterSuccess = new DatabaseSync(context.databaseFile);
    expect(afterSuccess.prepare("SELECT interrupt_requested_at FROM collaboration_runs WHERE id = ?").get(running.runId)).toEqual({
      interrupt_requested_at: 2_200,
    });
    expect(afterSuccess.prepare("SELECT DISTINCT control_state FROM collaboration_work_nodes").all()).toEqual([
      { control_state: "paused" },
    ]);
    afterSuccess.close();
    context.service.close();
  });

  it("records an Owner retry request while preserving the failed candidate", () => {
    const context = harness();
    seedExecution(context.databaseFile, context.workItemId, { candidateState: "test_failed", evidence: false });
    const retry = context.service.issueOwnerAction({
      action: "retry",
      workItemId: context.workItemId,
      expectedVersion: 1,
      now: 2_000,
    });
    expect(context.service.performOwnerAction({
      actionToken: retry.token,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: true, action: "retry", workItemVersion: 2, controlState: "active" });
    const database = new DatabaseSync(context.databaseFile);
    expect(database.prepare("SELECT execution_status FROM collaboration_work_nodes WHERE node_id = 'modify'").get()).toEqual({
      execution_status: "not_started",
    });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_candidates").get()).toEqual({ count: 1 });
    database.close();
    context.service.close();
  });
});
