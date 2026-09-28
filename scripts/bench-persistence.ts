// Synthetic local persistence only. Never import config before isolating data.
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldLoop, setTimeout as delay } from "node:timers/promises";

const directory = mkdtempSync(join(tmpdir(), "omb-persistence-bench-"));
const previousDataDir = process.env.OMB_DATA_DIR;
process.env.OMB_DATA_DIR = directory;
mkdirSync(join(directory, "events"));
const db = await import("../server/message-db.ts");
const { EventBus } = await import("../server/harness/bus.ts");
const { appendNative } = await import("../server/drivers/native.ts");
mkdirSync(join(directory, "native"));
let appendMaxMs = 0;
const bus = new EventBus((...args: Parameters<typeof appendFileSync>) => {
  const at = performance.now();
  appendFileSync(...args);
  appendMaxMs = Math.max(appendMaxMs, performance.now() - at);
});
const worker = process.argv.includes("--worker");
const paced = process.argv.includes("--paced");
const checkpointSeed = process.argv.includes("--checkpoint-seed");
const percentile = (values: number[], p: number) => Number([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(2));
try {
  const text = "Synthetic history for persistence measurement. ".repeat(24);
  const now = Date.now();
  for (let thread = 0; thread < 50; thread++) {
    const messages = Array.from({ length: 1000 }, (_, i) => ({ id: `seed-${i}`, at: now + i, role: "user" as const, kind: "text" as const, text }));
    db.importThread(`thread-${thread}`, messages, "seed-999");
  }
  if (checkpointSeed) {
    // Finish fixture construction I/O before timing. This is not a change to
    // production checkpoint policy; retain uncheckpointed runs for comparison.
    const checkpoint = new DatabaseSync(join(directory, "messages.db"));
    try { checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
    finally { checkpoint.close(); }
    await delay(1000);
  }
  if (worker) await db.searchMessagesAsync("warm worker");
  console.log(JSON.stringify({ benchmark: "runtime-persistence", worker, paced, checkpointSeed, node: process.version, platform: platform(), arch: arch(), rows: 50_000,
    scope: "Real SQLite and event bus, synthetic messages/events. Not model throughput or full HTTP capacity." }));
  for (const search of [false, true]) for (const concurrency of [1, 10, 50]) {
    const writes: number[] = [], searches: number[] = [], logs: number[] = [];
    appendMaxMs = 0;
    const lag = monitorEventLoopDelay({ resolution: 2 });
    // Arm before synchronous work and let its final delayed sample fire.
    // Report maxima only: idle setup/drain samples would dilute percentiles.
    lag.enable();
    await delay(20);
    const start = performance.now();
    for (let batch = 0; batch < (paced ? 100 : 20); batch++) {
      for (let session = 0; session < concurrency; session++) {
        const threadId = `thread-${session}`, id = `${search}-${concurrency}-${batch}-${session}`;
        let at = performance.now();
        if (!paced || batch % 50 === 0) {
          db.appendMessage(threadId, { id, at: now + 2000 + batch, role: "bot", kind: "text", text });
          writes.push(performance.now() - at);
        }
        at = performance.now();
        for (let delta = 0; delta < (paced ? 1 : 10); delta++) {
          const event = { eventId: `${id}-${delta}`, provider: "claude", providerInstanceId: "fixture", threadId,
            createdAt: new Date(now).toISOString(), type: "content.delta" as const, streamKind: "assistant_text" as const, delta: "synthetic", turnId: id, itemId: id };
          bus.publish(event);
          if (paced) appendNative(threadId, { dir: "in", source: "fixture", msg: event });
        }
        logs.push(performance.now() - at);
      }
      if (search && batch % (paced ? 20 : 4) === 0) {
        const at = performance.now();
        if (worker) await db.searchMessagesAsync("absent-synthetic-query");
        else db.searchMessages("absent-synthetic-query");
        searches.push(performance.now() - at);
      }
      if (paced) await delay(20);
      else await yieldLoop();
    }
    const durationMs = performance.now() - start;
    await delay(10);
    lag.disable();
    console.log(JSON.stringify({ concurrency, search, writes: writes.length, durationMs: Math.round(durationMs),
      writeP95Ms: percentile(writes, .95), writeMaxMs: percentile(writes, 1), logBatchP95Ms: percentile(logs, .95), logBatchMaxMs: percentile(logs, 1), canonicalAppendMaxMs: Number(appendMaxMs.toFixed(2)), searchP95Ms: searches.length ? percentile(searches, .95) : null,
      eventLoopMaxMs: Number((lag.max / 1e6).toFixed(2)) }));
  }
} finally {
  await db.closeMessageSearch();
  db.closeMessageDb();
  if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = previousDataDir;
  rmSync(directory, { recursive: true, force: true });
}
