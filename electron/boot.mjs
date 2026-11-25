// The desktop app's entry (package.json "main"): Node's compile cache for this process first (main-compile-cache.mjs),
// then the app itself. main.mjs is one static module graph, compiled as it loads, so the cache must be on before it.
import module from "node:module";
import { app } from "electron";

import { mainCompileCacheDir, settleCompileCache } from "./main-compile-cache.mjs";

const root = mainCompileCacheDir({ packaged: app.isPackaged, userData: app.getPath("userData"), resourcesPath: process.resourcesPath });
let enabled = false;
if (root) {
  try {
    enabled = module.enableCompileCache(root).status === module.constants.compileCacheStatus.ENABLED;
  } catch {
  }
}

await import("./main.mjs");

if (enabled) setTimeout(() => settleCompileCache({ module, root }), 10_000).unref();
