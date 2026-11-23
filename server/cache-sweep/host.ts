// The server's one cache sweeper: the only place that reads HOME, the environment, the bot box and the running server's
// compile cache folder for it (sweeper.ts and units.ts take every path as an argument). Making it reads nothing from disk.
import { getCompileCacheDir } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { botBox } from "../bot-box/box.ts";
import { toolCachesOn } from "../bot-box/tool-caches.ts";
import { audienceHomes } from "../engine-homes/layout.ts";
import type { StorageReport } from "../perf/disk-usage.ts";
import { botEngineSessions } from "../procs.ts";
import { createCacheSweeper, volumeOf, type CacheSweeper } from "./sweeper.ts";

/** The storage report with the cache cap's counters, once the sweeper has read them. */
export function withCacheCounters(report: StorageReport | null, sweeper: Pick<CacheSweeper, "counters">): StorageReport | null {
  const caches = sweeper.counters();
  return report && caches ? { ...report, caches } : report;
}

/** An engine process of a bot's lives (a turn, or one kept warm between turns): the sweeper waits. */
export const botEnginesLive = (): boolean => botEngineSessions().live.size > 0;

export function createCacheSweepHost(dataDir: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): CacheSweeper {
  return createCacheSweeper({
    dataDir, home, env,
    // Only while the box is live do bots' tools write there (bot-box/tool-caches.ts); with it off they run unboxed.
    tools: () => toolCachesOn(env) && botBox.enabled(),
    audienceHomes: () => audienceHomes(dataDir),
    keep: () => { const own = getCompileCacheDir?.(); return own ? [resolve(own)] : []; },
    volume: volumeOf,
  });
}
