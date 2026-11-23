import { mkdirSync, mkdtempSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { mayRead, type Audience } from "../audience.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { appendUsage, type UsageRow } from "../usage-ledger.ts";
import { createBotUsageRoute } from "./bot-usage.ts";

const now = new Date("2026-11-18T14:00:00Z");
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "omb-bot-usage-")); });
afterEach(() => removeTempDir(dataDir));

const row = (fields: Partial<UsageRow> = {}): UsageRow => ({
  at: "2026-11-18T12:00:00Z", botId: "scout", botName: "Scout", threadId: "here", instanceId: "private-account",
  driverKind: "claude", model: "test-model", input: 10, cachedInput: 3, output: 2, costUsd: null,
  trigger: { kind: "user", email: "private@example.test" }, ...fields,
});

const audiences = new Map<string, Audience>([["here", "team"], ["older", "team"], ["private", "member:other"], ["peer", "team"]]);
const readableFrom = (threadId: string) => (otherThreadId: string) => {
  const audience = audiences.get(otherThreadId);
  return audience !== undefined && mayRead(audience, audiences.get(threadId)!);
};

async function query(args: string, deps: Partial<Parameters<typeof createBotUsageRoute>[0]> = {}, botId = "scout") {
  const path = "/api/internal/engine-limits";
  const json = vi.fn();
  const route = createBotUsageRoute({ dataDir, env: {}, now: () => now, guestDriven: () => false, caps: () => undefined,
    readableFrom, crossThreadReads: () => true, knownThread: (_botId, threadId) => audiences.has(threadId),
    canReadCapTotals: () => false, onPlan: () => false, ...deps });
  const url = new URL(`http://localhost${path}${args}`);
  url.searchParams.set("scope", "bot");
  await route({ method: "GET", path, url, res: {} as ServerResponse, json, botId, threadId: "here", requireActive() {} });
  const [, status, body] = json.mock.calls[0]!;
  return { status, body, result: body.text ? JSON.parse(body.text) : null };
}

it("reports only the caller's visible usage and never returns the ledger row", async () => {
  const seeded = [
    row({ contextTokens: 30, contextWindow: 120, outcome: { status: "error", reason: "private-text" } }),
    row({ at: "2026-11-17T12:00:00Z", threadId: "older", costUsd: 0.01 }),
    row({ at: "2026-10-31T23:59:59Z", input: 700 }),
    row({ threadId: "private", input: 800, costUsd: 9 }),
    row({ threadId: "deleted", input: 900 }),
    row({ botId: "other", threadId: "peer", input: 222 }),
  ];
  for (const entry of seeded) expect(await appendUsage(dataDir, entry)).toBe(true);

  const { result, body } = await query("");
  expect(result).toMatchObject({
    period: "today", timeZone: "UTC", totals: { turns: 1, input: 10, output: 2, cachedInput: 3, barTokens: 9, costUsd: null, unpricedTurns: 1 },
    context: { contextTokens: 30, contextWindow: 120 }, caps: [], capsComplete: true,
  });
  expect(body.text).not.toMatch(/private-account|private@example|private-text|deleted/);
  expect((await query("?period=month", { onPlan: () => true })).result.totals).toMatchObject({
    turns: 2, input: 20, costUsd: 0.01, unpricedTurns: 1, notBilled: { usd: 0.01, turns: 1 },
  });
  expect((await query("?period=month&thread=this")).result.totals.turns).toBe(1);
  expect((await query("", {}, "other")).result.totals).toMatchObject({ turns: 1, input: 222 });
});

it("uses enforcement's cap totals for a reply authorized to read the entire cap scope", async () => {
  await appendUsage(dataDir, row({ costUsd: 0.01 }));
  await appendUsage(dataDir, row({ threadId: "private", costUsd: 0.10 }));
  const caps = () => ({ server: { dailyUsd: 0.20 }, bots: { scout: { dailyTokens: 18, monthlyUsd: 0.11 }, other: { dailyTokens: 45 } } });
  const own = await query("?thread=this", { caps, canReadCapTotals: () => true });
  expect(own.result.capsComplete).toBe(true);
  expect(own.result.caps).toEqual([
    expect.objectContaining({ scope: "server", used: 0.11, reached: false }),
    expect.objectContaining({ scope: "bot", unit: "usd", remaining: 0, reached: true, resetsAt: Date.parse("2026-12-01T00:00:00Z") }),
    expect.objectContaining({ scope: "bot", unit: "tokens", used: 18, remaining: 0, reached: true, resetsAt: Date.parse("2026-11-19T00:00:00Z") }),
  ]);
  expect(own.result.totals).toMatchObject({ turns: 1, costUsd: 0.01 });
});

it("keeps cap output stable for hidden usage until the cap that would block work is reached", async () => {
  await appendUsage(dataDir, row({ costUsd: 0.01 }));
  const caps = () => ({ bots: { scout: { dailyTokens: 20, monthlyTokens: 28 } } });
  const initial = await query("", { caps });
  expect(initial.result).toMatchObject({ caps: [], capsComplete: false, stops: null, totals: { turns: 1, costUsd: 0.01 } });
  await appendUsage(dataDir, row({ threadId: "private", input: 9, output: 0, cachedInput: 0 }));
  const read = (seconds: number) => query("", { caps, now: () => new Date(now.getTime() + seconds * 1000) });
  expect((await read(20)).result).toEqual(initial.result);

  await appendUsage(dataDir, row({ at: "2026-11-18T13:00:00Z", threadId: "private", input: 20, output: 0, cachedInput: 0 }));
  const reached = await read(40);
  expect(reached.result.caps).toEqual([
    { scope: "bot", period: "month", unit: "tokens", limit: 28, reached: true, resetsAt: Date.parse("2026-12-01T00:00:00Z") },
  ]);
  expect(reached.result).toMatchObject({ capsComplete: false, stops: "unattended", totals: { turns: 1, costUsd: 0.01 } });
});

it("keeps the current conversation's latest context across the UTC month boundary", async () => {
  await appendUsage(dataDir, row({ at: "2026-10-30T23:59:59Z", contextTokens: 18, contextWindow: 120 }));
  await appendUsage(dataDir, row({ at: "2026-10-31T23:59:59Z", contextTokens: 53, contextWindow: 120 }));
  await appendUsage(dataDir, row({ at: "2026-11-01T00:00:00Z", threadId: "private", contextTokens: 90, contextWindow: 200 }));
  await appendUsage(dataDir, row({ at: "2026-11-02T00:00:00Z", contextTokens: 100, contextWindow: 120 }));
  const deps = { now: () => new Date("2026-11-01T00:05:00Z") };
  const expected = { totals: { turns: 0 }, context: { contextTokens: 53, contextWindow: 120 } };
  expect((await query("", deps)).result).toMatchObject(expected);
  expect((await query("?period=month&thread=this", deps)).result).toMatchObject(expected);
});

it("refuses guest turns and unbounded filters", async () => {
  expect((await query("", { guestDriven: () => true })).status).toBe(403);
  let guestChecks = 0;
  expect((await query("", { guestDriven: () => ++guestChecks === 2 })).status).toBe(403);
  expect((await query("?period=year")).status).toBe(400);
  expect((await query("?thread=private")).status).toBe(400);
});

it("reports a failed month read without claiming zero usage or full headroom", async () => {
  const caps = () => ({ server: { dailyTokens: 20 } });
  expect((await query("", { caps, canReadCapTotals: () => true })).result.caps[0]).toMatchObject({ used: 0, remaining: 20 });
  mkdirSync(join(dataDir, "usage", "2026-11.jsonl"), { recursive: true });
  const failed = await query("", { caps });
  expect(failed.status).toBe(503);
  expect(failed.result).toBeNull();
});
