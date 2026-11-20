import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { launchVerificationServer } from "./control-omb.ts";

const count = Number(process.argv[2] ?? 40_000);
assert(Number.isSafeInteger(count) && count > 0);
const fixture = await launchVerificationServer();
try {
  const directory = join(fixture.info.dataDir, "usage");
  await mkdir(directory, { recursive: true });
  const rows = Array.from({ length: count }, (_, index) => JSON.stringify({
    at: "2025-09-02T00:00:00.000Z",
    botId: `fixture-${index % 10}`,
    botName: `Synthetic bot ${index % 10}`,
    threadId: "fixture-thread",
    instanceId: "fixture-engine",
    driverKind: "claudeAgent",
    model: `synthetic-model-${index % 3}`,
    input: 1000,
    output: 100,
    costUsd: 0.001,
    trigger: { kind: "owner" },
  })).join("\n") + "\n";
  const file = join(directory, "2025-09.jsonl");
  await writeFile(file, rows);
  const groups = ["groupBy=bot&splitBy=model", "groupBy=model"];
  async function readPair(turns: number) {
    const started = performance.now();
    await Promise.all(groups.map(async (group) => {
      const response = await fetch(`${fixture.info.url}/api/usage?from=2025-09-01&to=2025-09-30&${group}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).total.turns, turns);
    }));
    return performance.now() - started;
  }
  await fetch(`${fixture.info.url}/api/usage?from=2025-08-01&to=2025-08-31`).then((response) => response.text());
  await setTimeout(2_100);
  const firstPairMs = await readPair(count);
  const samples = [];
  for (let attempt = 0; attempt < 9; attempt++) samples.push(await readPair(count));
  const stableRssKiB = rssKiB();
  await writeFile(file, rows.slice(0, rows.indexOf("\n") + 1), { flag: "a" });
  const afterAppendMs = await readPair(count + 1);
  console.log(JSON.stringify({
    count, bytes: Buffer.byteLength(rows), firstPairMs,
    warmPairMedianMs: samples.sort((first, second) => first - second)[4],
    afterAppendMs, stableRssKiB, afterAppendRssKiB: rssKiB(),
  }, null, 2));

  function rssKiB() {
    if (process.platform === "win32") return null;
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(fixture.info.pid)], { encoding: "utf8" }).trim());
  }
} finally {
  await fixture.close();
}
