// Which file the packaged desktop forks as its server, and where that server
// keeps Node's compile cache (scripts/desktop-server-entry.mjs).
import fs from "node:fs";
import path from "node:path";

/** `{ entry, compileCacheDir }` for the utility server child.
 *
 * compileCacheDir is null wherever the cache could never hit. Node keys each
 * entry by the file's full path, and an AppImage mounts at a new path on
 * every launch, as does an app macOS App Translocation runs from a random
 * location. There a cache would only add a write and a new 1.75 MB entry per
 * launch. A server tree without the bootstrap forks index.js directly, as
 * before. */
export function serverChildLaunch({ resourcesPath, userData, env = process.env, exists = fs.existsSync }) {
  const serverDir = path.join(resourcesPath, "server");
  const bootstrap = path.join(serverDir, "desktop-entry.mjs");
  if (!exists(bootstrap)) return { entry: path.join(serverDir, "index.js"), compileCacheDir: null };
  const pathChangesEachLaunch = Boolean(env.APPIMAGE) || resourcesPath.includes("/AppTranslocation/");
  return {
    entry: bootstrap,
    compileCacheDir: pathChangesEachLaunch ? null : path.join(userData, "server-compile-cache"),
  };
}
