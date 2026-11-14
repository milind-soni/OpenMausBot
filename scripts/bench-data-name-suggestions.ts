import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const baselinePath = process.argv[2];
assert(baselinePath, "usage: node --experimental-strip-types scripts/bench-data-name-suggestions.ts <baseline-engine.ts placed beside server/data/engine.ts>");
const directory = mkdtempSync(join(tmpdir(), "omb-name-suggestions-bench-"));
const previousDataDir = process.env.OMB_DATA_DIR;
process.env.OMB_DATA_DIR = directory;

type Suggest = (wanted: string, names: readonly string[], max?: number) => string[];
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const hash = (value: string[]) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

try {
  const baseline: Suggest = (await import(pathToFileURL(resolve(baselinePath)).href)).closeNames;
  const current = (await import("../server/data/engine.ts")).closeNames;
  let seed = 371;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = ["a", "B", "c", "_", "İ", "😀", "é"];
  const word = () => Array.from({ length: random() % 12 }, () => alphabet[random() % alphabet.length]).join("");
  for (let i = 0; i < 500; i++) {
    const wanted = word();
    const names = Array.from({ length: 20 }, word);
    names.push(wanted, `prefix_${wanted}`, `${wanted}_suffix`, "");
    for (const limit of [0, 1, 5, 30, -1]) assert.deepEqual(current(wanted, names, limit), baseline(wanted, names, limit));
  }

  const longTarget = "revenue_for_current_reporting_month_before_adjustments";
  const cases = [
    { name: "wide-prefix", target: longTarget, names: Array.from({ length: 5_000 }, (_, i) => `${longTarget}_${String(i).padStart(6, "0")}_consolidated_by_business_region`), repeats: 1 },
    { name: "wide-substring", target: longTarget, names: Array.from({ length: 5_000 }, (_, i) => `region_${String(i).padStart(6, "0")}_${longTarget}_summary`), repeats: 1 },
    { name: "impossible-length", target: "revenue", names: Array.from({ length: 5_000 }, (_, i) => `metric_${i}_${"monthly_consolidation_".repeat(5)}`), repeats: 1 },
    { name: "ordinary-prefix", target: "revenue", names: Array.from({ length: 200 }, (_, i) => `revenue_month_${i}`), repeats: 100 },
    { name: "ordinary-fuzzy", target: "revenue_month_100", names: Array.from({ length: 200 }, (_, i) => `revenue_month_${String(i).padStart(3, "0")}`), repeats: 10 },
  ];
  console.log(JSON.stringify({ node: process.version, comparisons: 2_500, pairs: 7, scope: "Public closeNames calls; synthetic names, not database query throughput." }));
  for (const fixture of cases) {
    const expected = baseline(fixture.target, fixture.names);
    assert.deepEqual(current(fixture.target, fixture.names), expected);
    for (let warmup = 0; warmup < 3; warmup++) {
      baseline(fixture.target, fixture.names);
      current(fixture.target, fixture.names);
    }
    const times: Record<string, number[]> = { baseline: [], current: [] };
    for (let pair = 0; pair < 7; pair++) {
      const order: Array<[string, Suggest]> = pair % 2 ? [["current", current], ["baseline", baseline]] : [["baseline", baseline], ["current", current]];
      for (const [label, suggest] of order) {
        let result: string[] = [];
        const start = performance.now();
        for (let repeat = 0; repeat < fixture.repeats; repeat++) result = suggest(fixture.target, fixture.names);
        times[label].push((performance.now() - start) / fixture.repeats);
        assert.deepEqual(result, expected);
      }
    }
    console.log(JSON.stringify({ name: fixture.name, candidates: fixture.names.length, targetLength: fixture.target.length, repeats: fixture.repeats, baselineMedianMs: median(times.baseline), currentMedianMs: median(times.current), outputHash: hash(expected), times }));
  }
} finally {
  if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = previousDataDir;
  rmSync(directory, { recursive: true, force: true });
}
