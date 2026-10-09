import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Rebuilds scripts/testing/vitest-shard-weights.json, the per-file seconds
// scripts/testing/duration-sequencer.ts balances the CI shards with:
//
//   node scripts/testing/update-shard-weights.mjs --run <ci.yml run id> [--run <id> ...]
//   node scripts/testing/update-shard-weights.mjs <vitest log or --reporter=json file> ...
//
// --run reads a finished run's Windows vitest logs through `gh`: Windows is
// the slowest platform, so its seconds decide the split. A file's weight is
// its median across the inputs in whole seconds, at least one. Every file over
// five seconds is kept, and every e2e file, so that only a genuinely new e2e
// file falls back to the sequencer's e2e default. Deleted files are dropped.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUTPUT = "scripts/testing/vitest-shard-weights.json";
const HEAVY_SECONDS = 5;
const E2E = /\.e2e\.test\.[cm]?[jt]s$/;
// The default reporter's line per file: "✓ server/a.test.ts (12 tests) 345ms".
// A fully skipped file prints no time. `gh` prints escapes as a literal "^[".
const FILE_LINE = /\s[✓×❯↓] ((?:[\w.@-]+\/)+[\w.@-]+\.test\.[cm]?[jt]s)(?: \([^)]*\))?(?: (\d+)ms)?\s*$/;
// oxlint-disable-next-line no-control-regex -- strips colour codes from a CI log
const COLOUR = /(?:\u001b|\^\[)\[[\d;]*m/g;

export function parseVitestLog(text) {
  const seconds = new Map();
  for (const line of text.split("\n")) {
    const match = FILE_LINE.exec(line.replace(COLOUR, ""));
    if (match) seconds.set(match[1], Number(match[2] ?? 0) / 1000);
  }
  return seconds;
}

export function parseVitestJson(text, root = ROOT) {
  const seconds = new Map();
  for (const file of JSON.parse(text).testResults ?? []) {
    seconds.set(relative(root, file.name).split("\\").join("/"), (file.endTime - file.startTime) / 1000);
  }
  return seconds;
}

export function buildWeights(samples, exists) {
  const seen = new Map();
  for (const sample of samples) {
    for (const [file, seconds] of sample) seen.set(file, [...(seen.get(file) ?? []), seconds]);
  }
  const weights = {};
  for (const file of [...seen.keys()].sort()) {
    const values = seen.get(file).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    if ((median >= HEAVY_SECONDS || E2E.test(file)) && exists(file)) weights[file] = Math.max(1, Math.round(median));
  }
  return weights;
}

// One sample per run: its shards together cover every file once.
function windowsRun(id) {
  const gh = (...args) => execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const shards = JSON.parse(gh("run", "view", id, "--json", "jobs")).jobs
    .filter((job) => /^vitest \(windows-latest, shard \d+\/\d+\)$/.test(job.name));
  if (shards.length === 0) throw new Error(`run ${id} has no Windows vitest jobs`);
  return new Map(shards.flatMap((job) => [...parseVitestLog(gh("run", "view", id, "--log", "--job", String(job.databaseId)))]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const samples = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") samples.push(windowsRun(args[++i]));
    else samples.push((args[i].endsWith(".json") ? parseVitestJson : parseVitestLog)(readFileSync(args[i], "utf8")));
  }
  if (samples.length === 0) {
    console.error("usage: update-shard-weights.mjs --run <ci run id> ... | <vitest log or json report> ...");
    process.exit(2);
  }
  const weights = buildWeights(samples, (file) => existsSync(resolve(ROOT, file)));
  writeFileSync(resolve(ROOT, OUTPUT), `${JSON.stringify(weights, null, 2)}\n`);
  console.log(`${OUTPUT}: ${Object.keys(weights).length} files from ${samples.length} samples`);
}
