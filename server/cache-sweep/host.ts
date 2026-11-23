// The server's one cache sweeper: the only place that reads HOME, the environment and the running server's compile cache
// folder for it (sweeper.ts and units.ts take every path as an argument).
import { getCompileCacheDir } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { toolCachesOn } from "../bot-box/tool-caches.ts";
import { audienceHomes } from "../engine-homes/layout.ts";
import type { StorageReport } from "../perf/disk-usage.ts";
import { botEngineSessions } from "../procs.ts";
import { createCacheSweeper, mountKeepsAtime, volumeOf, type CacheSweeper } from "./sweeper.ts";

/** The storage report with the cache cap's counters, once the sweeper has read them. */
export function withCacheCounters(report: StorageReport | null, sweeper: Pick<CacheSweeper, "counters">): StorageReport | null {
  const caches = sweeper.counters();
  return report && caches ? { ...report, caches } : report;
}

/** An engine process of a bot's lives (a turn, or one kept warm between turns): the sweeper waits. */
export const botEnginesLive = (): boolean => botEngineSessions().live.size > 0;

export function createCacheSweepHost(dataDir: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): CacheSweeper {
  return createCacheSweeper({
    dataDir, home, env, tools: toolCachesOn(env),
    audienceHomes: () => audienceHomes(dataDir),
    keep: () => { const own = getCompileCacheDir?.(); return own ? [resolve(own)] : []; },
    atimeKept: (root) => mountKeepsAtime(root),
    volume: volumeOf,
  });
}
