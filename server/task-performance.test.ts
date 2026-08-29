import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePerformanceBudgets, summarizePerformanceUsage, summarizeSessionReuse, TaskPerformanceLedger, TaskPerformanceTracker } from "./task-performance.ts";

describe("TaskPerformanceTracker", () => {
  it("records the full task timeline and honest usage provenance", () => {
    let now = 1_000;
    const tracker = new TaskPerformanceTracker({ now: () => now });
    tracker.begin({
      taskId: "task-1",
      threadId: "thread-1",
      provider: "cursorAgent",
      providerInstanceId: "cursor",
      model: "gpt-5.3-codex",
      sendAt: 1_000,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: "test-rate-card" },
    });
    tracker.queued("thread-1", 1_000);

    now = 1_025;
    tracker.dispatched("thread-1", "turn-1");
    now = 1_030;
    tracker.event({
      eventId: "e0",
      provider: "cursorAgent",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: new Date(now).toISOString(),
      type: "turn.started",
    });
    now = 1_125;
    tracker.event({
      eventId: "e1",
      provider: "cursorAgent",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: new Date(now).toISOString(),
      type: "session.started",
      sessionId: "session-1",
      model: "gpt-5.3-codex",
    });
    now = 1_150;
    tracker.event({
      eventId: "e2",
      provider: "cursorAgent",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: new Date(now).toISOString(),
      type: "item.started",
      itemType: "tool",
      itemId: "tool-1",
      title: "Read file",
    });
    now = 1_225;
    tracker.event({
      eventId: "e3",
      provider: "cursorAgent",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: new Date(now).toISOString(),
      type: "item.completed",
      itemType: "tool",
      itemId: "tool-1",
      ok: true,
    });
    now = 1_300;
    tracker.event({
      eventId: "e4",
      provider: "cursorAgent",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: new Date(now).toISOString(),
      type: "content.delta",
      streamKind: "assistant_text",
      delta: "done",
    });
    now = 1_400;
    const result = tracker.event({
      eventId: "e5",
      provider: "cursorAgent",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: new Date(now).toISOString(),
      type: "turn.completed",
      ok: true,
      usage: { input: 100, output: 20 },
      cost: 0.003,
    });

    expect(result).toMatchObject({
      taskId: "task-1",
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "cursorAgent",
      providerInstanceId: "cursor",
      model: "gpt-5.3-codex",
      durationsMs: {
        sendToDispatch: 25,
        queueDelay: 25,
        providerStartup: 100,
        firstVisibleOutput: 275,
        completion: 400,
      },
      usage: {
        input: 100,
        output: 20,
        source: "provider",
      },
      cost: {
        reportedUsd: 0.003,
        estimatedUsd: 0.00014,
        source: "provider",
        pricingSource: "test-rate-card",
      },
    });
    expect(result?.tools).toEqual([{ itemId: "tool-1", name: "Read file", durationMs: 75, ok: true }]);
  });

  it("leaves unavailable metrics null instead of inventing provider behavior", () => {
    const tracker = new TaskPerformanceTracker({ now: () => 1_000 });
    tracker.begin({
      taskId: "task-2",
      threadId: "thread-2",
      provider: "unknown",
      providerInstanceId: "unknown",
      model: "unknown-model",
    });
    const result = tracker.event({
      eventId: "e6",
      provider: "unknown",
      threadId: "thread-2",
      turnId: "turn-2",
      createdAt: new Date(1_000).toISOString(),
      type: "turn.completed",
      ok: false,
    });
    expect(result?.durationsMs).toEqual({
      sendToDispatch: null,
      queueDelay: 0,
      providerStartup: null,
      firstVisibleOutput: null,
      completion: 0,
    });
    expect(result?.usage).toEqual({ input: null, output: null, estimatedTokens: 2_000, source: "estimated" });
    expect(result?.cost).toEqual({ reportedUsd: null, estimatedUsd: null, source: "unavailable" });
  });

  it("records a visibly approximate token estimate when the provider omits usage", () => {
    const tracker = new TaskPerformanceTracker({ now: () => 1_000 });
    tracker.begin({
      taskId: "task-estimate",
      threadId: "thread-estimate",
      provider: "cursorAgent",
      providerInstanceId: "cursor",
      model: "grok",
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: "test-rate-card" },
    });
    tracker.dispatched("thread-estimate", "turn-estimate", 1_010);
    tracker.event({
      eventId: "estimate-text",
      provider: "cursorAgent",
      threadId: "thread-estimate",
      turnId: "turn-estimate",
      createdAt: new Date(1_100).toISOString(),
      type: "content.delta",
      streamKind: "assistant_text",
      delta: "A useful answer without provider telemetry.",
    });
    const result = tracker.event({
      eventId: "estimate-done",
      provider: "cursorAgent",
      threadId: "thread-estimate",
      turnId: "turn-estimate",
      createdAt: new Date(1_200).toISOString(),
      type: "turn.completed",
      ok: true,
    });

    expect(result?.usage).toEqual({ input: null, output: null, estimatedTokens: 2_011, source: "estimated" });
    expect(result?.cost.source).toBe("estimate");
    expect(result?.cost.estimatedUsd).toBeCloseTo(0.00251375, 8);
  });

  it("does not call a reused provider session startup", () => {
    const tracker = new TaskPerformanceTracker({ now: () => 1_000 });
    tracker.begin({
      taskId: "task-warm",
      threadId: "thread-warm",
      provider: "cursorAgent",
      providerInstanceId: "cursor",
      model: "auto",
      sendAt: 1_000,
    });
    tracker.dispatched("thread-warm", "turn-warm", 1_010);
    const result = tracker.event({
      eventId: "warm-start",
      provider: "cursorAgent",
      threadId: "thread-warm",
      turnId: "turn-warm",
      createdAt: new Date(1_011).toISOString(),
      type: "session.started",
      sessionId: "session-1",
      model: "auto",
      reused: true,
    });

    expect(result?.durationsMs.providerStartup).toBeNull();
    expect(result?.timestampsMs.providerStartup).toBeNull();
    expect(result?.sessionMode).toBe("warm");
  });

  it("persists content-free performance receipts across restarts", () => {
    const file = join(mkdtempSync(join(tmpdir(), "centipede-performance-")), "receipts.json");
    const tracker = new TaskPerformanceTracker({ now: () => 2_000 });
    tracker.begin({
      taskId: "task-durable",
      threadId: "thread-durable",
      provider: "cursorAgent",
      providerInstanceId: "cursor",
      model: "grok",
    });
    tracker.dispatched("thread-durable", null, 2_010);
    const receipt = tracker.failedDispatch("thread-durable", 2_020);
    expect(receipt).not.toBeNull();
    const ledger = new TaskPerformanceLedger({ file });
    ledger.record(receipt!);
    expect(new TaskPerformanceLedger({ file }).list()).toMatchObject([
      { taskId: "task-durable", durationsMs: { sendToDispatch: 10, completion: 20 }, completed: true },
    ]);
  });

  it("reports aspirational latency and token-coverage budget breaches", () => {
    const receipt = {
      taskId: "slow", threadId: "thread", turnId: "turn", provider: "cursorAgent", providerInstanceId: "cursor", model: "grok",
      timestampsMs: { send: 0, dispatch: 2_000, providerStartup: 6_000, firstVisibleOutput: 15_000, completion: 45_000 },
      durationsMs: { sendToDispatch: 2_000, queueDelay: 1_200, providerStartup: 4_000, firstVisibleOutput: 13_000, completion: 45_000 },
      tools: [], usage: { input: null, output: null, estimatedTokens: null, source: "unavailable" as const },
      cost: { reportedUsd: null, estimatedUsd: null, source: "unavailable" as const }, completed: true,
    };
    const report = evaluatePerformanceBudgets([receipt]);
    expect(report.passing).toBe(false);
    expect(report.metrics.medianProviderStartupMs?.status).toBe("breach");
    expect(report.metrics.minimumTokenCoverage?.status).toBe("breach");
  });

  it("separates provider counts, estimates, and unavailable receipts", () => {
    const base = {
      taskId: "t",
      threadId: "thread",
      turnId: "turn",
      provider: "cursorAgent",
      providerInstanceId: "cursor",
      model: "grok",
      timestampsMs: { send: 0, dispatch: 0, providerStartup: null, firstVisibleOutput: null, completion: 1 },
      durationsMs: { sendToDispatch: 0, queueDelay: 0, providerStartup: null, firstVisibleOutput: null, completion: 1 },
      tools: [],
      cost: { reportedUsd: null, estimatedUsd: null, source: "unavailable" as const },
      completed: true,
    };
    const summary = summarizePerformanceUsage([
      { ...base, usage: { input: 10, output: 3, estimatedTokens: null, source: "provider" as const } },
      { ...base, taskId: "estimated", usage: { input: null, output: null, estimatedTokens: 2_250, source: "estimated" as const } },
      { ...base, taskId: "unavailable", usage: { input: null, output: null, estimatedTokens: null, source: "unavailable" as const } },
    ]);
    expect(summary).toEqual({
      providerReportedTurns: 1,
      estimatedTurns: 1,
      unavailableTurns: 1,
      providerReportedCoverage: 1 / 3,
      estimatedTokens: 2_250,
    });
  });

  it("reports warm reuse and cold-versus-warm response latency", () => {
    const base = {
      taskId: "t", threadId: "thread", turnId: "turn", provider: "cursorAgent", providerInstanceId: "cursor", model: "grok",
      timestampsMs: { send: 0, dispatch: 0, providerStartup: null, firstVisibleOutput: 1, completion: 2 },
      durationsMs: { sendToDispatch: 0, queueDelay: 0, providerStartup: null, firstVisibleOutput: 1, completion: 2 },
      tools: [], usage: { input: 1, output: 1, estimatedTokens: null, source: "provider" as const },
      cost: { reportedUsd: null, estimatedUsd: null, source: "unavailable" as const }, completed: true,
    };
    expect(summarizeSessionReuse([
      { ...base, taskId: "cold", sessionMode: "cold", durationsMs: { ...base.durationsMs, firstVisibleOutput: 8_000 } },
      { ...base, taskId: "warm", sessionMode: "warm", durationsMs: { ...base.durationsMs, firstVisibleOutput: 2_000 } },
      { ...base, taskId: "legacy" },
    ])).toEqual({
      coldTurns: 1,
      warmTurns: 1,
      unknownTurns: 1,
      reuseRate: 0.5,
      medianColdFirstVisibleMs: 8_000,
      medianWarmFirstVisibleMs: 2_000,
    });
  });
});
