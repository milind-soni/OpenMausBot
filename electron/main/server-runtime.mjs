// Extracted from electron/main.mjs: the live utility-server runtime state
// (port, process handle, readiness) and the tracked, timeout-bounded stop
// path for the packaged harness server child. Owns the
// SERVER_PORT/serverProc/serverReady live bindings; main.mjs imports them
// read-only and mutates them only through the exported setters, at the exact
// points where it used to assign the locals directly.
import { app } from "electron";

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
export let SERVER_PORT = 8799;
export let serverProc = null;
export let serverReady = !app.isPackaged;

export function setServerPort(port) {
  SERVER_PORT = port;
}

export function setServerReady(ready) {
  serverReady = ready;
}

/** A health-probed utility child just became the current server. */
export function adoptUtilityServer(proc) {
  serverProc = proc;
  serverReady = true;
}

export function markServerUnavailable() {
  serverReady = false;
  serverProc = null;
}

export const utilityServerExits = new WeakMap();
const UTILITY_SERVER_STOP_TIMEOUT_MS = 6_500;

export async function stopUtilityServer(proc, timeoutMs = UTILITY_SERVER_STOP_TIMEOUT_MS) {
  if (!proc) return true;
  const exited = utilityServerExits.get(proc);
  if (!exited) return false;
  try {
    proc.kill();
  } catch {
    // The tracked exit promise below is still the authority. A throw can mean
    // the process crossed the exit boundary immediately before kill().
  }
  let timer;
  return Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
