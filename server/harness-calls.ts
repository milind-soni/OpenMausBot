// Harness-initiated model calls (Phase 1 part 2; the Overlay review, item 3).
//
// A one-shot call the HARNESS makes (a compaction summary today; extraction
// and consolidation in Phase 4) is not a turn: nothing booked it, nothing
// stopped it when the money was gone, and a retry paid twice. Every such
// call now goes through runHarnessCall, which
//   1. names the call with an idempotent fingerprint (kind, thread, turn
//      key, prompt) and answers a repeat from a day-long cache on disk,
//   2. asks the budget first and skips quietly when it is exhausted, so
//      background work never fails the turn it serves,
//   3. books one usage row with the actual tokens and cost, marked
//      `trigger.kind: "harness"` and carrying the fingerprint.
// The per-task money cap is Phase 2's; this is the seam it plugs into.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendUsage } from "./usage-ledger.ts";

export interface HarnessCallResult {
  text: string;
  input?: number;
  output?: number;
  cachedInput?: number;
  costUsd?: number | null;
}

export interface HarnessCallInput {
  /** What the call is for: `compaction-summary`, later `memory-extract`. */
  kind: string;
  botId: string;
  botName: string;
  threadId: string;
  /** What makes this call distinct within its thread: the folded message id, a turn id. */
  turnKey: string;
  prompt: string;
  instanceId: string;
  driverKind: string;
  model: string;
  call: (prompt: string) => Promise<HarnessCallResult | string>;
}

export type HarnessCallOutcome = { text: string; cached: boolean } | { skipped: "budget" };

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function harnessCallFingerprint(kind: string, threadId: string, turnKey: string, prompt: string): string {
  return createHash("sha256").update(`${kind}\n${threadId}\n${turnKey}\n`).update(createHash("sha256").update(prompt).digest("hex")).digest("hex");
}

function cachePath(dataDir: string, fingerprint: string): string {
  return join(dataDir, "harness-calls", `${fingerprint}.json`);
}

/** Run the call once. Null means the call failed (the caller falls back to
 * whatever it has without one); a skip says why. */
export async function runHarnessCall(
  dataDir: string,
  input: HarnessCallInput,
  deps: { budgetExhausted: () => boolean; now?: () => number },
): Promise<HarnessCallOutcome | null> {
  const now = deps.now ?? Date.now;
  const fingerprint = harnessCallFingerprint(input.kind, input.threadId, input.turnKey, input.prompt);
  const path = cachePath(dataDir, fingerprint);
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as { at: number; text: string };
    if (typeof cached.text === "string" && now() - cached.at < CACHE_TTL_MS) return { text: cached.text, cached: true };
    unlinkSync(path);
  } catch {
    // no cache entry, or an unreadable one: call
  }
  if (deps.budgetExhausted()) return { skipped: "budget" };
  let result: HarnessCallResult;
  try {
    const raw = await input.call(input.prompt);
    result = typeof raw === "string" ? { text: raw } : raw;
  } catch {
    return null;
  }
  appendUsage(dataDir, {
    at: new Date(now()).toISOString(),
    botId: input.botId,
    botName: input.botName,
    threadId: input.threadId,
    instanceId: input.instanceId,
    driverKind: input.driverKind,
    model: input.model,
    input: result.input ?? 0,
    output: result.output ?? 0,
    ...(typeof result.cachedInput === "number" ? { cachedInput: result.cachedInput } : {}),
    costUsd: typeof result.costUsd === "number" && Number.isFinite(result.costUsd) ? result.costUsd : null,
    trigger: { kind: "harness", call: input.kind },
    fingerprint,
  });
  try {
    mkdirSync(join(dataDir, "harness-calls"), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ at: now(), text: result.text }), { mode: 0o600 });
  } catch {
    // a cache that cannot be written only costs a retry its savings
  }
  return { text: result.text, cached: false };
}
