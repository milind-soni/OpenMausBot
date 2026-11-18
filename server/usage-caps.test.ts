import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { capsFromEnv, capStates, capTokens, effectiveCaps, noteUsage, periodEnd, personWaiting, personWaitingInRoom, reachedCap, resetUsageTotalsForTests, usageCapsSchema, usageTotals, type ThreadStanding } from "./usage-caps.ts";
import { appendUsage, flushUsageLedger, usageFileFor } from "./usage-ledger.ts";

const NO_ENV = {};
const row = (at: string, botId: string, costUsd: number | null, input = 1_000, output = 500, cachedInput?: number) => ({
  at, botId, botName: botId, threadId: `t-${botId}`, instanceId: "claude", driverKind: "claudeAgent", model: "m",
  input, output, ...(cachedInput === undefined ? {} : { cachedInput }), costUsd, trigger: { kind: "owner" as const },
});

describe("what has been used", () => {
  let dataDir: string;
  const now = new Date("2026-09-15T12:00:00Z");
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "omb-caps-")); resetUsageTotalsForTests(); });
  afterEach(async () => { await removeTempDir(dataDir); });

  it("adds up the UTC day and month for the server and for each bot, in dollars and in fresh tokens", async () => {
    appendUsage(dataDir, row("2026-08-31T23:59:59.000Z", "a", 9));
    appendUsage(dataDir, row("2026-09-01T00:00:00.000Z", "a", 1));
    appendUsage(dataDir, row("2026-09-14T23:59:59.000Z", "b", 2, 4_000, 1_000, 3_000));
    appendUsage(dataDir, row("2026-09-15T00:00:00.000Z", "a", 0.5));
    // A model with no price books $0 and still counts its tokens.
    appendUsage(dataDir, row("2026-09-15T08:00:00.000Z", "b", null, 10_000, 2_000));
    await flushUsageLedger(dataDir);
    const totals = usageTotals(dataDir, now);
    expect(totals.server.month).toEqual({ usd: 3.5, tokens: 1_500 + 2_000 + 1_500 + 12_000 });
    expect(totals.server.day).toEqual({ usd: 0.5, tokens: 13_500 });
    expect(totals.bots.get("a")).toEqual({ month: { usd: 1.5, tokens: 3_000 }, day: { usd: 0.5, tokens: 1_500 } });
    expect(totals.bots.get("b")).toEqual({ month: { usd: 2, tokens: 14_000 }, day: { usd: 0, tokens: 12_000 } });
    expect(capTokens({ input: 100, output: 7, cachedInput: 400 })).toBe(7);
  });

  it("counts a turn that was just booked before its row reaches the file, and starts from zero when the period rolls over", async () => {
    expect(usageTotals(dataDir, now).server.day).toEqual({ usd: 0, tokens: 0 });
    const booked = row("2026-09-15T11:59:00.000Z", "a", 0.25);
    noteUsage(dataDir, booked, appendUsage(dataDir, booked));
    expect(usageTotals(dataDir, now).server.day).toEqual({ usd: 0.25, tokens: 1_500 });
    await flushUsageLedger(dataDir);
    await Promise.resolve();
    expect(usageTotals(dataDir, now).server.day).toEqual({ usd: 0.25, tokens: 1_500 });
    const tomorrow = usageTotals(dataDir, new Date("2026-09-16T00:00:01Z"));
    expect([tomorrow.server.day, tomorrow.server.month.usd]).toEqual([{ usd: 0, tokens: 0 }, 0.25]);
    expect(usageTotals(dataDir, new Date("2026-10-01T00:00:01Z")).server.month).toEqual({ usd: 0, tokens: 0 });
    expect([periodEnd("day", now), periodEnd("month", now)]).toEqual([Date.parse("2026-09-16T00:00:00Z"), Date.parse("2026-10-01T00:00:00Z")]);
    expect(periodEnd("month", new Date("2026-12-31T23:00:00Z"))).toBe(Date.parse("2027-01-01T00:00:00Z"));
  });

  it("reads only what was appended since the last look, counts a landed row once, and reads a rewritten file again", async () => {
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1_000);
    appendUsage(dataDir, row("2026-09-15T08:00:00.000Z", "a", 1));
    await flushUsageLedger(dataDir);
    expect(usageTotals(dataDir, now).server.day.usd).toBe(1);
    // Booked here: counted from memory while it is written and once it has landed, and not again when the file is read past it.
    const booked = row("2026-09-15T11:59:00.000Z", "a", 0.5);
    noteUsage(dataDir, booked, appendUsage(dataDir, booked));
    await flushUsageLedger(dataDir);
    await Promise.resolve();
    expect(usageTotals(dataDir, at(1)).server.day.usd).toBe(1.5);
    // Written by something else: seen at the next look after the cache window, from the appended bytes alone.
    appendUsage(dataDir, row("2026-09-15T11:59:30.000Z", "b", 2));
    await flushUsageLedger(dataDir);
    expect(usageTotals(dataDir, at(16)).server.day.usd).toBe(3.5);
    expect(usageTotals(dataDir, at(32)).bots.get("b")!.day.usd).toBe(2);
    // A line still being written is left for the next look.
    appendFileSync(usageFileFor(dataDir, now), JSON.stringify(row("2026-09-15T11:59:40.000Z", "b", 4)).slice(0, 20));
    expect(usageTotals(dataDir, at(48)).server.day.usd).toBe(3.5);
    // The file was rewritten shorter (a restore): it is read from the start.
    writeFileSync(usageFileFor(dataDir, now), JSON.stringify(row("2026-09-15T09:00:00.000Z", "a", 0.25)) + "\n");
    expect(usageTotals(dataDir, at(64)).server).toEqual({ day: { usd: 0.25, tokens: 1_500 }, month: { usd: 0.25, tokens: 1_500 } });
  });

  it("sets no cap at all until one is asked for, and reads 0 as no cap", () => {
    expect(capStates(undefined, dataDir, now, NO_ENV)).toEqual([]);
    expect(capStates({ server: { dailyUsd: 0 }, bots: { a: {} } }, dataDir, now, NO_ENV)).toEqual([]);
    expect(reachedCap(undefined, dataDir, { botId: "a", personWaiting: false }, now, NO_ENV)).toBeNull();
  });

  it("measures each cap, warns from 80%, and names the reached cap that resets last", async () => {
    appendUsage(dataDir, row("2026-09-15T08:00:00.000Z", "a", 4, 8_000, 0));
    appendUsage(dataDir, row("2026-09-15T09:00:00.000Z", "b", 1, 1_000, 0));
    await flushUsageLedger(dataDir);
    const caps = { server: { dailyUsd: 5, monthlyUsd: 5, dailyTokens: 100_000 }, bots: { a: { dailyTokens: 10_000 }, b: { monthlyUsd: 2 } } };
    const states = capStates(caps, dataDir, now, NO_ENV);
    expect(states.map((state) => [state.id, state.used, state.percent, state.warn, state.reached])).toEqual([
      ["server:day:usd", 5, 100, true, true],
      ["server:month:usd", 5, 100, true, true],
      ["server:day:tokens", 9_000, 9, false, false],
      ["bot:a:day:tokens", 8_000, 80, true, false],
      ["bot:b:month:usd", 1, 50, false, false],
    ]);
    expect(reachedCap(caps, dataDir, { botId: "a", personWaiting: false }, now, NO_ENV)).toMatchObject({ id: "server:month:usd", periodKey: "2026-09", resetsAt: Date.parse("2026-10-01T00:00:00Z") });
    // Another bot's cap never stops this bot; a bot's own cap stops only that bot.
    expect(reachedCap({ bots: { a: { dailyTokens: 8_000 } } }, dataDir, { botId: "b", personWaiting: false }, now, NO_ENV)).toBeNull();
    expect(reachedCap({ bots: { a: { dailyTokens: 8_000 } } }, dataDir, { botId: "a", personWaiting: false }, now, NO_ENV)).toMatchObject({ id: "bot:a:day:tokens", periodKey: "2026-09-15" });
  });

  it("stops a person's own message only when the owner chose everything", async () => {
    appendUsage(dataDir, row("2026-09-15T08:00:00.000Z", "a", 4));
    await flushUsageLedger(dataDir);
    const caps = { server: { dailyUsd: 1 } };
    expect(reachedCap(caps, dataDir, { botId: "a", personWaiting: true }, now, NO_ENV)).toBeNull();
    expect(reachedCap({ ...caps, stops: "unattended" }, dataDir, { botId: "a", personWaiting: true }, now, NO_ENV)).toBeNull();
    expect(reachedCap(caps, dataDir, { botId: "a", personWaiting: false }, now, NO_ENV)).toMatchObject({ id: "server:day:usd" });
    expect(reachedCap({ ...caps, stops: "everything" }, dataDir, { botId: "a", personWaiting: true }, now, NO_ENV)).toMatchObject({ id: "server:day:usd" });
    // The cap is raised: the work starts again without anything else being done.
    expect(reachedCap({ server: { dailyUsd: 10 } }, dataDir, { botId: "a", personWaiting: false }, now, NO_ENV)).toBeNull();
  });
});

describe("caps from the environment", () => {
  it("reads the server's caps and what they stop, ignores what is not a number, and wins over config.json", () => {
    const env = { OMB_USAGE_CAP_DAILY_USD: "5", OMB_USAGE_CAP_MONTHLY_TOKENS: "2000000", OMB_USAGE_CAP_DAILY_TOKENS: "1.5", OMB_USAGE_CAP_MONTHLY_USD: "lots", OMB_USAGE_CAP_STOPS: "Everything" };
    expect(capsFromEnv(env)).toEqual({ stops: "everything", server: { dailyUsd: 5, monthlyTokens: 2_000_000 } });
    expect(capsFromEnv({})).toEqual({ server: {} });
    expect(effectiveCaps({ stops: "unattended", server: { dailyUsd: 1, monthlyUsd: 30 }, bots: { a: { dailyUsd: 2 } } }, env))
      .toEqual({ stops: "everything", server: { dailyUsd: 5, monthlyUsd: 30, monthlyTokens: 2_000_000 }, bots: { a: { dailyUsd: 2 } } });
    expect(effectiveCaps(undefined, {})).toEqual({ stops: "unattended", server: {}, bots: {} });
  });

  it("accepts only the documented shape in config.json", () => {
    expect(usageCapsSchema.safeParse({ stops: "everything", server: { dailyUsd: 2.5, monthlyTokens: 1_000 }, bots: { b1: { dailyTokens: 5 } } }).success).toBe(true);
    for (const bad of [{ stops: "nothing" }, { server: { dailyUsd: -1 } }, { server: { dailyTokens: 1.5 } }, { server: { weeklyUsd: 1 } }, { bots: { b1: { dailyUsd: "5" } } }]) {
      expect(usageCapsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("whether a person is waiting on a turn", () => {
  const quiet: ThreadStanding = { unattended: false, automation: undefined, origin: "user" };
  it("always counts a person's own message, even in a conversation an automation used last", () => {
    expect(personWaiting({}, quiet)).toBe(true);
    expect(personWaiting({}, { unattended: true, automation: "webhook", origin: "outside" })).toBe(true);
  });
  it("never counts a routine, webhook, app event or Bot API call, and counts a run started by hand", () => {
    for (const automationSource of ["schedule", "startup", "webhook", "api", "app"]) expect(personWaiting({ automationSource }, quiet), automationSource).toBe(false);
    expect(personWaiting({ automationSource: "manual" }, quiet)).toBe(true);
  });
  it("counts a hand-off by where its work started", () => {
    expect(personWaiting({ commsDepth: 1, origin: { kind: "user" } }, quiet)).toBe(true);
    expect(personWaiting({ commsDepth: 1, origin: { kind: "outside" } }, quiet)).toBe(false);
    expect(personWaiting({ coordination: { id: "n" } }, { ...quiet, origin: "outside" })).toBe(false);
    expect(personWaiting({ coordination: { id: "n" } }, quiet)).toBe(true);
    expect(personWaiting({ commsDepth: 1, origin: { kind: "user" }, unattended: true }, quiet)).toBe(false);
    expect(personWaiting({ peerAsk: { unattended: true }, origin: { kind: "user" } }, quiet)).toBe(false);
  });
  it("counts a continuation by the conversation it continues", () => {
    expect(personWaiting({ cardContinuation: true }, quiet)).toBe(true);
    expect(personWaiting({ cardContinuation: true }, { ...quiet, automation: "schedule" })).toBe(false);
    expect(personWaiting({ cardContinuation: true }, { ...quiet, automation: "manual" })).toBe(true);
    expect(personWaiting({ cardContinuation: true }, { ...quiet, unattended: true })).toBe(false);
    expect(personWaiting({ unattended: true }, quiet)).toBe(false);
  });
  it("counts a room turn unless something other than a person started its run, or it is a routine's own run", () => {
    expect(personWaitingInRoom({ personStarted: true }, undefined)).toBe(true);
    expect(personWaitingInRoom(undefined, undefined)).toBe(true);
    expect(personWaitingInRoom({ personStarted: false }, undefined)).toBe(false);
    expect(personWaitingInRoom({ personStarted: true }, "schedule")).toBe(false);
    expect(personWaitingInRoom({ personStarted: true }, "webhook")).toBe(false);
    expect(personWaitingInRoom({ personStarted: true }, "manual")).toBe(true);
  });
});
