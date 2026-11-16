import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { resetUsageTotalsForTests, type UsageCapsConfig } from "../usage-caps.ts";
import { appendUsage, flushUsageLedger } from "../usage-ledger.ts";
import { capResets, createUsageCapGate, marksOf } from "./usage-cap-gate.ts";

describe("the usage cap gate", () => {
  let dataDir: string;
  let now: Date;
  let caps: UsageCapsConfig | undefined;
  let notices: Array<{ about: string | undefined; title: string; body: string }>;
  let log: string[];
  const gate = (env: NodeJS.ProcessEnv = {}) => createUsageCapGate({
    dataDir, caps: () => caps, botName: (botId) => ({ a: "Ada", b: "Bo" } as Record<string, string>)[botId], now: () => now, env,
    notice: (about, title, body) => notices.push({ about, title, body }), log: (line) => log.push(line),
  });
  const spend = async (at: string, botId: string, costUsd: number, tokens = 1_000) => {
    appendUsage(dataDir, { at, botId, botName: botId, threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m", input: tokens, output: 0, costUsd, trigger: { kind: "owner" } });
    await flushUsageLedger(dataDir);
    resetUsageTotalsForTests();
  };
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-cap-gate-"));
    resetUsageTotalsForTests();
    now = new Date("2026-09-15T12:00:00Z");
    caps = undefined;
    notices = [];
    log = [];
  });
  afterEach(async () => { await removeTempDir(dataDir); });

  it("lets everything through and says nothing while no cap is set", async () => {
    await spend("2026-09-15T08:00:00.000Z", "a", 500);
    const open = gate();
    open.assertTurn("a", false);
    open.booked("a");
    expect([open.refusal("a", false), open.routineSkip("a", "r1"), open.runText("a", "webhook"), open.handoff("a", "outside")]).toEqual([null, null, null, null]);
    expect(open.view()).toEqual({ stops: "unattended", savedStops: "unattended", server: {}, bots: {}, env: { stops: false, server: [], values: { server: {} } }, caps: [] });
    expect([notices, log]).toEqual([[], []]);
  });

  it("says one line in the log at 80%, and one notice when the cap is reached, however often it is asked", async () => {
    caps = { server: { dailyUsd: 10 } };
    const open = gate();
    await spend("2026-09-15T08:00:00.000Z", "a", 7.9);
    open.booked("a");
    expect([notices, log]).toEqual([[], []]);
    await spend("2026-09-15T09:00:00.000Z", "a", 0.2);
    open.booked("a");
    open.booked("a");
    expect(log).toEqual(["usage cap at 81%: server:day:usd $8.10 of $10.00"]);
    expect(notices).toEqual([]);
    expect(open.refusal("a", false)).toBeNull();

    await spend("2026-09-15T10:00:00.000Z", "b", 2);
    open.booked("b");
    for (let i = 0; i < 5; i += 1) expect(open.refusal("a", false)).toContain("the daily usage cap for all bots ($10.00) is reached");
    open.booked("a");
    const resets = capResets(Date.parse("2026-09-16T00:00:00Z"));
    expect(notices).toEqual([{ about: "b", title: "Usage cap reached",
      body: `Unattended work is skipped until ${resets}: the daily usage cap for all bots ($10.00) is reached. Your own messages still run.` }]);
    expect(log).toHaveLength(2);
    expect(log[1]).toBe("usage cap reached: server:day:usd $10.10 of $10.00; unattended work waits until 2026-09-16T00:00:00.000Z");

    // A restart does not repeat the notice; the next day's cap is a new one.
    expect(JSON.parse(readFileSync(join(dataDir, "usage", "cap-notices.json"), "utf8"))).toEqual({ "server:day:usd": { period: "2026-09-15", limit: 10, warn: true, reached: true } });
    const restarted = gate();
    restarted.booked("a");
    expect(restarted.refusal("a", false)).not.toBeNull();
    expect(notices).toHaveLength(1);
    now = new Date("2026-09-16T00:00:01Z");
    resetUsageTotalsForTests();
    expect(restarted.refusal("a", false)).toBeNull();
    await spend("2026-09-16T00:00:02.000Z", "a", 11);
    now = new Date("2026-09-16T00:00:03Z");
    restarted.booked("a");
    expect(notices).toHaveLength(2);
  });

  it("refuses unattended work with a 409 that names the cap and its reset, and lets a person's own message run", async () => {
    caps = { bots: { a: { monthlyTokens: 5_000 } } };
    await spend("2026-09-10T08:00:00.000Z", "a", 0, 6_000);
    const open = gate();
    open.assertTurn("a", true);
    open.assertTurn("b", false);
    let refused: unknown;
    try { open.assertTurn("a", false); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ status: 409, code: "spend_cap", resetsAt: Date.parse("2026-10-01T00:00:00Z"),
      message: `Not started: Ada’s monthly usage cap (5,000 tokens) is reached. New work starts again by itself after ${capResets(Date.parse("2026-10-01T00:00:00Z"))}, or sooner if the owner raises the cap in Settings → Usage.` });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ about: "a" });

    caps = { stops: "everything", bots: { a: { monthlyTokens: 5_000 } } };
    expect(() => open.assertTurn("a", true)).toThrow(/Ada’s monthly usage cap/);
    caps = { bots: { a: { monthlyTokens: 50_000 } } };
    open.assertTurn("a", false);
  });

  it("gives a routine one counted row a period, a queued run its line, and a bot handing work on what to say", async () => {
    caps = { server: { dailyTokens: 1_000 } };
    await spend("2026-09-15T08:00:00.000Z", "a", 0, 1_000);
    const open = gate();
    const skip = open.routineSkip("a", "r1")!;
    const resets = capResets(Date.parse("2026-09-16T00:00:00Z"));
    // Each routine under the cap keeps its own row: the routine's id is part of the row's cause.
    expect([skip.behind, skip.resetsAt]).toEqual(["cap:r1:server:day:tokens:2026-09-15", Date.parse("2026-09-16T00:00:00Z")]);
    expect(open.routineSkip("b", "r2")!.behind).toBe("cap:r2:server:day:tokens:2026-09-15");
    expect(skip.words(1)).toEqual({ text: `Skipped: the daily usage cap for all bots (1,000 tokens) is reached. Runs start again after ${resets}`,
      codes: { errorCode: "routines.server.capSkippedOne", errorParams: { why: "routines.server.part.capServerDay", amount: "1,000 tokens", resets } } });
    expect(skip.words(3).text).toBe(`Skipped 3 runs: the daily usage cap for all bots (1,000 tokens) is reached. Runs start again after ${resets}`);
    expect(open.runText("a", "webhook")).toContain("Not started: the daily usage cap for all bots (1,000 tokens) is reached.");
    expect(open.runText("a", "manual")).toBeNull();
    expect(open.handoff("b", "user")).toBeNull();
    expect(open.handoff("b", "outside")).toBe(`Nothing was handed to @Bo: the daily usage cap for all bots (1,000 tokens) is reached, and nobody is waiting on this work. Work like this starts again by itself after ${resets}. `
      + "Say that in one line and stop. Do not retry, and do not hand this to another bot to work around the cap.");
    expect(notices).toHaveLength(1);
  });

  it("shows the owner each cap with its use, and which values the environment holds", async () => {
    caps = { stops: "unattended", server: { dailyUsd: 4 }, bots: { a: { dailyUsd: 1 } } };
    await spend("2026-09-15T08:00:00.000Z", "a", 0.5);
    const view = gate({ OMB_USAGE_CAP_DAILY_USD: "2", OMB_USAGE_CAP_STOPS: "everything" }).view();
    expect(view).toMatchObject({ stops: "everything", savedStops: "unattended", server: { dailyUsd: 4 }, bots: { a: { dailyUsd: 1 } },
      env: { stops: true, server: ["dailyUsd"], values: { stops: "everything", server: { dailyUsd: 2 } } } });
    expect(view.caps.map((cap) => [cap.id, cap.limit, cap.used, cap.percent])).toEqual([["server:day:usd", 2, 0.5, 25], ["bot:a:day:usd", 1, 0.5, 50]]);
  });

  it("reads a notices file out of shape as far as it is good, and never throws at the start of a turn", async () => {
    expect(marksOf({ ok: { period: "2026-09-15", limit: 10, warn: true }, noPeriod: { limit: 1 }, badPeriod: { period: 7, limit: 1 }, oddPeriod: { period: "soon", limit: 1 },
      noLimit: { period: "2026-09" }, nothing: null, text: "x", list: [1] })).toEqual({ ok: { period: "2026-09-15", limit: 10, warn: true } });
    for (const value of [null, [], "x", 3]) expect(marksOf(value)).toEqual({});
    caps = { server: { dailyTokens: 1_000 } };
    await spend("2026-09-15T08:00:00.000Z", "a", 0, 1_000);
    mkdirSync(join(dataDir, "usage"), { recursive: true });
    writeFileSync(join(dataDir, "usage", "cap-notices.json"), JSON.stringify({ "server:day:tokens": { period: null }, other: 5 }));
    const open = gate();
    expect(() => open.assertTurn("a", false)).toThrow(/is reached/);
    open.booked("a");
    expect(notices).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dataDir, "usage", "cap-notices.json"), "utf8"))).toEqual({ "server:day:tokens": { period: "2026-09-15", limit: 1_000, warn: true, reached: true } });
  });
});
