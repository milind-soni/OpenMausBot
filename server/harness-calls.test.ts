// Harness-initiated model calls (Phase 1 part 2, from the Overlay review):
// every one carries an idempotent fingerprint, is skipped when the budget
// is gone, and is booked with its actual cost — so a retry never pays twice
// and background work never fails a turn.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { harnessCallFingerprint, runHarnessCall } from "./harness-calls.ts";
import { flushUsageLedger } from "./usage-ledger.ts";

const dirs: string[] = [];
const dataDir = () => { const d = mkdtempSync(join(tmpdir(), "omb-hc-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const base = { kind: "compaction-summary", botId: "b1", botName: "Bot", threadId: "t1", turnKey: "m9", instanceId: "claude", driverKind: "claudeAgent", model: "claude-haiku-4-5" };

async function ledger(dir: string) {
  await flushUsageLedger(dir);
  const file = join(dir, "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
  try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

describe("runHarnessCall", () => {
  it("fingerprints on kind, thread, turn key and prompt", () => {
    const a = harnessCallFingerprint("compaction-summary", "t1", "m9", "summarise this");
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(harnessCallFingerprint("compaction-summary", "t1", "m9", "summarise this")).toBe(a);
    expect(harnessCallFingerprint("compaction-summary", "t1", "m10", "summarise this")).not.toBe(a);
    expect(harnessCallFingerprint("compaction-summary", "t1", "m9", "summarise that")).not.toBe(a);
  });

  it("calls once, books one priced row, and answers a retry from the cache without a second call or row", async () => {
    const dir = dataDir();
    let calls = 0;
    const call = async () => { calls += 1; return { text: "the summary", input: 1_200, output: 90, costUsd: 0.0031 }; };
    const first = await runHarnessCall(dir, { ...base, prompt: "summarise this", call }, { budgetExhausted: () => false });
    expect(first).toEqual({ text: "the summary", cached: false });
    const second = await runHarnessCall(dir, { ...base, prompt: "summarise this", call }, { budgetExhausted: () => false });
    expect(second).toEqual({ text: "the summary", cached: true });
    expect(calls).toBe(1);
    const rows = await ledger(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ botId: "b1", threadId: "t1", input: 1_200, output: 90, costUsd: 0.0031, trigger: { kind: "harness", call: "compaction-summary" } });
    expect(rows[0].fingerprint).toBe(harnessCallFingerprint("compaction-summary", "t1", "m9", "summarise this"));
  });

  it("skips quietly when the budget is exhausted, and books nothing", async () => {
    const dir = dataDir();
    let calls = 0;
    const result = await runHarnessCall(dir, { ...base, prompt: "p", call: async () => { calls += 1; return { text: "x" }; } }, { budgetExhausted: () => true });
    expect(result).toEqual({ skipped: "budget" });
    expect(calls).toBe(0);
    expect(await ledger(dir)).toEqual([]);
  });

  it("books an unpriced row when the engine reports no usage, and surfaces a failure as null", async () => {
    const dir = dataDir();
    const ok = await runHarnessCall(dir, { ...base, prompt: "p", call: async () => "plain text" }, { budgetExhausted: () => false });
    expect(ok).toEqual({ text: "plain text", cached: false });
    const rows = await ledger(dir);
    expect(rows[0]).toMatchObject({ input: 0, output: 0, costUsd: null });
    const failed = await runHarnessCall(dir, { ...base, prompt: "q", call: async () => { throw new Error("boom"); } }, { budgetExhausted: () => false });
    expect(failed).toBeNull();
    expect(await ledger(dir)).toHaveLength(1);
  });

  it("forgets a cached answer after its day", async () => {
    const dir = dataDir();
    let now = Date.parse("2026-09-15T10:00:00Z");
    let calls = 0;
    const call = async () => { calls += 1; return { text: `v${calls}` }; };
    await runHarnessCall(dir, { ...base, prompt: "p", call }, { budgetExhausted: () => false, now: () => now });
    now += 25 * 60 * 60 * 1000;
    const later = await runHarnessCall(dir, { ...base, prompt: "p", call }, { budgetExhausted: () => false, now: () => now });
    expect(later).toEqual({ text: "v2", cached: false });
  });
});
