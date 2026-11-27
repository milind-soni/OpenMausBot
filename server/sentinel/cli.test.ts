import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { parseSentinelArgs, runSentinelCli } from "./cli.ts";
import { runScan } from "./scan.ts";
import { fixtureDataDir, turnCompleted, type FixtureDataDir } from "./testing.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "openmausbot.ts");
const PRIVATE = "Example Client Ltd";

function sentinel(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", ENTRY, "sentinel", ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("openmausbot sentinel", () => {
  let dir: string;
  let fixture: FixtureDataDir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-sentinel-cli-"));
    fixture = fixtureDataDir(join(dir, "data"), [{ id: "b1", name: "Probe", threadId: "t1" }]);
  });
  afterEach(() => {
    fixture.close();
    removeTempDir(dir);
  });

  it("scans a live data dir from the command line, keeps references only, and does nothing when nothing changed", () => {
    const now = Date.now();
    fixture.activity({ threadId: "t1", id: "m1", at: now - 60_000, name: "mcp__agents__send", ok: false, output: `no layer 90 for "${PRIVATE}" in /path/to/project`, turnId: "u1" });
    fixture.activity({ threadId: "t1", id: "m2", at: now - 50_000, name: "mcp__agents__send", ok: false, output: `no layer 104 for "${PRIVATE}" in /path/to/other`, turnId: "u1" });
    appendFileSync(join(fixture.dataDir, "events", "t1.ndjson"), `${turnCompleted({ eventId: "e1", threadId: "t1", turnId: "u1", at: now - 40_000, ok: false, stopReason: "exit_before_result" })}\n`);
    const out = join(dir, "sentinel");

    const first = sentinel("--data-dir", fixture.dataDir, "--out", out, "--once", "--json");
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const summary = JSON.parse(first.stdout);
    expect(summary).toMatchObject({ ok: true, scanned: true, added: 3, records: { tool: 2, turn: 1, queue: 0 }, totalIssues: 2 });
    expect(summary.touched.map((issue: { kind: string; origin: string; count: number }) => [issue.kind, issue.origin, issue.count]).sort()).toEqual([["tool_error", "harness", 2], ["turn_stop", "harness", 1]]);

    const written = readFileSync(join(out, "issues.jsonl"), "utf8") + readFileSync(join(out, "state.json"), "utf8");
    expect(written).not.toContain(PRIVATE);
    expect(written).not.toContain("/path/to");
    // the local title is the normalized line: placeholders where the values were
    expect(written).toContain('"title":"no layer <n> for <q> in <path>"');
    expect(written).toContain('"evidenceRef":{"source":"messages","id":"m2"}');

    const unchanged = sentinel("--data-dir", fixture.dataDir, "--out", out);
    expect(unchanged.status).toBe(0);
    expect(unchanged.stdout).toContain("nothing changed since the last scan (2 issues");

    fixture.activity({ threadId: "t1", id: "m3", at: now - 1_000, name: "mcp__agents__send", ok: false, output: `no layer 7 for "${PRIVATE}" in /path/to/third`, turnId: "u2" });
    const next = sentinel("--data-dir", fixture.dataDir, "--out", out);
    expect(next.status).toBe(0);
    expect(next.stdout).toMatch(/1 new occurrences in 1 issues \(2 total\)/);
    // the readable title, not only the hash; still no private value in it
    expect(next.stdout).toMatch(/high\s+tool_error\s+harness\s+mcp__agents__send ×3, 2 turns: no layer <n> for <q> in <path>/);
    expect(next.stdout).not.toContain(PRIVATE);
  });

  it("fails with a next step for a missing data dir or an output folder inside a repository or the data dir", () => {
    const missing = sentinel("--data-dir", join(dir, "nope"), "--json");
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({ ok: false, error: expect.stringContaining("pass --data-dir") });
    const lines: string[] = [];
    const io = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    expect(runSentinelCli(["--data-dir", fixture.dataDir, "--out", join(fileURLToPath(import.meta.url), "..", "out")], io)).toBe(1);
    expect(lines.join("\n")).toContain("refusing to write issues inside the git repository");
    expect(runSentinelCli(["--data-dir", fixture.dataDir, "--out", join(fixture.dataDir, "sentinel")], io)).toBe(1);
    expect(lines.join("\n")).toContain("refusing to write issues inside the data dir");
    expect(runSentinelCli(["--bogus"], io)).toBe(2);
    // a link into a repository is judged by where it leads ("junction" makes
    // a directory link without privileges on Windows)
    const link = join(dir, "link-to-repo");
    symlinkSync(dirname(fileURLToPath(import.meta.url)), link, "junction");
    lines.length = 0;
    expect(runSentinelCli(["--data-dir", fixture.dataDir, "--out", join(link, "out")], io)).toBe(1);
    expect(lines.join("\n")).toContain("refusing to write issues inside the git repository");
  });

  it("parses its options and defaults the output to a folder of its own, outside the data", () => {
    const parsed = parseSentinelArgs(["--data-dir", "/data/omb"], {});
    expect(parsed).toMatchObject({ dataDir: expect.stringMatching(/omb$/), out: expect.stringMatching(/openmausbot-sentinel[\\/]data-[0-9a-f]{12}$/), json: false });
    expect("out" in parsed && parsed.out.includes(join("data", "omb"))).toBe(false);
    expect(parseSentinelArgs(["--queue-wait", "600", "--cost", "2.5", "--json"], { OMB_DATA_DIR: "/d" })).toMatchObject({ queueWaitMs: 600_000, costUsd: 2.5, json: true });
    expect(parseSentinelArgs(["--cost", "-1"], {})).toEqual({ error: expect.stringContaining("--cost"), json: false });
    // an unset variable in a script is an error, not a threshold of 0
    expect(parseSentinelArgs(["--cost", ""], {})).toEqual({ error: expect.stringContaining("--cost"), json: false });
    expect(parseSentinelArgs(["--queue-wait", "  "], {})).toEqual({ error: expect.stringContaining("--queue-wait"), json: false });
    // finite seconds whose milliseconds are not
    expect(parseSentinelArgs(["--queue-wait", "1e308"], {})).toEqual({ error: expect.stringContaining("--queue-wait"), json: false });
    expect(parseSentinelArgs(["--out"], {})).toEqual({ error: "--out needs a value", json: false });
  });

  it("rereads a tool row whose outcome landed after the previous scan", () => {
    const out = join(dir, "sentinel");
    const now = Date.now();
    fixture.activity({ threadId: "t1", id: "m1", at: now - 5_000, name: "Bash" });
    expect(runScan({ dataDir: fixture.dataDir, out, now }).added).toBe(0);
    fixture.activity({ threadId: "t1", id: "m1", at: now - 5_000, name: "Bash", ok: false, output: "exit 1" });
    const later = runScan({ dataDir: fixture.dataDir, out, now: now + 120_000 });
    expect(later.touched).toMatchObject([{ kind: "tool_error", origin: "shell", count: 1 }]);
    // a forced rescan of the same window counts nothing twice
    fixture.activity({ threadId: "t2", id: "m9", at: now - 4_000, name: "Bash", ok: true });
    expect(runScan({ dataDir: fixture.dataDir, out, now: now + 240_000 }).added).toBe(0);
  });

  it("starts over safely from a dropped state file, counting nothing twice", () => {
    const out = join(dir, "sentinel");
    const now = Date.now();
    fixture.activity({ threadId: "t1", id: "m1", at: now - 60_000, name: "mcp__agents__send", ok: false, output: "no layer 1" });
    appendFileSync(join(fixture.dataDir, "events", "t1.ndjson"), `${turnCompleted({ eventId: "e1", threadId: "t1", at: now - 50_000, ok: false, stopReason: "error" })}\n`);
    expect(runScan({ dataDir: fixture.dataDir, out, now }).added).toBe(2);
    // what a state version bump does: the cursors and counted keys are gone
    writeFileSync(join(out, "state.json"), JSON.stringify({ version: 0 }));
    fixture.activity({ threadId: "t1", id: "m2", at: now + 1_000, name: "mcp__agents__send", ok: false, output: "no layer 2" });
    const again = runScan({ dataDir: fixture.dataDir, out, now: now + 120_000 });
    expect(again.added).toBe(1);
    expect(again.touched).toMatchObject([{ kind: "tool_error", count: 2 }]);
  });

  it("--check-install reports a schedule whose node or script has moved", () => {
    const lines: string[] = [];
    const io = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    const unit = "/Users/maus/Library/LaunchAgents/com.openmausbot.sentinel.plist";
    const plist = `<key>ProgramArguments</key>\n<array>\n<string>/old/node</string>\n<string>/Applications/OpenMausBot.app/Contents/Resources/server/openmausbot.js</string>\n<string>sentinel</string>\n</array>`;
    const host = (present: string[]) => ({ platform: "darwin" as const, home: "/Users/maus", exists: (path: string) => path === unit || present.includes(path), read: () => plist });
    expect(runSentinelCli(["--check-install"], io, {}, host(["/Applications/OpenMausBot.app/Contents/Resources/server/openmausbot.js"]))).toBe(1);
    expect(lines.join("\n")).toContain("stale install: /Users/maus/Library/LaunchAgents/com.openmausbot.sentinel.plist needs /old/node, which no longer exists; rerun openmausbot service install --sentinel");
    lines.length = 0;
    expect(runSentinelCli(["--check-install", "--json"], io, {}, host(["/old/node", "/Applications/OpenMausBot.app/Contents/Resources/server/openmausbot.js"]))).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, status: "ok", node: "/old/node" });
    lines.length = 0;
    expect(runSentinelCli(["--check-install"], io, {}, { ...host([]), exists: () => false })).toBe(1);
    expect(lines.join("\n")).toContain("install one with openmausbot service install --sentinel");
  });
});
