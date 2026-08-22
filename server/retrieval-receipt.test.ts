import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { OpenMausRetrievalReceipt } from "./retrieval.ts";
import {
  finalizeRetrievalReceipt,
  recordRetrievalReceipt,
  retrievalReceiptPath,
  type FinalizedOpenMausRetrievalReceipt,
} from "./retrieval-receipt.ts";

const baseReceipt = (botId: string, threadId: string, taskId: string): OpenMausRetrievalReceipt => ({
  schema: "openmaus.retrieval-receipt.v1",
  automatic_retrieval_active: true,
  windows_served: false,
  generation_identity: null,
  fallback_path: "fts5-current-source",
  skip_reason: null,
  accepted_hits: 1,
  native_session_proof: { botId, threadId, taskId },
  native_dispatch_proof: null,
});

const receipt = (botId: string, threadId: string, taskId: string): FinalizedOpenMausRetrievalReceipt =>
  finalizeRetrievalReceipt(baseReceipt(botId, threadId, taskId), {
    status: "accepted",
    instanceId: "qwen-local",
    driverKind: "qwenAgent",
    model: "qwen3.5-27b",
    turnId: `turn-${threadId}`,
    context: "fenced evidence é",
  });

describe("retrieval receipt persistence", () => {
  it("atomically records metadata-only direct and group receipts under hash-safe identities", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmaus-retrieval-receipts-"));
    const direct = receipt("bot-ada", "thread-ada", "task-ada");
    const group = receipt("bot-ada", "group-thread", "group-thread");
    const directPath = recordRetrievalReceipt(dataDir, direct, new Date("2026-08-22T07:00:00Z"));
    const groupPath = recordRetrievalReceipt(dataDir, group, new Date("2026-08-22T07:01:00Z"));

    expect(directPath).not.toBe(groupPath);
    expect(basename(directPath!)).toMatch(/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/);
    expect(basename(groupPath!)).toMatch(/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/);
    expect(retrievalReceiptPath(dataDir, direct, "dispatch-a"))
      .not.toBe(retrievalReceiptPath(dataDir, direct, "dispatch-b"));
    const readback = JSON.parse(readFileSync(directPath!, "utf8"));
    expect(readback).toMatchObject({
      schema: "openmaus.retrieval-receipt-record.v1",
      recorded_at: "2026-08-22T07:00:00.000Z",
      receipt: direct,
    });
    expect(readback.receipt.native_dispatch_proof).toMatchObject({
      status: "accepted",
      botId: "bot-ada",
      threadId: "thread-ada",
      taskId: "task-ada",
      instanceId: "qwen-local",
      driverKind: "qwenAgent",
      model: "qwen3.5-27b",
      turnId: "turn-thread-ada",
      contextBytes: Buffer.byteLength("fenced evidence é", "utf8"),
      contextSha256: "sha256:6a189bbb3e37531431132737b8e010ba244262bd61fa3a81ed7fa02f60c96b51",
      failureStage: null,
    });
    const serialized = JSON.stringify(readback);
    expect(serialized).not.toContain("fenced evidence é");
    expect(serialized).not.toMatch(/"(?:query|snippet|excerpt)"\s*:/i);
    // NTFS permissions are represented by ACLs; Node reports synthetic 0666
    // mode bits there even after chmod. Keep the exact owner-only regression
    // on platforms whose filesystems expose POSIX modes.
    if (process.platform !== "win32") {
      expect(statSync(directPath!).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "retrieval-receipts")).mode & 0o777).toBe(0o700);
    }
  });

  it("preserves every dispatch receipt for the same bot and thread", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmaus-retrieval-receipts-"));
    const sameSession = receipt("bot-ada", "thread-ada", "task-ada");
    const first = recordRetrievalReceipt(dataDir, sameSession, new Date("2026-08-22T07:00:00Z"));
    const second = recordRetrievalReceipt(dataDir, sameSession, new Date("2026-08-22T07:00:00Z"));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(existsSync(first!)).toBe(true);
    expect(existsSync(second!)).toBe(true);
  });

  it("fails open when the receipt directory cannot be created", () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "openmaus-retrieval-receipts-")), "not-a-directory");
    writeFileSync(dataDir, "occupied");
    expect(recordRetrievalReceipt(dataDir, receipt("bot", "thread", "task"))).toBeNull();
  });

  it("records an explicit metadata-only adapter failure with the same session binding", () => {
    const failed = finalizeRetrievalReceipt(baseReceipt("bot-codex", "thread-codex", "task-codex"), {
      status: "failed",
      failureStage: "adapter-rejected",
      instanceId: "codex",
      driverKind: "codexAgent",
      model: "gpt-5.3-codex",
      context: "retrieval context never accepted",
    });

    expect(failed.native_dispatch_proof).toMatchObject({
      status: "failed",
      botId: "bot-codex",
      threadId: "thread-codex",
      taskId: "task-codex",
      instanceId: "codex",
      driverKind: "codexAgent",
      model: "gpt-5.3-codex",
      turnId: null,
      contextBytes: 32,
      failureStage: "adapter-rejected",
    });
    expect(failed.native_dispatch_proof.contextSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(failed)).not.toContain("retrieval context never accepted");
  });
});
