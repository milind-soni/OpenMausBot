import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import {
  appendUsage,
  flushUsageLedger,
  parseUsageRange,
  readUsage,
  summarizeUsage,
  triggerKey,
  triggerLabel,
  usageCsv,
  usageFileFor,
  type UsageRow,
} from "./usage-ledger.ts";

function row(overrides: Partial<UsageRow> = {}): Omit<UsageRow, "at"> & { at?: string } {
  return {
    botId: "b1",
    botName: "Scout",
    threadId: "t1",
    instanceId: "claude",
    driverKind: "claudeAgent",
    model: "claude-sonnet-5",
    input: 1200,
    output: 300,
    cachedInput: 900,
    costUsd: 0.012,
    trigger: { kind: "user", email: "ada@example.test", label: "Ada's laptop" },
    ...overrides,
  };
}

describe("usage ledger files", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "omb-usage-")); });
  afterEach(async () => { await removeTempDir(dataDir); });

  it("appends one private row per turn into the month's file and reads it back in order", async () => {
    appendUsage(dataDir, row({ at: "2026-09-03T10:00:00.000Z" }));
    appendUsage(dataDir, row({ at: "2026-09-03T11:00:00.000Z", botId: "b2", botName: "Clerk", costUsd: null }));
    appendUsage(dataDir, row({ at: "2026-10-01T00:00:00.000Z", botId: "b3", botName: "Later" }));
    await flushUsageLedger(dataDir);
    const september = usageFileFor(dataDir, new Date("2026-09-15T00:00:00Z"));
    expect(september.endsWith(join("usage", "2026-09.jsonl"))).toBe(true);
    expect(readFileSync(september, "utf8").trim().split("\n")).toHaveLength(2);
    if (process.platform !== "win32") {
      expect(statSync(september).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "usage")).mode & 0o777).toBe(0o700);
    }
    const rows = readUsage(dataDir, { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-31T23:59:59Z") });
    expect(rows.map((r) => r.botId)).toEqual(["b1", "b2", "b3"]);
    expect(rows[1]!.costUsd).toBeNull();
  });

  it("filters by time, skips torn lines and foreign rows, and never stores a negative or fractional token", async () => {
    appendUsage(dataDir, row({ at: "2026-09-03T10:00:00.000Z", input: -5, output: 12.7, cachedInput: Number.NaN, costUsd: -1 }));
    await flushUsageLedger(dataDir);
    const file = usageFileFor(dataDir, new Date("2026-09-03T00:00:00Z"));
    writeFileSync(file, readFileSync(file, "utf8") + '{"at":"2026-09-04T00:00:00.000Z","botId":"x"' + "\n" + JSON.stringify({ unrelated: true }) + "\n", { flag: "w" });
    const rows = readUsage(dataDir, { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T23:59:59Z") });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ input: 0, output: 12, cachedInput: 0, costUsd: null });
    expect(readUsage(dataDir, { from: new Date("2026-09-04T00:00:00Z"), to: new Date("2026-09-30T23:59:59Z") })).toHaveLength(0);
  });

  it("keeps a full disk or a missing directory from failing the turn", async () => {
    appendUsage(join(dataDir, "missing-file-as-dir"), row());
    writeFileSync(join(dataDir, "blocked"), "not a directory");
    appendUsage(join(dataDir, "blocked"), row());
    await expect(flushUsageLedger(join(dataDir, "blocked"))).resolves.toBeUndefined();
    expect(existsSync(join(dataDir, "blocked", "usage"))).toBe(false);
  });
});

describe("usage ranges", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it("defaults to the month to date and accepts inclusive day bounds", () => {
    expect(parseUsageRange(undefined, undefined, now)).toEqual({ from: new Date("2026-09-01T00:00:00Z"), to: now });
    const range = parseUsageRange("2026-08-01", "2026-08-31", now)!;
    expect(range.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-08-31T23:59:59.999Z");
  });

  it("rejects malformed, impossible, reversed, or year-long ranges", () => {
    expect(parseUsageRange("2026-8-1", undefined, now)).toBeNull();
    expect(parseUsageRange("2026-02-31", undefined, now)).toBeNull();
    expect(parseUsageRange("2026-09-10", "2026-09-01", now)).toBeNull();
    expect(parseUsageRange("2025-01-01", "2026-09-01", now)).toBeNull();
    expect(parseUsageRange("2025-09-10", "2026-09-10", now)).not.toBeNull();
  });
});

describe("usage summaries", () => {
  const rows: UsageRow[] = [
    { ...row({ at: "2026-09-01T10:00:00.000Z" }), at: "2026-09-01T10:00:00.000Z" } as UsageRow,
    { ...row({ at: "2026-09-01T11:00:00.000Z", botId: "b2", botName: "Clerk", model: "gpt-5", driverKind: "codex", costUsd: null, trigger: { kind: "owner" } }), at: "2026-09-01T11:00:00.000Z" } as UsageRow,
    { ...row({ at: "2026-09-02T09:00:00.000Z", input: 100, output: 50, cachedInput: 0, costUsd: 0.5, trigger: { kind: "routine", routineId: "r1", label: "Morning digest" } }), at: "2026-09-02T09:00:00.000Z" } as UsageRow,
    { ...row({ at: "2026-09-02T10:00:00.000Z", botId: "b2", botName: "Clerk", costUsd: 0.001, trigger: { kind: "bot", botId: "b1" } }), at: "2026-09-02T10:00:00.000Z" } as UsageRow,
  ];

  it("groups by bot, money first, and counts unpriced rows instead of hiding them", () => {
    const summary = summarizeUsage(rows, "bot");
    expect(summary.groups.map((g) => [g.label, g.turns, g.costUsd, g.unpriced])).toEqual([
      ["Scout", 2, 0.512, 0],
      ["Clerk", 2, 0.001, 1],
    ]);
    expect(summary.total).toMatchObject({ turns: 4, input: 1200 + 1200 + 100 + 1200, output: 300 + 300 + 50 + 300, cachedInput: 900 * 3, unpriced: 1 });
    expect(summary.total.costUsd).toBeCloseTo(0.513, 6);
  });

  it("groups by person with stable keys, by model, by engine, and by day in date order", () => {
    expect(summarizeUsage(rows, "user").groups.map((g) => [g.key, g.label])).toEqual([
      ["routine:r1", "Routine: Morning digest"],
      ["user:ada@example.test", "ada@example.test"],
      ["bot", "Bot to bot"],
      ["owner", "This computer"],
    ]);
    expect(summarizeUsage(rows, "model").groups.map((g) => g.key)).toEqual(["model:claudeAgent/claude-sonnet-5", "model:codex/gpt-5"]);
    expect(summarizeUsage(rows, "engine").groups.map((g) => g.label)).toEqual(["claudeAgent", "codex"]);
    expect(summarizeUsage(rows, "day").groups.map((g) => [g.label, g.turns])).toEqual([["2026-09-01", 2], ["2026-09-02", 2]]);
    expect(summarizeUsage([], "day")).toEqual({ groups: [], total: expect.objectContaining({ turns: 0, costUsd: null }) });
  });

  it("prices groups from the operator's list and adds a billable column to the CSV only then", () => {
    const prices = { default: { inputPerMillion: 1000, outputPerMillion: 2000 }, "codex/gpt-5": { inputPerMillion: 0, outputPerMillion: 0 } };
    const priced = summarizeUsage(rows, "bot", prices);
    // Scout: one claude turn of 1200 in (900 cached at the input rate) / 300 out, one of 100 / 50
    expect(priced.groups[0]!.billableUsd).toBeCloseTo((1200 * 1000 + 300 * 2000) / 1e6 + (100 * 1000 + 50 * 2000) / 1e6, 9);
    // Clerk: one gpt-5 turn priced at zero, one claude turn at the default
    expect(priced.groups[1]!.billableUsd).toBeCloseTo((1200 * 1000 + 300 * 2000) / 1e6, 9);
    expect(priced.total.billableUsd).toBeCloseTo(priced.groups[0]!.billableUsd! + priced.groups[1]!.billableUsd!, 9);
    expect(summarizeUsage(rows, "bot").total.billableUsd).toBeNull();
    expect(usageCsv([rows[0]!], prices).split("\n")[0]).toContain(",cost_usd,billable_usd,thread");
    expect(usageCsv([rows[0]!], prices).split("\n")[1]).toContain(",0.012,1.8,t1");
    expect(usageCsv([rows[0]!]).split("\n")[0]).not.toContain("billable_usd");
  });

  it("names a person by email before device label and never throws on an empty trigger", () => {
    expect(triggerLabel({ kind: "user", label: "Phone" })).toBe("Phone");
    expect(triggerKey({ kind: "user", email: "Ada@Example.test" })).toBe("user:ada@example.test");
    expect(triggerKey({ kind: "user" })).toBe("user:unknown");
    expect(triggerLabel({ kind: "routine" })).toBe("Routine: unknown");
  });

  it("exports spreadsheet-safe CSV with one line per turn", () => {
    const csv = usageCsv([
      rows[0]!,
      { ...rows[1]!, botName: '=HYPERLINK("x")', trigger: { kind: "user", email: "a,b@example.test" } },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("time,bot,model,engine,triggered_by,input_tokens,output_tokens,cached_input_tokens,cost_usd,thread");
    expect(lines[1]).toBe("2026-09-01T10:00:00.000Z,Scout,claude-sonnet-5,claudeAgent,ada@example.test,1200,300,900,0.012,t1");
    expect(lines[2]).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(lines[2]).toContain('"a,b@example.test"');
    expect(lines[2]).toMatch(/,,t1$/);
  });
});
