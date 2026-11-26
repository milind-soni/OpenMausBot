// Node's compile cache for the desktop app's own main process (electron/boot.mjs turns it on before main.mjs loads), as
// scripts/desktop-server-entry.mjs does for its server: a relaunch reuses the compiled code of the ~100 modules main
// imports instead of compiling them again. Kept in the app's own folder (userData), never the data folder. Node checks each
// entry against its source, so code an update changed is compiled afresh; its directory per Node version (one is left
// behind by each Electron upgrade) is removed once no launch has used it for a day.
import fs from "node:fs";
import path from "node:path";

export const MAIN_COMPILE_CACHE = "main-compile-cache";
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Where the main process keeps its cache, or null: an unpackaged run, or an app whose path changes each launch (an
 * AppImage, a translocated macOS app), since Node keys entries by full path. */
export function mainCompileCacheDir({ packaged, userData, resourcesPath, env = process.env }) {
  if (!packaged || !userData || Boolean(env.APPIMAGE) || String(resourcesPath ?? "").includes("/AppTranslocation/")) return null;
  return path.join(userData, MAIN_COMPILE_CACHE);
}

/** After the window is up: writes what this launch compiled (a crash or a Windows kill skips Node's write at exit) and
 * removes other Node versions' directories unused for a day. Only `v<node version>-…` directories inside `root`. */
export function settleCompileCache({ module, root, now = Date.now(), fsImpl = fs }) {
  try {
    module.flushCompileCache();
    const current = module.getCompileCacheDir();
    if (!current || path.dirname(current) !== path.resolve(root)) return;
    const stamp = new Date(now);
    fsImpl.utimesSync(current, stamp, stamp);
    for (const name of fsImpl.readdirSync(root)) {
      if (name === path.basename(current) || !/^v\d+\.\d+\.\d+-/.test(name)) continue;
      const stale = path.join(root, name);
      const stat = fsImpl.lstatSync(stale);
      if (stat.isDirectory() && now - stat.mtimeMs > STALE_AFTER_MS) fsImpl.rmSync(stale, { recursive: true, force: true });
    }
  } catch {
  }
}
