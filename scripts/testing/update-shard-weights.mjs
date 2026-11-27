import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Rebuilds scripts/testing/vitest-shard-weights.json, the per-file seconds
// scripts/testing/duration-sequencer.ts balances the CI shards with, one table
// per platform:
//
//   node scripts/testing/update-shard-weights.mjs --run <ci.yml run id> [--run <id> ...]
//   node scripts/testing/update-shard-weights.mjs [--platform linux|win32|darwin] <vitest log or --reporter=json file> ...
//
// --run reads a finished run's vitest logs through `gh`, each OS's shards for
// that OS's table. A file's weight is its median across the inputs in whole
// seconds, at least one. Every file over five seconds is kept, and every e2e
// file, so that only a genuinely new e2e file falls back to the sequencer's e2e
// default. Deleted files are dropped, and a platform no input sampled keeps
// its table.
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

export const RUNNER_PLATFORMS = { "ubuntu-latest": "linux", "windows-latest": "win32", "macos-latest": "darwin" };
const VITEST_JOB = /^vitest \((ubuntu-latest|windows-latest|macos-latest), shard \d+\/\d+\)$/;

/** A run's vitest jobs by platform: one sample per platform, its shards together covering that platform's files once. */
function runSamples(id) {
  const gh = (...args) => execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const samples = new Map();
  for (const job of JSON.parse(gh("run", "view", id, "--json", "jobs")).jobs) {
    const runner = VITEST_JOB.exec(job.name)?.[1];
    if (!runner) continue;
    const platform = RUNNER_PLATFORMS[runner];
    const sample = samples.get(platform) ?? new Map();
    for (const [file, seconds] of parseVitestLog(gh("run", "view", id, "--log", "--job", String(job.databaseId)))) sample.set(file, seconds);
    samples.set(platform, sample);
  }
  if (samples.size === 0) throw new Error(`run ${id} has no vitest jobs`);
  return samples;
}

/** The weights file with each sampled platform's table rebuilt and the others kept. */
export function mergePlatformWeights(existing, samplesByPlatform, exists) {
  const merged = Object.fromEntries(Object.entries(existing).filter(([platform]) => Object.values(RUNNER_PLATFORMS).includes(platform)));
  for (const [platform, samples] of Object.entries(samplesByPlatform)) {
    if (samples.length > 0) merged[platform] = buildWeights(samples, exists);
  }
  return Object.fromEntries(Object.keys(merged).sort().map((platform) => [platform, merged[platform]]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = () => {
    console.error("usage: update-shard-weights.mjs --run <ci run id> ... | [--platform linux|win32|darwin] <vitest log or json report> ...");
    process.exit(2);
  };
  const args = process.argv.slice(2);
  const samples = { linux: [], win32: [], darwin: [] };
  let platform = Object.hasOwn(samples, process.platform) ? process.platform : "linux";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") for (const [sampled, sample] of runSamples(args[++i])) samples[sampled].push(sample);
    else if (args[i] === "--platform") platform = Object.hasOwn(samples, args[++i]) ? args[i] : usage();
    else samples[platform].push((args[i].endsWith(".json") ? parseVitestJson : parseVitestLog)(readFileSync(args[i], "utf8")));
  }
  if (Object.values(samples).every((list) => list.length === 0)) usage();
  const existing = existsSync(resolve(ROOT, OUTPUT)) ? JSON.parse(readFileSync(resolve(ROOT, OUTPUT), "utf8")) : {};
  const weights = mergePlatformWeights(existing, samples, (file) => existsSync(resolve(ROOT, file)));
  writeFileSync(resolve(ROOT, OUTPUT), `${JSON.stringify(weights, null, 2)}\n`);
  for (const [name, list] of Object.entries(samples)) {
    if (list.length > 0) console.log(`${OUTPUT}: ${name} ${Object.keys(weights[name]).length} files from ${list.length} samples`);
  }
}
