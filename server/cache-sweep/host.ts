// The server's one cache sweeper: the only place that reads HOME, the environment and the running server's compile cache
// folder for it (sweeper.ts and units.ts take every path as an argument).
import { getCompileCacheDir } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { toolCachesOn } from "../bot-box/tool-caches.ts";
import { audienceHomes } from "../engine-homes/layout.ts";
import { createCacheSweeper, mountKeepsAtime, volumeOf, type CacheSweeper } from "./sweeper.ts";

export function createCacheSweepHost(dataDir: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): CacheSweeper {
  return createCacheSweeper({
    dataDir, home, env, tools: toolCachesOn(env),
    audienceHomes: () => audienceHomes(dataDir),
    keep: () => { const own = getCompileCacheDir?.(); return own ? [resolve(own)] : []; },
    atimeKept: (root) => mountKeepsAtime(root),
    volume: volumeOf,
  });
}
