import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVALS_LANE, ISOLATE, isolationRefusal, laneCommand, lanesFor, PACKAGED_SERVER_LANE, runLanes, vitestLane } from "./ci-linux-lanes.mjs";
import { vitestMatrix } from "./ci-scope.mjs";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch() {
  const directory = mkdtempSync(join(tmpdir(), "omb-ci-lanes-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Linux lanes", () => {
  it("gives every Linux shard its own lane, the node tests only on the first, then evals and the packaged server", () => {
    const shards = vitestMatrix(["ubuntu-latest"]).include;
    const lanes = lanesFor({ vitest: shards, evals: true, packaged_server: true }, "/t/retries.jsonl");
    expect(lanes.map((lane) => lane.name)).toEqual([
      ...shards.map((entry) => `vitest (ubuntu-latest, ${entry.part})`), EVALS_LANE.name, PACKAGED_SERVER_LANE.name,
    ]);
    expect(lanes[0]).toEqual({
      name: "vitest (ubuntu-latest, shard 1/8)",
      env: { OMB_VITEST_RETRY_LOG: "/t/retries.jsonl", OMB_VITEST_E2E: "all", OMB_VITEST_SUBSET: "" },
      commands: ["pnpm exec vitest run  --shard=1/8 --reporter=default --reporter=github-actions", "pnpm broker:test && pnpm test:electron"],
    });
    expect(lanes.slice(1, 8).every((lane) => lane.commands.length === 1)).toBe(true);
  });

  it("runs a subset's files and leaves out what the plan leaves out", () => {
    const entry = { os: "ubuntu-latest", part: "docs tests", shard: 1, shards: 1, files: "a.test.ts b.test.ts", e2e: "all", node_tests: false };
    expect(lanesFor({ vitest: [entry], evals: false, packaged_server: false }, "/r")).toEqual([vitestLane(entry, "/r")]);
    expect(vitestLane(entry, "/r").commands).toEqual(["pnpm exec vitest run a.test.ts b.test.ts --shard=1/1 --reporter=default --reporter=github-actions"]);
    expect(lanesFor({ vitest: [], evals: true, packaged_server: false }, "/r")).toEqual([EVALS_LANE]);
  });

  it("runs lanes at once, prints each log whole when it ends, and names every lane that failed or ran out of time", async () => {
    const lines: string[] = [];
    let summary = "";
    const failed = await runLanes([
      { name: "slow pass", env: { WORD: "late" }, commands: ["sleep 0.6", "echo \"$WORD one\"", "echo two"] },
      { name: "quick fail", env: {}, commands: ["echo before", "exit 3", "echo never"] },
      { name: "hang", env: {}, commands: ["echo hanging", "sleep 30"] },
    ], { dir: scratch(), timeoutMs: 1_500, heartbeatMs: 250, log: (line) => lines.push(line), summary: (text) => { summary = text; } });
    expect(failed.sort()).toEqual(["hang", "quick fail"]);
    const groups = lines.filter((line) => line.startsWith("::group::"));
    expect(groups[0]).toMatch(/^::group::quick fail: FAILED \(exit 3\) after 0m0\ds$/);
    expect(groups[1]).toMatch(/^::group::slow pass: passed after 0m0\ds$/);
    expect(groups[2]).toMatch(/^::group::hang: FAILED \(SIGKILL\) after 0m0[12]s$/);
    expect(lines[lines.indexOf(groups[1]) + 1]).toBe("late one\ntwo");
    expect(lines[lines.indexOf(groups[0]) + 1]).toBe("before");
    expect(lines).toContain("::error title=hang::still running after 0m02s, so it was stopped");
    expect(lines.some((line) => /still running .*hang/.test(line))).toBe(true);
    expect(summary).toContain("| quick fail | FAILED (exit 3) |");
    expect(summary).toContain("| slow pass | passed |");
  });

  it("starts a lane in a network namespace of its own, with its own home, temporary and runtime folders", () => {
    const lane = { name: "a", env: { WORD: "x" }, commands: ["echo one", "echo two"] };
    expect(laneCommand(lane, { isolate: false, dir: "/l/1" })).toEqual({ file: "bash", args: ["-eo", "pipefail", "-c", "echo one\necho two"], env: { WORD: "x" } });
    expect(laneCommand(lane, { isolate: true, dir: "/l/1" })).toEqual({
      file: "unshare", args: [...ISOLATE.slice(1), "echo one\necho two"],
      env: { WORD: "x", HOME: "/l/1/home", TMPDIR: "/l/1/tmp", XDG_RUNTIME_DIR: "/l/1/run" },
    });
  });

  const refusal = process.platform === "linux" ? isolationRefusal() : "not Linux";
  it.skipIf(refusal !== null)("keeps an isolated lane off the machine's ports, in its own folders, with no capabilities", async () => {
    const outside = createServer();
    await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
    const { port } = outside.address() as AddressInfo;
    const lines: string[] = [];
    try {
      const failed = await runLanes([{ name: "isolated", env: {}, commands: [
        `node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(3)).on('error', () => process.exit(0))"`,
        `node -e "require('net').createServer().listen(${port}, '127.0.0.1', () => process.exit(0))"`,
        `test "$HOME" != "${process.env.HOME}"`,
        `test "$(node -p "require('os').tmpdir()")" = "$TMPDIR"`,
        "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status",
      ] }], { dir: scratch(), timeoutMs: 30_000, isolate: true, log: (line) => lines.push(line) });
      expect(failed, lines.join("\n")).toEqual([]);
    } finally {
      outside.close();
    }
  });
});
