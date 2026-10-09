import { readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Vitest's own --shard cuts the file list into equal-count slices, and this
// suite runs one file at a time, so a shard takes the sum of its files. The
// two slowest e2e files take about four and five minutes on Windows; they
// landed in one slice with the fourth slowest, and that slice ran about eight
// minutes longer than any other. This balances the slices by recorded seconds
// instead: slowest file first, each to the shard with the least time so far.
// Every file still runs exactly once, and `--shard=n/4` run locally picks the
// same files as CI shard n.
// scripts/testing/update-shard-weights.mjs refreshes the seconds from CI.
export const SHARD_WEIGHTS_FILE = "scripts/testing/vitest-shard-weights.json";

// A file absent from the weights is light (the file lists every file over
// five seconds and every e2e file); a second covers its setup and import.
const UNLISTED_SECONDS = 1;
const E2E = /\.e2e\.test\.[cm]?[jt]s$/;

export type ShardWeights = Readonly<Record<string, number>>;

export function loadShardWeights(root: string): ShardWeights {
  return JSON.parse(readFileSync(path.join(root, SHARD_WEIGHTS_FILE), "utf8")) as ShardWeights;
}

// Weights are keyed by POSIX path from the repo root. On Windows vitest hands
// over forward-slash paths whose drive letter case can differ from the root's;
// path.win32.relative compares case-insensitively. A file outside the root
// gets no key and is weighed as unlisted.
export function weightKey(root: string, moduleId: string, paths: typeof path = path): string | null {
  const relative = paths.relative(root, moduleId);
  if (!relative || paths.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${paths.sep}`)) return null;
  return relative.split(paths.sep).join("/");
}

// A new e2e file has no recorded time yet; it is charged the median e2e file
// rather than a second, so one heavy newcomer cannot quietly skew a shard.
function unlistedE2eSeconds(weights: ShardWeights): number {
  const e2e = Object.entries(weights).filter(([key]) => E2E.test(key)).map(([, seconds]) => seconds).sort((a, b) => a - b);
  if (e2e.length === 0) return UNLISTED_SECONDS;
  const middle = Math.floor(e2e.length / 2);
  return e2e.length % 2 ? e2e[middle] : (e2e[middle - 1] + e2e[middle]) / 2;
}

// Longest-processing-time first: sort by seconds (ties by key, so the result
// never depends on the order vitest found the files), then give each file to
// the shard with the least time so far, the lowest index winning a tie.
export function planShards(keys: readonly string[], weights: ShardWeights, count: number) {
  const e2eSeconds = unlistedE2eSeconds(weights);
  const seconds = keys.map((key) => Object.hasOwn(weights, key) ? weights[key] : E2E.test(key) ? e2eSeconds : UNLISTED_SECONDS);
  const order = keys.map((_, i) => i)
    .sort((a, b) => seconds[b] - seconds[a] || (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0));
  const loads = Array.from({ length: count }, () => 0);
  const shardOf: number[] = [];
  for (const i of order) {
    let target = 0;
    for (let shard = 1; shard < count; shard++) if (loads[shard] < loads[target]) target = shard;
    loads[target] += seconds[i];
    shardOf[i] = target;
  }
  return { shardOf, loads };
}

export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const weights = loadShardWeights(root);
    const keys = files.map((spec) => weightKey(root, spec.moduleId) ?? spec.moduleId);
    const { shardOf, loads } = planShards(keys, weights, shard.count);
    const mine = files.filter((_, i) => shardOf[i] === shard.index - 1);
    // One line per run, so a CI log shows the weights were applied. If most
    // weighted files go unmatched (a path-key mismatch on some platform), the
    // shards fall back toward equal file counts: annotate, but run the tests.
    const listed = Object.keys(weights).length;
    const found = keys.filter((key) => Object.hasOwn(weights, key)).length;
    this.ctx.logger.log(
      `duration-sequencer: shard ${shard.index}/${shard.count} runs ${mine.length} of ${files.length} files, ` +
      `~${Math.round(loads[shard.index - 1])}s recorded; ${found} of ${listed} weighted files found`,
    );
    if (process.env.GITHUB_ACTIONS === "true" && found < listed * 0.9) {
      this.ctx.logger.log(
        `::warning title=duration-sequencer::Only ${found} of ${listed} weighted test files were found, so shards fall ` +
        `back to about equal file counts. Check ${SHARD_WEIGHTS_FILE} against the test file paths.`,
      );
    }
    return mine;
  }
}
