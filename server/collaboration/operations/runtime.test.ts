import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

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
