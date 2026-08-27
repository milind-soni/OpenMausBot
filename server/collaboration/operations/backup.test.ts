import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { startCollaborationService } from "../service.ts";
import { InstanceLeaseCoordinator } from "../leases.ts";
import { OutboxDispatcher } from "../outbox-dispatcher.ts";
import { enqueueInboundCard } from "../outbox.ts";
import { ProviderCircuitBreaker } from "../provider-circuit.ts";
import { FencedScheduler } from "../scheduler.ts";
import {
  createEncryptedLedgerBackup,
  rearmReviewedLedger,
  restoreEncryptedLedgerForReview,
} from "./backup.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "collaboration-backup-"));
  scratch.push(root);
  return root;
}

function key(path: string, byte: number): void {
  writeFileSync(path, Buffer.alloc(32, byte).toString("base64"), { mode: 0o600 });
}

describe("encrypted collaboration ledger backup", () => {
  it("uses online backup and restores only into an isolated, execution-gated review copy", async () => {
    const root = directory();
    const data = join(root, "data");
    const service = startCollaborationService({ dataDirectory: data });
    service.ingestDingTalkMessage({
      sourceEventId: "backup-event",
      transportMessageId: "backup-transport",
      conversationId: "backup-conversation",
      addressedToBot: true,
      text: "backup work",
      sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "User" },
      receivedAt: 1,
    });
    const live = join(data, "collaboration", "collaboration.sqlite");
    const setup = new DatabaseSync(live);
    setup.exec("PRAGMA foreign_keys = OFF");
    setup.prepare(
      "INSERT INTO collaboration_work_nodes " +
        "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, input_evidence_json, " +
        "instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, expected_artifacts_json, " +
        "completion_definition, risk, budget_json, created_at, runtime_state) " +
        "VALUES ('RESTORE-WI', 1, 'modify', 'modify', 'ready', 'developer', 'restore', '[]', 'restore', '[]', '[]', " +
        "'[]', '[]', '[]', 'done', 'low', '{}', 1, 'running')",
    ).run();
    setup.prepare(
      "INSERT INTO collaboration_runs " +
        "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
        "worktree_path, branch, base_sha, started_at) VALUES ('RESTORE-RUN', 'RESTORE-WI', 1, 'modify', 1, " +
        "'developer', 'thread', 'turn', 'running', '/repo', '/worktree', 'branch', ?, 1)",
    ).run("a".repeat(40));
    setup.close();

    const keyFile = join(root, "backup.key");
    const artifact = join(root, "ledger.ombbak");
    key(keyFile, 7);
    const result = await createEncryptedLedgerBackup({
      liveDatabasePath: live,
      outputPath: artifact,
      encryptionKeyFile: keyFile,
      temporaryDirectory: join(root, "tmp"),
    });
    expect(result).toMatchObject({ outputPath: artifact, schemaVersion: 8 });
    expect(readFileSync(artifact).includes(Buffer.from("backup work"))).toBe(false);
    expect(service.health().ready).toBe(true);
    service.close();

    const restored = restoreEncryptedLedgerForReview({
      backupPath: artifact,
      encryptionKeyFile: keyFile,
      reviewRoot: join(root, "reviews"),
    });
    expect(restored.gated).toMatchObject({ outbox: 1, runs: 1, nodes: 1 });
    expect(restored.databasePath).not.toBe(live);
    const review = new DatabaseSync(restored.databasePath, { readOnly: true });
    expect(review.prepare("SELECT delivery_state, last_error FROM collaboration_outbox").get()).toEqual({
      delivery_state: "dead_letter",
      last_error: "restore_review_required",
    });
    expect(review.prepare("SELECT status, recovery_state FROM collaboration_runs WHERE id = 'RESTORE-RUN'").get()).toEqual({
      status: "needs_configuration",
      recovery_state: "unsafe_to_retry",
    });
    review.close();

    const restoredService = startCollaborationService({ dataDirectory: restored.reviewDirectory });
    expect(restoredService.health()).toMatchObject({
      status: "degraded",
      ready: false,
      degradation: { reason: "restore_review_required" },
    });
    const message = {
      sourceEventId: "blocked-event",
      transportMessageId: "blocked-transport",
      conversationId: "blocked-conversation",
      addressedToBot: true,
      text: "must stay blocked",
      sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "User" },
      receivedAt: 50,
    };
    expect(() => restoredService.ingestDingTalkMessage(message)).toThrow("restore_review_required");
    expect(() => restoredService.reviseWorkItemDefinition("RESTORE-WI", {}, 50)).toThrow("restore_review_required");
    await expect(restoredService.executeCurrentPlan("RESTORE-WI", 1, 50)).rejects.toThrow("restore_review_required");
    expect(() =>
      restoredService.issueOwnerAction({ action: "pause", workItemId: "RESTORE-WI", expectedVersion: 1, now: 50 }),
    ).toThrow("restore_review_required");
    expect(() =>
      restoredService.performOwnerAction({
        actionToken: "not-a-token",
        sender: message.sender,
        now: 50,
      }),
    ).toThrow("restore_review_required");

    const guarded = new DatabaseSync(restored.databasePath);
    const lease = new InstanceLeaseCoordinator(guarded, "review-runtime").acquire(50, 1_000)!;
    const scheduler = new FencedScheduler(
      guarded,
      new ProviderCircuitBreaker(guarded, { failureThreshold: 2, openDurationMs: 100, maxOpenDurationMs: 1_000 }),
    );
    expect(() =>
      scheduler.claimReadyNode(lease, {
        workItemId: "RESTORE-WI",
        planRevision: 1,
        nodeId: "modify",
        providerId: "provider",
        nodeLeaseTtlMs: 100,
        now: 50,
      }),
    ).toThrow("restore_review_required");
    enqueueInboundCard(guarded, {
      sourceEventId: "post-restore-row",
      aggregateType: "plan",
      aggregateId: "RESTORE-WI",
      aggregateVersion: 99,
      card: {
        type: "plan_status_card",
        headline: "must not send",
        workItemId: "RESTORE-WI",
        planRevision: 99,
        status: "ready_for_execution",
        sequence: ["analyze", "modify", "validate", "report"],
      },
      now: 50,
    });
    let deliveries = 0;
    const dispatcher = new OutboxDispatcher(
      guarded,
      { async deliver() { deliveries += 1; return { outcome: "sent" }; } },
      { maxAttempts: 2, claimTtlMs: 100, baseBackoffMs: 10, maxBackoffMs: 100 },
    );
    await expect(dispatcher.dispatchOne(lease, 51)).rejects.toThrow("restore_review_required");
    expect(deliveries).toBe(0);
    guarded.close();

    expect(() =>
      rearmReviewedLedger({
        reviewRoot: join(root, "reviews"),
        reviewDatabasePath: restored.databasePath,
        expectedBackupHash: "0".repeat(64),
        confirmation: "REARM_REVIEWED_LEDGER",
        localActor: "local-owner",
        now: 60,
      }),
    ).toThrow("restore_rearm_guard_mismatch");
    expect(
      rearmReviewedLedger({
        reviewRoot: join(root, "reviews"),
        reviewDatabasePath: restored.databasePath,
        expectedBackupHash: restored.sourceBackupHash,
        confirmation: "REARM_REVIEWED_LEDGER",
        localActor: "local-owner",
        now: 60,
      }),
    ).toEqual({ state: "live", rearmedAt: 60, rearmedBy: "local-owner" });
    expect(deliveries).toBe(0);
    expect(restoredService.health()).toMatchObject({ status: "healthy", ready: true });
    restoredService.close();
  });

  it("rejects tampering and a wrong key before creating a review database", async () => {
    const root = directory();
    const service = startCollaborationService({ dataDirectory: join(root, "data") });
    const live = join(root, "data", "collaboration", "collaboration.sqlite");
    const keyFile = join(root, "key");
    const wrongKey = join(root, "wrong-key");
    const artifact = join(root, "ledger.ombbak");
    key(keyFile, 1);
    key(wrongKey, 2);
    await createEncryptedLedgerBackup({
      liveDatabasePath: live,
      outputPath: artifact,
      encryptionKeyFile: keyFile,
      temporaryDirectory: join(root, "tmp"),
    });
    service.close();
    expect(() =>
      restoreEncryptedLedgerForReview({ backupPath: artifact, encryptionKeyFile: wrongKey, reviewRoot: join(root, "wrong") }),
    ).toThrow("authentication");
    const tampered = readFileSync(artifact);
    tampered[tampered.length - 1]! ^= 1;
    writeFileSync(artifact, tampered, { mode: 0o600 });
    expect(() =>
      restoreEncryptedLedgerForReview({ backupPath: artifact, encryptionKeyFile: keyFile, reviewRoot: join(root, "tampered") }),
    ).toThrow("authentication");
  });
});
