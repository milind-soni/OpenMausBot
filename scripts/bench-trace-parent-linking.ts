import { deepStrictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { linkTurns, type TurnNode } from "../server/usage-trace/build.ts";
import type { UsageRow } from "../server/usage-ledger.ts";

const baselinePath = process.argv[2];
if (!baselinePath) throw new Error("Pass the baseline build.ts module, placed beside the current file for its relative imports.");
const baseline = (await import(pathToFileURL(resolve(baselinePath)).href)).linkTurns as typeof linkTurns;
const AT = Date.UTC(2026, 9, 22, 9);
const noBot = () => null;

function row(index: number, parent?: number): UsageRow {
  return {
    at: new Date(AT + index + 1).toISOString(), threadId: `chat-${index}`, turnId: "turn", botId: "bot", botName: "Bot",
    instanceId: "fixture", driverKind: "claude", model: "fixture", input: 100, cachedInput: 50, output: 20,
    costUsd: 0.1, trigger: { kind: "owner" }, startedAt: new Date(AT + index).toISOString(),
    ...(parent === undefined ? {} : { parent: { threadId: `chat-${parent}`, turnId: "turn" } }),
  };
}

function completeOutput(roots: TurnNode[]) {
  const output: object[] = [];
  const pending = [...roots].reverse();
  while (pending.length) {
    const { children, ...node } = pending.pop()!;
    output.push({ ...node, children: children.map((child) => child.key) });
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!);
  }
  return { roots: roots.map((root) => root.key), nodes: output };
}
const checksum = (roots: TurnNode[]) => createHash("sha256").update(JSON.stringify(completeOutput(roots))).digest("hex");

let seed = 0x873be21;
const random = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
for (let fixture = 0; fixture < 300; fixture++) {
  const count = random() % 80;
  const rows = Array.from({ length: count }, (_, index) => row(index, random() % 4 ? random() % (count + 3) : undefined));
  for (let index = rows.length - 1; index > 0; index--) {
    const other = random() % (index + 1);
    [rows[index], rows[other]] = [rows[other]!, rows[index]!];
  }
  deepStrictEqual(completeOutput(linkTurns(rows, [], noBot)), completeOutput(baseline(rows, [], noBot)));
}

const count = 3_000;
const scenarios = [
  { name: "resumed-chain", rows: Array.from({ length: count }, (_, index) => row(index, index ? index - 1 : undefined)) },
  { name: "flat-independent-turns", rows: Array.from({ length: count }, (_, index) => row(index)) },
  { name: "shallow-delegation", rows: Array.from({ length: count }, (_, index) => row(index, index ? 0 : undefined)) },
];
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
for (const scenario of scenarios) {
  const expected = checksum(baseline(scenario.rows, [], noBot));
  deepStrictEqual(checksum(linkTurns(scenario.rows, [], noBot)), expected);
  for (let warmup = 0; warmup < 2; warmup++) {
    baseline(scenario.rows, [], noBot);
    linkTurns(scenario.rows, [], noBot);
  }
  const samples: Record<"before" | "after", number[]> = { before: [], after: [] };
  for (let pair = 0; pair < 7; pair++) {
    const order = pair % 2 ? ["after", "before"] as const : ["before", "after"] as const;
    for (const version of order) {
      const begin = performance.now();
      const result = (version === "before" ? baseline : linkTurns)(scenario.rows, [], noBot);
      samples[version].push(performance.now() - begin);
      deepStrictEqual(checksum(result), expected);
    }
  }
  console.log(JSON.stringify({ scenario: scenario.name, rows: count, pairs: 7, warmups: 2,
    beforeMs: median(samples.before), afterMs: median(samples.after), outputSha256: expected, samples }));
}
