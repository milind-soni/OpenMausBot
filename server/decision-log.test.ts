// The decision log's own mechanics: what a row looks like on disk, that
// credential-shaped content never reaches the file, that the file stays
// private, that month files are kept for the retention window (and older
// servers' single file is still read), that a person's answer names who
// gave it, and the CSV export. The WIRING — which decisions get written at
// all — is pinned separately in decision-log-wiring.test.ts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendDecision, decisionFileFor, decisionRetentionDays, decisionsCsv, DEFAULT_DECISION_RETENTION_DAYS, flushDecisionLog,
  pruneDecisions, readDecisionRange, readDecisions, withDecisionActor, type DecisionRow,
} from "./decision-log.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let dir: string;
const file = () => decisionFileFor(dir, new Date());

const row = (overrides: Partial<DecisionRow> = {}): Omit<DecisionRow, "at"> => ({
  threadId: "t1",
  requestId: "req-1",
  botId: "b1",
  botName: "Scout",
  tool: "Bash",
  summary: "git status",
  decision: "auto-approved",
  source: "full-access",
  rule: "Bash:git",
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-decisions-"));
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe("appendDecision / readDecisions", () => {
  it("writes one NDJSON row per decision and reads them back newest last", async () => {
    appendDecision(dir, row());
    appendDecision(dir, row({ requestId: "req-2", decision: "card-shown", source: "no-grant", rule: undefined }));
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].decision).toBe("auto-approved");
    expect(rows[0].rule).toBe("Bash:git");
    expect(rows[0].botName).toBe("Scout");
    expect(Number.isNaN(new Date(rows[0].at).getTime())).toBe(false);
    expect(rows[1].decision).toBe("card-shown");
    expect(rows[1].source).toBe("no-grant");
  });

  it("returns only the newest `limit` rows", async () => {
    for (const id of ["req-1", "req-2", "req-3"]) appendDecision(dir, row({ requestId: id }));
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 2);
    expect(rows.map((r) => r.requestId)).toEqual(["req-2", "req-3"]);
  });

  it("keeps credential-shaped content out of the written row", async () => {
    // Both shapes redact.ts guards against: a known key prefix, and a
    // KEY=value pair with a secret-shaped name. The summary is whatever
    // the agent typed — this is exactly how a key ends up in a log.
    const secret = "sk-live-abcdefghijklmnop1234";
    appendDecision(dir, row({ summary: `export STRIPE_API_KEY=${secret}` }));
    await flushDecisionLog(dir);
    const raw = readFileSync(file(), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("redacted");
    expect(readDecisions(dir, 10)[0].summary).toContain("redacted");
  });

  it.skipIf(process.platform === "win32")("creates the file private (0600)", async () => {
    appendDecision(dir, row());
    await flushDecisionLog(dir);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("writes one file per UTC month under decisions/ and never overwrites history", async () => {
    for (let i = 0; i < 50; i += 1) appendDecision(dir, row({ requestId: `req-${i}`, summary: "x".repeat(2_000) }));
    await flushDecisionLog(dir);
    expect(file()).toMatch(/decisions[\\/]\d{4}-\d{2}\.ndjson$/);
    expect(readdirSync(join(dir, "decisions"))).toEqual([file().slice(-14)]);
    expect(readDecisions(dir, 100)).toHaveLength(50);
    expect(existsSync(join(dir, "decisions.ndjson"))).toBe(false);
  });

  it("still reads an older server's decisions.ndjson and .1, oldest first, before the month files", async () => {
    const legacy = (id: string) => JSON.stringify({ at: "2026-01-02T00:00:00.000Z", threadId: "t0", requestId: id, decision: "user-approved", source: "user" }) + "\n";
    writeFileSync(join(dir, "decisions.ndjson.1"), legacy("old-1"));
    writeFileSync(join(dir, "decisions.ndjson"), legacy("old-2"));
    appendDecision(dir, row({ requestId: "new-1" }));
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 10).map((r) => r.requestId)).toEqual(["old-1", "old-2", "new-1"]);
    // the newest page is read from the newest month file backwards
    expect(readDecisions(dir, 1).map((r) => r.requestId)).toEqual(["new-1"]);
    // the legacy files are read, never written
    expect(readFileSync(join(dir, "decisions.ndjson"), "utf8")).toBe(legacy("old-2"));
  });

  it("deletes a month only once the whole month is older than the window, so at least that much is kept", async () => {
    const month = (key: string) => join(dir, "decisions", `${key}.ndjson`);
    mkdirSync(join(dir, "decisions"));
    for (const key of ["2026-01", "2026-02", "2026-03"]) writeFileSync(month(key), JSON.stringify({ at: `${key}-15T00:00:00.000Z`, threadId: "t", decision: "card-shown", source: "no-grant" }) + "\n");
    writeFileSync(join(dir, "decisions.ndjson"), "{}\n");
    const oldTime = new Date("2026-01-20T00:00:00Z");
    utimesSync(join(dir, "decisions.ndjson"), oldTime, oldTime);
    writeFileSync(join(dir, "decisions", "notes.txt"), "not ours");
    // 30 days before 2026-03-31 is 2026-03-01: January and February have ended by then, March has not.
    const removed = await pruneDecisions(dir, 30, new Date("2026-03-31T00:00:00Z"));
    expect(removed.sort()).toEqual(["2026-01.ndjson", "2026-02.ndjson", "decisions.ndjson"]);
    expect(existsSync(month("2026-03"))).toBe(true);
    expect(existsSync(join(dir, "decisions", "notes.txt"))).toBe(true);
    // one day earlier February's last day is still inside the window
    writeFileSync(month("2026-02"), "");
    expect(await pruneDecisions(dir, 30, new Date("2026-03-30T00:00:00Z"))).toEqual([]);
  });

  it("takes the retention window from the environment, then config, then 180 days", () => {
    expect(DEFAULT_DECISION_RETENTION_DAYS).toBe(180);
    expect(decisionRetentionDays(undefined, {})).toBe(180);
    expect(decisionRetentionDays(365, {})).toBe(365);
    expect(decisionRetentionDays(365, { OMB_DECISION_RETENTION_DAYS: "30" })).toBe(30);
    for (const bad of ["0", "-1", "1.5", "forever", "4000", ""]) expect(decisionRetentionDays(90, { OMB_DECISION_RETENTION_DAYS: bad }), bad).toBe(90);
    expect(decisionRetentionDays(0, {})).toBe(180);
  });

  it("names who answered on a person's decision, and only there", async () => {
    await withDecisionActor({ kind: "session", sessionId: "s1", label: "Laptop", email: "ada@example.test" }, async () => {
      await Promise.resolve();
      appendDecision(dir, row({ requestId: "answered", decision: "user-approved", source: "user" }));
      appendDecision(dir, row({ requestId: "rule", decision: "auto-approved", source: "full-access" }));
    });
    appendDecision(dir, row({ requestId: "outside", decision: "user-denied", source: "user" }));
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 10);
    expect(rows.find((r) => r.requestId === "answered")?.actor).toEqual({ kind: "session", sessionId: "s1", label: "Laptop", email: "ada@example.test" });
    expect(rows.find((r) => r.requestId === "rule")?.actor).toBeUndefined();
    expect(rows.find((r) => r.requestId === "outside")?.actor).toBeUndefined();
  });

  it("exports a date range as CSV with formula cells neutralised and secrets still redacted", async () => {
    const legacy = { at: "2026-02-10T10:00:00.000Z", threadId: "t1", requestId: "r1", botName: "=HYPERLINK(\"https://evil\")", tool: "Bash",
      summary: "export STRIPE_API_KEY=sk-live-abcdefghijklmnop1234", decision: "user-approved", source: "user",
      actor: { kind: "session", sessionId: "s1", label: "Laptop", email: "+ada@example.test" } };
    writeFileSync(join(dir, "decisions.ndjson"), [legacy, { ...legacy, at: "2026-04-01T00:00:00.000Z", requestId: "outside" }].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const rows = readDecisionRange(dir, { from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-02-28T23:59:59Z") });
    expect(rows.map((r) => r.requestId)).toEqual(["r1"]);
    const csv = decisionsCsv(rows);
    const [header, line] = csv.trim().split("\n");
    expect(header).toBe("time,decision,source,bot,tool,summary,rule,unattended,answered_by,thread,request");
    expect(line).toContain("'=HYPERLINK");
    expect(line).toContain("'+ada@example.test");
    expect(line).not.toContain("sk-live-abcdefghijklmnop1234");
    expect(decisionsCsv([{ ...legacy, actor: { kind: "worker" } } as DecisionRow])).toContain("Local service");
  });

  it("skips a corrupt line instead of losing the rows around it", async () => {
    appendDecision(dir, row({ requestId: "req-1" }));
    await flushDecisionLog(dir);
    appendFileSync(file(), "not json at all\n");
    appendDecision(dir, row({ requestId: "req-2" }));
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 10).map((r) => r.requestId)).toEqual(["req-1", "req-2"]);
  });

  it("reads an empty log as an empty list, not an error", () => {
    expect(readDecisions(dir, 10)).toEqual([]);
  });

  it("serializes a burst without dropping or reordering rows", async () => {
    for (let i = 0; i < 100; i += 1) appendDecision(dir, row({ requestId: `req-${i}` }));
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 100).map((entry) => entry.requestId)).toEqual(
      Array.from({ length: 100 }, (_, i) => `req-${i}`),
    );
  });
});
