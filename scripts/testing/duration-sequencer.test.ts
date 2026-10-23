// CI runs the suite in shards per platform, one file at a time, so the
// slowest shard sets how long every PR waits. These pin that the configured
// sequencer splits by recorded seconds, still runs every file exactly once,
// and that its weights stay keyed to files that exist.
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseSequencer, type TestSequencerConstructor, type TestSpecification, type Vitest } from "vitest/node";
import viteConfig from "../../vite.config.ts";
import { VITEST_SHARDS } from "../ci-scope.mjs";
import { DurationSequencer, SHARD_WEIGHTS_FILE, loadPlatformShardWeights, loadShardWeights, planShards, weightKey } from "./duration-sequencer.ts";
import { isPortableE2e } from "./host-e2e.ts";
import { buildWeights, mergePlatformWeights, parseVitestLog, RUNNER_PLATFORMS } from "./update-shard-weights.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WEIGHTS = loadShardWeights(ROOT);
const FILES = globSync(viteConfig.test?.include ?? [], { cwd: ROOT, exclude: (file) => /(^|[\\/])node_modules$/.test(file) })
  .map((file) => file.split(path.sep).join("/"))
  .sort();
const specs = (files: readonly string[]) => files.map((file) => ({ moduleId: path.join(ROOT, file) }) as TestSpecification);
const keyOf = (spec: TestSpecification) => weightKey(ROOT, spec.moduleId);

function context(index: number, count: number, log: (line: string) => void = () => {}) {
  return { config: { root: ROOT, shard: { index, count } }, logger: { log } } as unknown as Vitest;
}

/** Each CI platform's files, weights and shard count, as ci-scope.mjs and ci.yml run them. */
const CI_PLATFORMS = Object.entries(VITEST_SHARDS).map(([os, count]) => {
  const platform = RUNNER_PLATFORMS[os as keyof typeof RUNNER_PLATFORMS] as NodeJS.Platform;
  return { os, platform, count, files: os === "ubuntu-latest" ? FILES : FILES.filter((file) => !isPortableE2e(file)) };
});

async function split(Sequencer: TestSequencerConstructor, files: readonly string[], count: number) {
  const shards: string[][] = [];
  for (let index = 1; index <= count; index++) {
    shards.push((await new Sequencer(context(index, count)).shard(specs(files))).map((spec) => keyOf(spec) ?? ""));
  }
  return shards;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vitest shard balance", () => {
  it("is the sequencer the suite runs with", () => {
    expect(viteConfig.test?.sequence?.sequencer ?? BaseSequencer).toBe(DurationSequencer);
  });

  it.each(CI_PLATFORMS)("gives no $os shard much more recorded time than the others", ({ platform, count, files }) => {
    const { loads } = planShards(files, loadShardWeights(ROOT, platform), count);
    const mean = loads.reduce((sum, load) => sum + load, 0) / loads.length;
    // equal file counts put three of the four slowest e2e files in one shard: ~1.4x the mean
    expect(Math.max(...loads) / mean, `recorded seconds per shard: ${loads.join(", ")}`).toBeLessThan(1.05);
  });

  it("runs every test file in exactly one shard for one to eight shards", async () => {
    for (let count = 1; count <= 8; count++) {
      const shards = await split(DurationSequencer, FILES, count);
      expect(shards.flat().sort(), `${count} shards`).toEqual(FILES);
    }
  });

  it("never puts two of the slowest files in one shard while a shard is free", async () => {
    const slowest = Object.entries(WEIGHTS).sort(([, a], [, b]) => b - a).map(([file]) => file);
    for (let count = 2; count <= 8; count++) {
      const shards = await split(DurationSequencer, FILES, count);
      const owners = slowest.slice(0, count).map((file) => shards.findIndex((shard) => shard.includes(file)));
      expect(new Set(owners).size, `${count} shards: ${slowest.slice(0, count).join(", ")}`).toBe(count);
    }
  });

  it("plans the same split whatever order the files arrive in", () => {
    const shuffled = [...FILES].reverse();
    const forward = planShards(FILES, WEIGHTS, 4).shardOf;
    const backward = planShards(shuffled, WEIGHTS, 4).shardOf;
    expect(shuffled.map((file) => forward[FILES.indexOf(file)])).toEqual(backward);
  });

  it("keys Windows and POSIX paths the same way", () => {
    expect(weightKey("/repo", "/repo/server/a.e2e.test.ts", path.posix)).toBe("server/a.e2e.test.ts");
    expect(weightKey("D:/a/repo", "D:/a/repo/server/a.e2e.test.ts", path.win32)).toBe("server/a.e2e.test.ts");
    expect(weightKey("D:\\a\\repo", "d:/a/repo/server/drivers/b.test.ts", path.win32)).toBe("server/drivers/b.test.ts");
    expect(weightKey("D:/a/repo", "C:/elsewhere/c.test.ts", path.win32)).toBeNull();
    expect(weightKey("/repo", "/other/c.test.ts", path.posix)).toBeNull();
  });

  it("charges a new e2e file the median e2e time and any other new file one second", () => {
    const weights = { "server/a.e2e.test.ts": 10, "server/b.e2e.test.ts": 20, "server/c.e2e.test.ts": 90, "server/d.test.ts": 50 };
    const { loads } = planShards([...Object.keys(weights), "server/new.e2e.test.ts", "server/new.test.ts"], weights, 1);
    expect(loads).toEqual([10 + 20 + 90 + 50 + 20 + 1]);
  });

  it("weighs only test files that exist, for each CI platform", () => {
    const weights = loadPlatformShardWeights(ROOT);
    expect(Object.keys(weights).sort()).toEqual(["darwin", "linux", "win32"]);
    for (const [platform, table] of Object.entries(weights)) {
      const stale = Object.keys(table ?? {}).filter((file) => !FILES.includes(file));
      expect(stale, `${platform}: remove these from ${SHARD_WEIGHTS_FILE} or rerun scripts/testing/update-shard-weights.mjs`).toEqual([]);
    }
  });

  it("weighs a platform without seconds of its own by Linux's", () => {
    expect(loadShardWeights(ROOT, "freebsd")).toEqual(loadShardWeights(ROOT, "linux"));
  });

  it("logs its split, and annotates a CI run whose weights match no files", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    // The Windows and macOS CI shards run this file with OMB_VITEST_E2E=host.
    vi.stubEnv("OMB_VITEST_E2E", "");
    const lines: string[] = [];
    await new DurationSequencer(context(2, 4, (line) => lines.push(line))).shard(specs(FILES));
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^duration-sequencer: shard 2/4 runs \\d+ of ${FILES.length} files, ~\\d+s recorded; ${Object.keys(WEIGHTS).length} of ${Object.keys(WEIGHTS).length} weighted files found$`))]);

    lines.length = 0;
    vi.stubEnv("OMB_VITEST_E2E", "host");
    const hostFiles = FILES.filter((file) => !isPortableE2e(file));
    const hostWeighted = Object.keys(WEIGHTS).filter((file) => !isPortableE2e(file)).length;
    await new DurationSequencer(context(1, 4, (line) => lines.push(line))).shard(specs(hostFiles));
    expect(lines).toEqual([expect.stringMatching(new RegExp(`; ${hostWeighted} of ${hostWeighted} weighted files found$`))]);
    vi.stubEnv("OMB_VITEST_E2E", "");

    lines.length = 0;
    const elsewhere = FILES.map((file) => ({ moduleId: path.join(ROOT, "..", "elsewhere", file) }) as TestSpecification);
    await new DurationSequencer(context(1, 4, (line) => lines.push(line))).shard(elsewhere);
    expect(lines[1]).toMatch(/^::warning title=duration-sequencer::Only 0 of \d+ weighted test files were found/);
  });
});

describe("update-shard-weights", () => {
  it("reads each file's time from a CI log, colour codes and skipped files included", () => {
    const log = [
      "vitest (windows-latest, shard 4/4)\tUNKNOWN STEP\t2026-10-05T22:52:23.1Z  ✓ server/drivers/acp/acp.test.ts (150 tests) 41750ms",
      "2026-10-06T10:06:39.1Z  ^[[32m✓^[[39m server/a.e2e.test.ts ^[[2m(^[[22m39 tests | ^[[33m1 skipped^[[39m^[[2m)^[[22m^[[33m 316800^[[2mms^[[22m^[[39m",
      "2026-10-06T10:03:21.1Z  ↓ scripts/testing/cloud-preview.e2e.test.ts (1 test | 1 skipped)",
      "2026-10-06T10:03:22.1Z    ❯ server/b.test.ts:12:3",
      "2026-10-06T10:03:23.1Z  × server/c.test.ts (3 tests | 1 failed) 9000ms",
    ].join("\n");
    expect(Object.fromEntries(parseVitestLog(log))).toEqual({
      "server/drivers/acp/acp.test.ts": 41.75,
      "server/a.e2e.test.ts": 316.8,
      "scripts/testing/cloud-preview.e2e.test.ts": 0,
      "server/c.test.ts": 9,
    });
  });

  it("rebuilds the platforms a run sampled and keeps the others", () => {
    const sample = [new Map([["server/slow.test.ts", 9]])];
    const existing = { linux: { "server/old.test.ts": 7 }, darwin: { "server/mac.test.ts": 8 }, "server/flat.test.ts": 5 };
    expect(mergePlatformWeights(existing, { linux: sample, win32: sample, darwin: [] }, () => true)).toEqual({
      darwin: { "server/mac.test.ts": 8 },
      linux: { "server/slow.test.ts": 9 },
      win32: { "server/slow.test.ts": 9 },
    });
  });

  it("keeps each slow or e2e file's median, and drops light and deleted files", () => {
    const runs = [
      new Map([["server/slow.test.ts", 9], ["server/light.test.ts", 2], ["server/skipped.e2e.test.ts", 0], ["server/gone.test.ts", 60]]),
      new Map([["server/slow.test.ts", 30], ["server/light.test.ts", 3]]),
      new Map([["server/slow.test.ts", 12.4], ["server/light.test.ts", 1]]),
    ];
    expect(buildWeights(runs, (file: string) => file !== "server/gone.test.ts")).toEqual({
      "server/skipped.e2e.test.ts": 1,
      "server/slow.test.ts": 12,
    });
  });
});
