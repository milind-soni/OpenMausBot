import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CaptureLedger } from "./capture-ledger.ts";

const dirs: string[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-capture-"));
  dirs.push(dir);
  let now = new Date("2026-08-26T13:00:00.000Z").getTime();
  const file = join(dir, "capture.db");
  const ledger = new CaptureLedger({ file, now: () => now });
  return { ledger, file, setNow: (value: number) => { now = value; } };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CaptureLedger", () => {
  it("reads the authoritative receipt after a provider finishes a run", () => {
    const h = harness();
    const scheduledFor = new Date("2026-08-26T13:00:00.000Z").getTime();
    const started = h.ledger.begin({
      botId: "capture",
      threadId: "capture-thread",
      kind: "fast",
      scheduledFor,
      sources: [{ id: "gmail", required: true }],
    });
    h.ledger.recordSource("capture", started.runId, "gmail", {
      status: "empty",
      cursor: { historyId: "42" },
      itemCount: 0,
    });
    h.ledger.finish("capture", started.runId);

    expect(h.ledger.receiptForRun("capture", started.runId)).toMatchObject({
      report: {
        runId: started.runId,
        status: "completed",
        sourceHealth: [{ sourceId: "gmail", status: "empty" }],
      },
      outbox: null,
    });
    h.ledger.close();
  });

  it("allows only one active capture lifecycle per bot", () => {
    const h = harness();
    const first = h.ledger.begin({
      botId: "capture",
      threadId: "thread-1",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    expect(() => h.ledger.begin({
      botId: "capture",
      threadId: "thread-2",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    })).toThrow("Capture already has an active run");
    h.ledger.recordSource("capture", first.runId, "gmail", {
      status: "empty",
      cursor: { historyId: "42" },
      itemCount: 0,
    });
    h.ledger.finish("capture", first.runId);
    expect(() => h.ledger.begin({
      botId: "capture",
      threadId: "thread-2",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    })).not.toThrow();
    h.ledger.close();
  });

  it("immediately recovers every running lifecycle after an app restart", () => {
    const h = harness();
    h.ledger.begin({
      botId: "capture",
      threadId: "thread-restart",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    const recovered = h.ledger.recoverRunningRunsAfterRestart();
    expect(recovered).toHaveLength(1);
    expect(h.ledger.sourceHealth()).toContainEqual(expect.objectContaining({
      sourceId: "gmail",
      status: "failed",
      lastError: "OpenMausBot restarted before Capture finished",
    }));
    h.ledger.close();
  });

  it("recovers abandoned runs without advancing a previously committed cursor", () => {
    const h = harness();
    const seeded = h.ledger.begin({
      botId: "capture",
      threadId: "thread-seed",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    h.ledger.recordSource("capture", seeded.runId, "gmail", {
      status: "ok",
      cursor: { historyId: "42" },
      itemCount: 1,
    });
    h.ledger.finish("capture", seeded.runId);

    const abandoned = h.ledger.begin({
      botId: "capture",
      threadId: "thread-abandoned",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    h.setNow(new Date("2026-08-26T14:01:00.000Z").getTime());
    const recovered = h.ledger.recoverStaleRuns(60 * 60_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.report).toMatchObject({ runId: abandoned.runId, status: "degraded" });
    expect(recovered[0]?.outbox).not.toBeNull();

    const next = h.ledger.begin({
      botId: "capture",
      threadId: "thread-next",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    expect(next.cursors[0]?.cursor).toEqual({ historyId: "42" });
    expect(h.ledger.sourceHealth()).toContainEqual(expect.objectContaining({
      sourceId: "gmail",
      status: "failed",
      lastError: "Capture run exceeded its recovery timeout",
    }));
    h.ledger.close();
  });

  it("marks a run degraded when the worker disappears after recording every source", () => {
    const h = harness();
    const abandoned = h.ledger.begin({
      botId: "capture",
      threadId: "thread-partial",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [
        { id: "gmail", required: true },
        { id: "calendar", required: false },
      ],
    });
    h.ledger.recordSource("capture", abandoned.runId, "gmail", {
      status: "empty",
      cursor: { historyId: "42" },
      itemCount: 0,
    });
    h.ledger.recordSource("capture", abandoned.runId, "calendar", {
      status: "empty",
      cursor: { syncToken: "abc" },
      itemCount: 0,
    });
    h.setNow(new Date("2026-08-26T14:01:00.000Z").getTime());

    const recovered = h.ledger.recoverStaleRuns(60 * 60_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.report.status).toBe("degraded");
    expect(recovered[0]?.outbox).not.toBeNull();
    expect(h.ledger.runSummary(0)).toContainEqual(expect.objectContaining({ status: "degraded", count: 1 }));
    h.ledger.close();
  });

  it("advances successful cursors and preserves them across restarts", () => {
    const h = harness();
    const started = h.ledger.begin({
      botId: "capture",
      threadId: "thread-1",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    h.ledger.recordSource("capture", started.runId, "gmail", {
      status: "ok",
      cursor: { historyId: "42" },
      itemCount: 1,
    });
    h.ledger.finish("capture", started.runId);
    h.ledger.close();

    const reloaded = new CaptureLedger({ file: h.file });
    const next = reloaded.begin({
      botId: "capture",
      threadId: "thread-2",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    expect(next.cursors).toEqual([{ sourceId: "gmail", cursor: { historyId: "42" }, lastSuccessAt: expect.any(Number) }]);
    reloaded.close();
  });

  it("does not advance a cursor when a source fails", () => {
    const h = harness();
    const first = h.ledger.begin({
      botId: "capture",
      threadId: "thread-1",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "messages", required: true }],
    });
    h.ledger.recordSource("capture", first.runId, "messages", { status: "ok", cursor: { at: 10 }, itemCount: 0 });
    h.ledger.finish("capture", first.runId);
    h.setNow(Date.now() + 60_000);
    const failed = h.ledger.begin({
      botId: "capture",
      threadId: "thread-2",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "messages", required: true }],
    });
    h.ledger.recordSource("capture", failed.runId, "messages", { status: "failed", error: "browser session expired" });
    expect(h.ledger.finish("capture", failed.runId).report.status).toBe("degraded");
    const next = h.ledger.begin({
      botId: "capture",
      threadId: "thread-3",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "messages", required: true }],
    });
    expect(next.cursors[0]?.cursor).toEqual({ at: 10 });
    h.ledger.close();
  });

  it("fails closed when a required source never records a result", () => {
    const h = harness();
    const started = h.ledger.begin({
      botId: "capture",
      threadId: "thread-1",
      kind: "hourly",
      scheduledFor: Date.now(),
      sources: [
        { id: "calendar", required: true },
        { id: "youtube", required: false },
      ],
    });
    h.ledger.recordSource("capture", started.runId, "youtube", { status: "empty", cursor: { at: 20 }, itemCount: 0 });
    const receipt = h.ledger.finish("capture", started.runId);
    expect(receipt.report.status).toBe("degraded");
    expect(receipt.report.sourceHealth).toContainEqual(expect.objectContaining({
      sourceId: "calendar",
      required: true,
      status: "failed",
    }));
    expect(receipt.outbox).not.toBeNull();
    h.ledger.close();
  });

  it("keeps actionable reports in a durable outbox until acknowledged", () => {
    const h = harness();
    const started = h.ledger.begin({
      botId: "capture",
      threadId: "thread-1",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    h.ledger.recordSource("capture", started.runId, "gmail", {
      status: "ok",
      cursor: { historyId: "43" },
      itemCount: 1,
      actions: [{
        class: "Calendar/RSVP",
        source: "gmail",
        summary: "An invitation needs a response",
        ask: "Choose whether to attend",
        proposedMove: "Draft a response",
      }],
    });
    const receipt = h.ledger.finish("capture", started.runId);
    expect(receipt.report.status).toBe("completed");
    expect(receipt.outbox?.report.actionItems).toHaveLength(1);
    expect(h.ledger.pendingOutbox("capture")).toHaveLength(1);
    if (!receipt.outbox) throw new Error("Expected an actionable outbox report");
    expect(h.ledger.acknowledgeOutbox("capture", receipt.outbox.id)).toBe(true);
    expect(h.ledger.pendingOutbox("capture")).toHaveLength(0);
    h.ledger.close();
  });

  it("exposes redacted operational health without source cursors", () => {
    const h = harness();
    const started = h.ledger.begin({
      botId: "capture",
      threadId: "thread-health",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [{ id: "gmail", required: true }],
    });
    h.ledger.recordSource("capture", started.runId, "gmail", {
      status: "ok",
      cursor: { secretProviderCursor: "must-not-leak" },
      itemCount: 0,
    });
    h.ledger.finish("capture", started.runId);
    const health = h.ledger.sourceHealth("capture");
    expect(health).toEqual([expect.objectContaining({ sourceId: "gmail", status: "ok" })]);
    expect(health[0]?.freshness).toBe("fresh");
    expect(JSON.stringify(health)).not.toContain("must-not-leak");
    expect(h.ledger.runSummary(0)).toEqual([{ status: "completed", count: 1, latestAt: expect.any(Number) }]);
    h.ledger.close();
  });

  it("reports one redacted status snapshot without starting a run", () => {
    const h = harness();
    expect(h.ledger.status("capture")).toEqual({
      botId: "capture",
      state: "never-run",
      latestRun: null,
      lastSuccessfulRunAt: null,
      pendingOutboxCount: 0,
      sourceHealth: [],
    });

    const started = h.ledger.begin({
      botId: "capture",
      threadId: "thread-status",
      kind: "fast",
      scheduledFor: 123,
      sources: [{ id: "gmail", required: true }],
    });
    expect(h.ledger.status("capture")).toMatchObject({
      state: "running",
      latestRun: { id: started.runId, kind: "fast", scheduledFor: 123, status: "running" },
    });
    h.ledger.recordSource("capture", started.runId, "gmail", {
      status: "ok",
      cursor: { secretProviderCursor: "must-not-leak" },
      itemCount: 0,
    });
    h.ledger.finish("capture", started.runId);

    const status = h.ledger.status("capture");
    expect(status).toMatchObject({
      botId: "capture",
      state: "healthy",
      lastSuccessfulRunAt: expect.any(Number),
      pendingOutboxCount: 0,
      latestRun: { id: started.runId, status: "completed", finishedAt: expect.any(Number) },
      sourceHealth: [{ sourceId: "gmail", status: "ok", freshness: "fresh" }],
    });
    expect(JSON.stringify(status)).not.toContain("must-not-leak");
    expect(h.ledger.runSummary(0)).toEqual([{ status: "completed", count: 1, latestAt: expect.any(Number) }]);
    h.ledger.close();
  });

  it("distinguishes stale and never-successful sources for the dashboard", () => {
    const h = harness();
    const started = h.ledger.begin({
      botId: "capture",
      threadId: "thread-health-stale",
      kind: "hourly",
      scheduledFor: 1,
      sources: [
        { id: "old-source", required: false },
        { id: "never-source", required: false },
      ],
    });
    h.ledger.recordSource("capture", started.runId, "old-source", {
      status: "ok", cursor: { at: 1 }, itemCount: 0,
    });
    h.ledger.recordSource("capture", started.runId, "never-source", {
      status: "needs-auth", error: "sign in required",
    });
    h.ledger.finish("capture", started.runId);
    h.setNow(new Date("2026-08-26T16:00:00.000Z").getTime());
    expect(h.ledger.sourceHealth("capture", { staleAfterMs: 60 * 60_000 })).toEqual([
      expect.objectContaining({ sourceId: "never-source", freshness: "unknown", status: "needs-auth" }),
      expect.objectContaining({ sourceId: "old-source", freshness: "stale", status: "ok" }),
    ]);
    h.ledger.close();
  });

  it("uses source cadence instead of marking daily sources stale after two hours", () => {
    const h = harness();
    const started = h.ledger.begin({
      botId: "capture",
      threadId: "thread-health-cadence",
      kind: "hourly",
      scheduledFor: 1,
      sources: [
        { id: "github", required: false },
        { id: "gmail-account-1", required: false },
      ],
    });
    h.ledger.recordSource("capture", started.runId, "github", {
      status: "empty", cursor: { at: 1 }, itemCount: 0,
    });
    h.ledger.recordSource("capture", started.runId, "gmail-account-1", {
      status: "empty", cursor: { at: 1 }, itemCount: 0,
    });
    h.ledger.finish("capture", started.runId);
    h.setNow(new Date("2026-08-26T15:01:00.000Z").getTime());

    expect(h.ledger.sourceHealth("capture")).toEqual([
      expect.objectContaining({ sourceId: "github", freshness: "fresh", status: "empty" }),
      expect.objectContaining({ sourceId: "gmail-account-1", freshness: "stale", status: "empty" }),
    ]);
    h.ledger.close();
  });

  it("returns opaque markers and rate-limits unchanged unavailable sources", () => {
    const h = harness();
    const started = h.ledger.begin({
      botId: "capture",
      threadId: "thread-markers",
      kind: "fast",
      scheduledFor: Date.now(),
      sources: [
        { id: "gmail", required: true },
        { id: "failed", required: true },
      ],
    });
    h.ledger.recordSource("capture", started.runId, "gmail", {
      status: "empty", cursor: { historyId: "42" }, itemCount: 0,
    });
    h.ledger.recordSource("capture", started.runId, "failed", {
      status: "failed", error: "transport unavailable",
    });
    h.ledger.finish("capture", started.runId);

    const markers = h.ledger.sourceChangeMarkers("capture", ["gmail", "failed", "missing"]);
    expect(markers).toEqual([
      expect.objectContaining({ sourceId: "gmail", status: "empty", freshness: "fresh", ready: true }),
      expect.objectContaining({ sourceId: "failed", status: "failed", ready: true, marker: expect.any(String) }),
      expect.objectContaining({ sourceId: "missing", status: "unknown", freshness: "unknown", ready: true, marker: expect.any(String) }),
    ]);
    expect(markers[0]?.marker).toMatch(/^[a-f0-9]{64}$/);
    expect(markers[1]?.marker).toMatch(/^[a-f0-9]{64}$/);
    expect(markers[2]?.marker).toMatch(/^[a-f0-9]{64}$/);
    expect(h.ledger.sourceChangeMarkers("capture", ["gmail", "failed", "missing"])).toEqual(markers);
    h.setNow(new Date("2026-08-26T13:31:00.000Z").getTime());
    const nextBucket = h.ledger.sourceChangeMarkers("capture", ["gmail", "failed", "missing"]);
    expect(nextBucket[1]?.marker).not.toBe(markers[1]?.marker);
    expect(nextBucket[2]?.marker).not.toBe(markers[2]?.marker);
    expect(JSON.stringify(markers)).not.toContain("42");
    expect(JSON.stringify(markers)).not.toContain("transport unavailable");
    h.ledger.close();
  });
});
