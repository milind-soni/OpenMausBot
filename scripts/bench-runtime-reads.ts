// Synthetic assignment rows only, in a temporary directory. Measures what one finished turn reads from runtime.db.
import { mkdtempSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createCoordinator, type CoordinatorHost } from "../server/coordinator.ts";
import { openRuntimeStore } from "../server/runtime/store.ts";
import type { Assignment } from "../server/runtime/types.ts";

const BOTS = 34;
const sizes = process.argv.slice(2).map(Number).filter(n => n > 0);
const brief = "Synthetic request for measurement. ".repeat(12);
const result = "Synthetic reply for measurement. ".repeat(20);
const host: CoordinatorHost = {
  validate: () => undefined, busy: () => false, run: async () => ({ ok: true, text: "" }), report() {}, changed() {}, park() {},
  names: () => ({ requester: "person", assignee: "bot", person: "person" }), levelOf: () => ({ level: "ask" }), chiefOf: () => false,
};
const median = (run: () => unknown, times = 7): number => {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) { const at = performance.now(); run(); samples.push(performance.now() - at); }
  return Number(samples.sort((a, b) => a - b)[Math.floor(times / 2)]!.toFixed(3));
};

console.log(JSON.stringify({ benchmark: "runtime-reads", node: process.version, platform: platform(), arch: arch(), bots: BOTS,
  scope: "Real runtime.db and coordinator, synthetic finished roots spread over 34 standing threads. Not model throughput." }));
for (const rows of sizes.length ? sizes : [1_809, 5_000, 20_000, 50_000]) {
  const directory = mkdtempSync(join(tmpdir(), "omb-runtime-reads-"));
  try {
    const store = openRuntimeStore(join(directory, "runtime.db"));
    const now = Date.now();
    store.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const bot = i % BOTS, at = now - (rows - i) * 1_000;
        const a: Assignment = {
          id: `root-${i}`, rootId: `root-${i}`, depth: 0, origin: { kind: "person", source: "chat", ref: `thread-${bot}`, quote: brief.slice(0, 80) },
          requester: { kind: "person" }, assignee: { botId: `bot-${bot}`, destination: { kind: "standing_thread", threadId: `thread-${bot}` } },
          mode: "work", reply: "none", brief, status: "completed", outcome: "done", level: "ask", levelSource: "own", executions: 1, restarts: 0,
          createdAt: at, startedAt: at, lastActivityAt: at + 500, finishedAt: at + 500, result, reportedAt: at + 500, rework: false, version: 1,
        };
        store.insert(a, { kind: "enqueued", at });
      }
    });
    store.close();
    const coordinator = createCoordinator({ dataDir: directory, host, log: () => {} });
    const threadId = "thread-0";
    const generations = new Set([`root-${Math.floor((rows - 1) / BOTS) * BOTS}`]);
    coordinator.active();
    const fullReadMs = median(() => coordinator.all().filter(node => !node.parentId && node.threadId === threadId && generations.has(node.id))
      .sort((a, b) => a.createdAt - b.createdAt).at(-1));
    const newestRootMs = median(() => coordinator.newestRoot(threadId, generations), 201);
    const found = coordinator.newestRoot(threadId, generations)?.id === [...generations][0];
    const openInThreadMs = median(() => coordinator.inThread(threadId, { open: true }), 201);
    const sinceInThreadMs = median(() => coordinator.inThread(threadId, { since: now - 60_000 }), 201);
    const activeMs = median(() => coordinator.active(), 201);
    const at = performance.now();
    for (let bot = 0; bot < BOTS; bot++) coordinator.newestRoot(`thread-${bot}`, [`root-${rows - 1 - bot}`]);
    const settle34Ms = Number((performance.now() - at).toFixed(3));
    console.log(JSON.stringify({ rows, found, fullReadMs, fullRead34Ms: Math.round(fullReadMs * BOTS), newestRootMs, settle34Ms, openInThreadMs, sinceInThreadMs, activeMs }));
    coordinator.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
