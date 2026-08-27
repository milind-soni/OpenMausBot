import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  containmentBindingHash,
  runtimeIdentityFingerprint,
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
} from "../containment.ts";
import { openCollaborationLedger } from "../db.ts";
import { markRestoredLedgerForReview } from "../restore-guard.ts";
import { CollaborationHeadlessRuntime, type RuntimeStream } from "./runtime.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "collaboration-runtime-"));
  scratch.push(path);
  return path;
}

function message(sourceEventId: string, receivedAt = 1_000) {
  return {
    sourceEventId,
    transportMessageId: `transport-${sourceEventId}`,
    conversationId: "conversation",
    addressedToBot: true,
    text: `work ${sourceEventId}`,
    sender: {
      senderCorpId: "corp",
      senderStaffId: "staff",
      senderId: "sender",
      displayName: "Contributor",
    },
    receivedAt,
  };
}

function seedRunningRun(dataDirectory: string, ownerId: string): { proof: ContainmentProof; binding: ContainmentBinding } {
  const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  database.exec("PRAGMA foreign_keys = OFF");
  const lease = database
    .prepare("SELECT fencing_token FROM collaboration_instance_lease WHERE owner_id = ?")
    .get(ownerId) as { fencing_token: number };
  const binding: ContainmentBinding = {
    runId: "RUN-SHUTDOWN",
    canonicalWorktreePath: "/managed/shutdown-worktree",
    instanceOwner: ownerId,
    instanceFence: lease.fencing_token,
    nonce: "shutdown-containment-nonce-000000000001",
  };
  const proof: ContainmentProof = {
    identity: {
      backend: "verified_service",
      opaqueId: "openmausbot-shutdown-scope-0001",
      hostGeneration: "boot-1",
      verifierVersion: "v1",
    },
    receipt: "trusted-receipt",
  };
  database.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, input_evidence_json, " +
      "instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, expected_artifacts_json, " +
      "completion_definition, risk, budget_json, created_at, runtime_state, lease_owner, lease_fence, lease_expires_at) " +
      "VALUES ('WI-SHUTDOWN', 1, 'modify', 'modify', 'ready', 'developer', 'shutdown', '[]', 'shutdown', '[]', '[]', " +
      "'[]', '[]', '[]', 'done', 'low', '{}', 1, 'running', ?, 1, 999999)",
  ).run(ownerId);
  database.prepare(
    "INSERT INTO collaboration_runs " +
      "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
      "worktree_path, branch, base_sha, started_at, runtime_identity_json, containment_state, instance_owner, " +
      "instance_fence, node_lease_fence, containment_binding_json, containment_fingerprint) " +
      "VALUES ('RUN-SHUTDOWN', 'WI-SHUTDOWN', 1, 'modify', 1, 'developer', 'thread', 'turn', 'running', '/repo', " +
      "'/managed/shutdown-worktree', 'branch', ?, 1, ?, 'verified', ?, ?, 1, ?, ?)",
  ).run(
    "a".repeat(40),
    JSON.stringify(proof),
    ownerId,
    lease.fencing_token,
    JSON.stringify(binding),
    runtimeIdentityFingerprint(proof.identity),
  );
  database.close();
  return { proof, binding };
}

describe("production-isomorphic collaboration runtime", () => {
  it("holds one fenced instance lease and can restart against the same durable ledger", async () => {
    const dataDirectory = temporaryDirectory();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, ownerId: "runtime-one", platform: "linux" });
    expect(await runtime.start()).toMatchObject({ state: "running", ready: true, instanceLease: "held" });
    runtime.ingestDingTalkMessage(message("persisted"));

    const competing = new CollaborationHeadlessRuntime({ dataDirectory, ownerId: "runtime-two", platform: "linux" });
    await expect(competing.start()).rejects.toThrow("instance_lease_unavailable");
    await runtime.stop();

    const delivered: string[] = [];
    const restarted = new CollaborationHeadlessRuntime({
      dataDirectory,
      ownerId: "runtime-three",
      platform: "linux",
      outboxDelivery: {
        async deliver(item) {
          delivered.push(item.dedupeKey);
          return { outcome: "sent" };
        },
      },
    });
    await restarted.start();
    expect(await restarted.drainOnce()).toMatchObject({ dispatched: { state: "sent" } });
    expect(delivered).toEqual(["dingtalk:event:persisted:ack"]);
    await restarted.stop();
  });

  it("dispatches at most one durable outbox row per deterministic drain", async () => {
    const delivered: string[] = [];
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      ownerId: "runtime",
      platform: "linux",
      clock: { now: () => 1_000 },
      outboxDelivery: {
        async deliver(item) {
          delivered.push(item.id);
          return { outcome: "sent" };
        },
      },
    });
    await runtime.start();
    runtime.ingestDingTalkMessage(message("one"));
    runtime.ingestDingTalkMessage(message("two"));
    expect((await runtime.drainOnce()).dispatched?.state).toBe("sent");
    expect(delivered).toHaveLength(1);
    expect((await runtime.drainOnce()).dispatched?.state).toBe("sent");
    expect(delivered).toHaveLength(2);
    await runtime.stop();
  });

  it("does not create Stream and reports needs_configuration when enabled credentials are missing", async () => {
    const createStream = vi.fn<() => RuntimeStream>();
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      platform: "linux",
      dingTalk: {
        enabled: true,
        credentials: { load: () => null },
        createStream,
      },
    });
    expect(await runtime.start()).toMatchObject({
      state: "degraded",
      ready: false,
      reason: "dingtalk_credentials_missing",
      dingtalk: { state: "needs_configuration" },
    });
    expect(createStream).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("keeps restored ledgers in review and does not dispatch or maintain them", async () => {
    const dataDirectory = temporaryDirectory();
    const ledger = openCollaborationLedger(join(dataDirectory, "collaboration"));
    const database = new DatabaseSync(ledger.filePath);
    markRestoredLedgerForReview(database, Buffer.from("backup"), 1_000);
    database.close();
    ledger.close();
    const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
    const maintain = vi.fn(async () => undefined);
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory,
      platform: "linux",
      outboxDelivery: { deliver },
      maintenance: { run: maintain },
    });
    expect(await runtime.start()).toMatchObject({
      state: "degraded",
      ready: false,
      reason: "restore_review_required",
    });
    expect(await runtime.drainOnce()).toEqual({ dispatched: null, maintained: false });
    expect(deliver).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("shares one awaited shutdown and bounds a hung Stream stop", async () => {
    let releaseStop: (() => void) | undefined;
    const streamStop = new Promise<void>((resolve) => (releaseStop = resolve));
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      platform: "linux",
      shutdownTimeoutMs: 30,
      dingTalk: {
        enabled: true,
        credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream: () => ({
          start: async () => "connected",
          stop: () => streamStop,
          state: () => "connected",
        }),
      },
    });
    await runtime.start();
    const first = runtime.stop();
    const second = runtime.stop();
    expect(runtime.health().state).toBe("draining");
    const [firstHealth, secondHealth] = await Promise.all([first, second]);
    expect(firstHealth).toMatchObject({ state: "stopped", status: "stopped", reason: "shutdown_timeout" });
    expect(secondHealth).toEqual(firstHealth);
    releaseStop!();
  });

  it("continues cleanup when Stream stop throws synchronously", async () => {
    const dataDirectory = temporaryDirectory();
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory,
      ownerId: "sync-stop-runtime",
      platform: "linux",
      dingTalk: {
        enabled: true,
        credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream: () => ({
          start: async () => "connected",
          stop: () => { throw new Error("adapter stop failed"); },
          state: () => "connected",
        }),
      },
    });
    await runtime.start();
    await expect(runtime.stop()).resolves.toMatchObject({ state: "stopped", instanceLease: "not_held" });
    const replacement = new CollaborationHeadlessRuntime({
      dataDirectory,
      ownerId: "replacement-runtime",
      platform: "linux",
    });
    await expect(replacement.start()).resolves.toMatchObject({ state: "running", ready: true });
    await replacement.stop();
  });

  it("kills verified unresolved containment and retains the lease when empty cannot be proven", async () => {
    for (const finalState of ["empty", "unknown"] as const) {
      const dataDirectory = temporaryDirectory();
      const terminated: string[] = [];
      let expectedBinding: ContainmentBinding | undefined;
      const containment: ContainmentPort = {
        async verifyProof(proof, binding) {
          expectedBinding = binding;
          return {
            verified: true,
            fingerprint: runtimeIdentityFingerprint(proof.identity),
            bindingHash: containmentBindingHash(binding),
          };
        },
        async inspect(identity) {
          return { state: "active", fingerprint: runtimeIdentityFingerprint(identity) };
        },
        async terminateAndWaitEmpty(identity) {
          terminated.push(identity.opaqueId);
          return finalState === "empty"
            ? { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) }
            : { state: "unknown", reason: "containment_not_empty" };
        },
      };
      const runtime = new CollaborationHeadlessRuntime({
        dataDirectory,
        ownerId: `shutdown-${finalState}`,
        platform: "linux",
        containment,
        clock: { now: () => 1_000 },
        instanceLeaseTtlMs: 1_000,
      });
      await runtime.start();
      const seeded = seedRunningRun(dataDirectory, `shutdown-${finalState}`);
      const stopped = await runtime.stop();
      expect(expectedBinding).toEqual(seeded.binding);
      expect(terminated).toEqual([seeded.proof.identity.opaqueId]);
      expect(stopped.reason).toBe(finalState === "empty" ? undefined : "shutdown_containment_unverified");
      const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
      const lease = database
        .prepare("SELECT expires_at FROM collaboration_instance_lease WHERE singleton = 1")
        .get() as { expires_at: number };
      expect(lease.expires_at).toBe(finalState === "empty" ? 1_000 : 2_000);
      expect(database.prepare("SELECT status, recovery_state FROM collaboration_runs WHERE id = 'RUN-SHUTDOWN'").get())
        .toEqual({ status: "needs_configuration", recovery_state: "unsafe_to_retry" });
      database.close();
    }
  });

  it("keeps execution fail-closed on macOS even when execution dependencies are presented incompletely", () => {
    expect(
      () =>
        new CollaborationHeadlessRuntime({
          dataDirectory: temporaryDirectory(),
          platform: "darwin",
          agent: { run: vi.fn(), interrupt: vi.fn() },
        }),
    ).toThrow("agent, containment, commandRunner, and execution must be configured together");
  });
});
