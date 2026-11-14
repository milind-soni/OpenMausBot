import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { TraceTokens } from "../../shared/usage-trace.ts";
import { appendUsage, type UsageRow } from "../usage-ledger.ts";
import { createTraceRecorder, type LiveTurnView } from "./recorder.ts";
import { createTraceService } from "./service.ts";
import { flushSpans, type StepSpan } from "./spans.ts";

const AT = Date.UTC(2026, 9, 22, 9);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await flushSpans(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

const baseTokens = { input: 100, cachedInput: 50, output: 40 };
type Breakdown = Pick<TraceTokens, "cacheWrite" | "reasoning">;
const cases: Array<{ name: string; values: Breakdown[]; expected: Breakdown }> = [
  { name: "adds both reported breakdowns", values: [{ cacheWrite: 10, reasoning: 4 }, { cacheWrite: 20, reasoning: 6 }], expected: { cacheWrite: 30, reasoning: 10 } },
  { name: "keeps fields first reported later", values: [{}, { cacheWrite: 20, reasoning: 6 }], expected: { cacheWrite: 20, reasoning: 6 } },
  { name: "keeps earlier fields when a later record omits them", values: [{ cacheWrite: 10, reasoning: 4 }, {}], expected: { cacheWrite: 10, reasoning: 4 } },
  { name: "does not turn unknown breakdowns into zero", values: [{}, {}], expected: {} },
  { name: "retains explicitly reported zero", values: [{ cacheWrite: 0, reasoning: 0 }, {}], expected: { cacheWrite: 0, reasoning: 0 } },
  { name: "ignores nonfinite optional values", values: [{ cacheWrite: 10, reasoning: 4 }, { cacheWrite: Number.NaN, reasoning: Number.POSITIVE_INFINITY }], expected: { cacheWrite: 10, reasoning: 4 } },
];

function fixture(liveTurns: () => LiveTurnView[] = () => []) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-trace-breakdowns-"));
  dirs.push(dataDir);
  const service = createTraceService({
    dataDir, recorder: { liveTurns }, now: () => AT + 10_000,
    liveBot: () => ({ botId: "bot", botName: "Bot", model: "fixture", driverKind: "claude" }),
    messages: () => [],
  });
  return { dataDir, service };
}

function row(index: number, extra: Partial<UsageRow> = {}): UsageRow {
  return {
    at: new Date(AT + (index + 1) * 1_000).toISOString(), threadId: "chat", turnId: "turn",
    botId: "bot", botName: "Bot", instanceId: "fixture", driverKind: "claude", model: "fixture",
    ...baseTokens, costUsd: 0.25, trigger: { kind: "owner" }, usageStatus: "complete",
    startedAt: new Date(AT).toISOString(), endedAt: new Date(AT + (index + 1) * 1_000).toISOString(), ...extra,
  };
}

describe.each(["booked", "live"] as const)("%s trace token breakdowns", (source) => {
  it.each(cases)("$name", async ({ values, expected }) => {
    const spans: StepSpan[] = values.map((value, index) => ({
      kind: "step", id: `step-${index}`, threadId: "chat", turnId: "turn",
      startedAt: AT + index * 1_000, endedAt: AT + (index + 1) * 1_000,
      tokens: Object.freeze({ ...baseTokens, ...value }),
    }));
    const live: LiveTurnView = { threadId: "chat", turnId: "turn", provider: "claude", startedAt: AT, spans };
    const { dataDir, service } = fixture(() => source === "live" ? [live] : []);
    if (source === "booked") {
      for (const [index, value] of values.entries()) expect(await appendUsage(dataDir, row(index, value))).toBe(true);
    }
    const detail = await service.detail("chat~turn", AT, () => true);
    expect(detail!.turns[0]!.tokens).toEqual({ input: 200, cachedInput: 100, output: 80, ...expected });
    expect(detail!.root).toMatchObject({ input: 200, cachedInput: 100, output: 80, tokens: 280 });
    expect(detail!.turns).toHaveLength(1);
    if (source === "booked") expect(detail!.turns[0]!.costUsd).toBe(0.5);
    else expect(spans.map((span) => span.tokens)).toEqual(values.map((value) => ({ ...baseTokens, ...value })));
  });
});

it.each(["claude", "codex"])("keeps %s runtime breakdowns visible before and after booking", async (provider) => {
  let recorder!: ReturnType<typeof createTraceRecorder>;
  const { dataDir, service } = fixture(() => recorder.liveTurns());
  recorder = createTraceRecorder({ dataDir, now: () => AT + 10_000 });
  const observe = (ms: number, body: object) => recorder.observe({
    eventId: `event-${ms}`, provider, threadId: "chat", turnId: "turn", createdAt: new Date(AT + ms).toISOString(), ...body,
  } as RuntimeEvent);
  observe(0, { type: "turn.started" });
  if (provider === "claude") {
    observe(100, { type: "thread.token-usage.updated", itemId: "first", input: 100, cachedInput: 50, output: 40, contextTokens: 130, reasoning: 3 });
    observe(200, { type: "thread.token-usage.updated", itemId: "second", input: 200, cachedInput: 70, output: 60, contextTokens: 250, reasoning: 7 });
  } else {
    observe(100, { type: "thread.token-usage.updated", input: 0, cachedInput: 0, output: 0, reasoning: 0 });
    observe(200, { type: "thread.token-usage.updated", input: 300, cachedInput: 120, output: 100, reasoning: 10 });
  }
  const expected = { input: 300, cachedInput: 120, output: 100, reasoning: 10, ...(provider === "claude" ? { cacheWrite: 80 } : {}) };
  const before = await service.detail("chat~turn", AT, () => true);
  expect(before!.turns[0]!.tokens).toEqual(expected);
  expect(before!.turns[0]!.running).toBe(true);
  observe(1_000, { type: "turn.completed", ok: true, usage: { input: 300, cachedInput: 120, output: 100 } });
  const fields = recorder.settle("chat");
  expect(await appendUsage(dataDir, row(0, { ...expected, ...fields }))).toBe(true);
  await flushSpans(dataDir);
  const after = await service.detail("chat~turn", AT, () => true);
  expect(after!.turns[0]!.tokens).toEqual(expected);
  expect(after!.turns[0]!.running).toBeUndefined();
  expect(after!.root).toMatchObject({ input: 300, cachedInput: 120, output: 100, tokens: 400 });
});
