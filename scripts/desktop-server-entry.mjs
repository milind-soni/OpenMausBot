// The packaged desktop forks this file instead of the index.js beside it
// (electron/server-child-launch.mjs). It turns on Node's on-disk compile
// cache for this one process, so a relaunch reuses the compiled 5 MB bundle
// instead of parsing and compiling all of it again, then runs the server
// unchanged. Copied verbatim to dist-server/desktop-entry.mjs by
// scripts/bundle-server.mjs: bundling it would inline index.js and defeat
// the point.
import module from "node:module";
import { lstatSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const cacheRoot = process.env.OMB_SERVER_COMPILE_CACHE;
// Engine CLIs, MCP servers and terminals the server spawns must not inherit
// it. enableCompileCache does not set NODE_COMPILE_CACHE, so they inherit
// nothing from this.
delete process.env.OMB_SERVER_COMPILE_CACHE;

let enabled = false;
if (cacheRoot) {
  try {
    enabled = module.enableCompileCache(cacheRoot).status === module.constants.compileCacheStatus.ENABLED;
  } catch {
    // An unusable cache costs only the compile it would have saved.
  }
}

await import("./index.js");

// Node writes new entries when the process exits normally; a crash or a
// Windows kill skips that, so write them once the server is up. Then drop
// caches of other Node versions (one is left behind by each Electron
// upgrade) that no launch has used for a day. Only `v<node version>-…`
// directories inside the cache root Node reports are ever removed.
if (enabled) {
  setTimeout(() => {
    try {
      module.flushCompileCache();
      const current = module.getCompileCacheDir();
      if (dirname(current) !== resolve(cacheRoot)) return;
      const now = new Date();
      utimesSync(current, now, now);
      for (const name of readdirSync(cacheRoot)) {
        if (name === basename(current) || !/^v\d+\.\d+\.\d+-/.test(name)) continue;
        const stale = join(cacheRoot, name);
        const stat = lstatSync(stale);
        if (stat.isDirectory() && now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
          rmSync(stale, { recursive: true, force: true });
        }
      }
    } catch {
      // Best effort: anything not written or removed now is retried next launch.
    }
  }, 10_000).unref();
}
