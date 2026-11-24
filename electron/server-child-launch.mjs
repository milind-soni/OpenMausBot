import fs from "node:fs";
import path from "node:path";

/** Node keys compile-cache entries by full path, and an AppImage or a translocated macOS app runs from a new path each launch: no cache there. */
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

const STOP_TIMEOUT_MS = 9_500; // The server allows 8 seconds for shutdown and 1 second to flush its log.

export function waitForChildExit(exited, timeoutMs = STOP_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    exited.then(() => true),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function stopOwnedChild(proc, exited) {
  if (!proc) return true;
  if (!exited) return false;
  try { proc.kill(); } catch {}
  return waitForChildExit(exited);
}
