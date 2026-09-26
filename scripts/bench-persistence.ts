// Synthetic local persistence only. Never import config before isolating data.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
const bus = new EventBus();
const worker = process.argv.includes("--worker");
const percentile = (values: number[], p: number) => Number([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(2));
try {
  const text = "Synthetic history for persistence measurement. ".repeat(24);
  const now = Date.now();
  for (let thread = 0; thread < 50; thread++) {
    const messages = Array.from({ length: 1000 }, (_, i) => ({ id: `seed-${i}`, at: now + i, role: "user" as const, kind: "text" as const, text }));
    db.importThread(`thread-${thread}`, messages, "seed-999");
  }
  if (worker) await db.searchMessagesAsync("warm worker");
  console.log(JSON.stringify({ benchmark: "runtime-persistence", worker, node: process.version, platform: platform(), arch: arch(), rows: 50_000,
    scope: "Real SQLite and event bus, synthetic messages/events. Not model throughput or full HTTP capacity." }));
  for (const search of [false, true]) for (const concurrency of [1, 10, 50]) {
    const writes: number[] = [], searches: number[] = [], logs: number[] = [];
    const lag = monitorEventLoopDelay({ resolution: 2 });
    lag.enable();
    await delay(20);
    const start = performance.now();
    for (let batch = 0; batch < 20; batch++) {
      for (let session = 0; session < concurrency; session++) {
        const threadId = `thread-${session}`, id = `${search}-${concurrency}-${batch}-${session}`;
        let at = performance.now();
        db.appendMessage(threadId, { id, at: now + 2000 + batch, role: "bot", kind: "text", text });
        writes.push(performance.now() - at);
        at = performance.now();
        for (let delta = 0; delta < 10; delta++) bus.publish({ eventId: `${id}-${delta}`, provider: "claude", providerInstanceId: "fixture", threadId,
          createdAt: new Date(now).toISOString(), type: "content.delta", streamKind: "assistant_text", delta: "synthetic", turnId: id, itemId: id });
        logs.push(performance.now() - at);
      }
      if (search && batch % 4 === 0) {
        const at = performance.now();
        if (worker) await db.searchMessagesAsync("absent-synthetic-query");
        else db.searchMessages("absent-synthetic-query");
        searches.push(performance.now() - at);
      }
      await yieldLoop();
    }
    const durationMs = performance.now() - start;
    await delay(10);
    lag.disable();
    console.log(JSON.stringify({ concurrency, search, writes: writes.length, durationMs: Math.round(durationMs),
      writeP95Ms: percentile(writes, .95), writeMaxMs: percentile(writes, 1), tenEventsP95Ms: percentile(logs, .95), tenEventsMaxMs: percentile(logs, 1), searchP95Ms: searches.length ? percentile(searches, .95) : null,
      eventLoopP99Ms: Number((lag.percentile(99) / 1e6).toFixed(2)), eventLoopMaxMs: Number((lag.max / 1e6).toFixed(2)) }));
  }
} finally {
  await db.closeMessageSearch();
  db.closeMessageDb();
  if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = previousDataDir;
  rmSync(directory, { recursive: true, force: true });
}
