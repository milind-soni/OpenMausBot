// The companion sidecar's lifecycle, as seen by the desktop app.
//
// The sidecar is a separate process on purpose — it is the only thing here
// that listens off-machine, and keeping it out of the harness is what lets
// the harness stay loopback-only and unpatched. But "separate process" does
// not have to mean "open a terminal": the app already forks the harness the
// same way, and a toggle in Settings is what anyone actually wants.
//
// The renderer never talks to the sidecar's control port directly. It calls
// through here, which keeps the UI on one origin, avoids CORS, and means the
// narrow list of things the renderer may ask for is written down in one
// place rather than implied by whatever the control server happens to serve.
import { app, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { resolveCompanionEntry } from "./companion-entry.mjs";

// Passed to the fork rather than left to the sidecar's own defaults, so the
// port this file fetches the control API on cannot drift from the port the
// sidecar opened. They must stay clear of the harness, which takes 8799 for
// itself and 8800 for its webhook receiver — the sidecar refuses to start on
// either and says which, rather than racing it for the socket.
const CONTROL_PORT = 8811;
const COMPANION_PORT = 8810;

let proc = null;
let lastError = null;

/** Where the sidecar's entry lives, and the Node flags it needs.
 *
 * Packaged, it is staged into resources alongside the harness. In dev the
 * compiled dist-companion output is preferred when it exists, and the
 * TypeScript source is the fallback — run with type stripping, exactly as
 * the `companion` script runs it — so the toggle works without a build step
 * nobody remembers. Returning null rather than a path that does not exist is
 * what lets the toggle say so instead of failing with a spawn error nobody
 * can read. */
const entryPoint = (resourcesPath) =>
  resolveCompanionEntry({
    isPackaged: app.isPackaged,
    resourcesPath,
    appPath: app.getAppPath(),
    exists: fs.existsSync,
  });

// ── the remembered toggle ────────────────────────────────────────────────
// The Settings toggle used to be the only thing that ever started the
// sidecar, so a paired phone died with every relaunch of the app: port 8810
// stayed closed until the user rediscovered the switch. The position of the
// toggle is state worth keeping, and it lives in the app's own userData —
// like cua-connection.json — because the app owns the toggle. Not in the
// sidecar's ~/.openmausbot-companion, which is the child process's directory,
// and not in the harness's config.json, which is somebody else's data layout.

const settingsFile = () => path.join(app.getPath("userData"), "companion-settings.json");

/** Whether the user left the companion on. Anything unreadable is "off" —
 * the flag opens a network listener, so it fails closed. */
export function companionEnabledAtRest() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"))?.enabled === true;
  } catch {
    return false;
  }
}

/** Remember the toggle's position. Written via temp-and-rename so a crash
 * mid-write cannot leave a truncated file; a failed write costs auto-start
 * on the next launch, never the toggle itself. */
export function rememberCompanionEnabled(enabled) {
  const file = settingsFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ enabled }, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* never created, or already renamed */
    }
  }
}

/** Ask the sidecar's own control server, which is the same API the standalone
 * page uses. Short timeout: this is loopback, and a spinner in Settings that
 * never resolves is worse than an error. */
async function control(method, urlPath) {
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${urlPath}`, {
    method,
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok && res.status !== 404) throw new Error(`companion control ${res.status}`);
  return res.json();
}

/** Whether this process owns a running sidecar. */
export function companionRunning() {
  return proc !== null;
}

// Every lifecycle transition runs to completion before the next one begins.
//
// Without this the guards below look sufficient and are not, because each one
// is a check followed by an await. Three things go wrong, and all of them end
// with the toggle and reality disagreeing: two concurrent starts both pass
// `if (proc)` and fork two sidecars; a failed start overwrites the `proc` a
// successful one just published; and a stop issued mid-startup finds `proc`
// still null, so it kills nothing and the start it raced then publishes a
// sidecar the user has already asked to shut down.
let transition = Promise.resolve();

/** Queue a lifecycle transition behind whatever is already in flight. */
const serialize = (work) => {
  const next = transition.then(work, work);
  // The chain itself must never carry a rejection forward, or one failed
  // transition would poison every transition after it.
  transition = next.then(
    () => {},
    () => {},
  );
  return next;
};

/** Fork the sidecar and wait for it to answer. Resolves with the panel's
 * state either way — a failed start is a message, never a thrown error. */
export function startCompanion(options) {
  return serialize(() => start(options));
}

/** Stop the sidecar and wait for it to actually be gone. */
export function stopCompanion() {
  return serialize(() => stop());
}

/** startCompanion's body, run inside the transition queue. */
async function start({ resourcesPath, harnessPort, log }) {
  if (proc) return companionState();
  lastError = null;
  const resolved = entryPoint(resourcesPath);
  if (!resolved) {
    // In dev this now means even companion/src is gone — a broken checkout,
    // not a missing build step, so the old "run pnpm build:companion" advice
    // would send someone to a command that cannot help.
    lastError = app.isPackaged
      ? "the companion is missing from this build"
      : "the companion sources are missing from this checkout";
    return companionState();
  }
  log?.(`companion fork ${resolved.entry}`);

  const child = utilityProcess.fork(resolved.entry, [], {
    env: {
      ...process.env,
      OMB_PORT: String(harnessPort),
      OMB_COMPANION_PORT: String(COMPANION_PORT),
      OMB_CONTROL_PORT: String(CONTROL_PORT),
    },
    // how the TS-source fallback gets --experimental-strip-types; empty for
    // compiled entries
    execArgv: resolved.execArgv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => log?.(`[companion] ${String(d).trimEnd()}`));
  child.stderr?.on("data", (d) => log?.(`[companion err] ${String(d).trimEnd()}`));

  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    // A non-zero exit before we saw it answer is the interesting case: the
    // usual cause is the port already being taken, and the sidecar's own
    // message says which one and why.
    if (proc === child) proc = null;
    log?.(`companion exited code=${code}`);
  });

  // Wait for the control port rather than assuming the fork worked. Without
  // this the toggle would flip to "on" and the panel would then fail every
  // request, which reads as a broken app rather than a failed start.
  for (let i = 0; i < 40; i++) {
    if (exited) {
      lastError = "the companion could not start — check the log";
      return companionState();
    }
    try {
      const state = await control("GET", "/state");
      // An answer on the control port proves something is listening there,
      // not that it is the child we just forked. A sidecar started by hand,
      // or one left behind by a previous run, answers exactly the same and
      // would be adopted as ours — after which the toggle drives a process
      // it does not own and stopping it does nothing visible. Match the pid.
      if (state?.pid !== undefined && child.pid !== undefined && state.pid !== child.pid) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        lastError = `port ${CONTROL_PORT} is already serving another companion — stop it and try again`;
        return companionState();
      }
      proc = child;
      return companionState();
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  lastError = "the companion did not come up in time";
  return companionState();
}

/** stopCompanion's body, run inside the transition queue. */
async function stop() {
  const child = proc;
  proc = null;
  lastError = null;
  if (!child) return companionState();
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  // kill() asks. Returning before the process is actually gone means the
  // next start races a sidecar still holding the port, and the user sees the
  // toggle fail for a reason that has already stopped being true. Wait for
  // the exit, bounded — a wedged child must not leave Settings stuck either.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", finish);
    setTimeout(finish, 5_000).unref?.();
  });
  return companionState();
}

/** Everything the panel renders. Shaped so "off" is a complete answer rather
 * than an absence — the panel should never have to guess. */
export async function companionState() {
  if (!proc) {
    return { enabled: false, port: COMPANION_PORT, devices: [], pairing: null, ...(lastError ? { error: lastError } : {}) };
  }
  try {
    const state = await control("GET", "/state");
    return { enabled: true, ...state };
  } catch {
    // running but unreachable: report it rather than claiming health
    return { enabled: true, port: COMPANION_PORT, devices: [], pairing: null, error: "the companion is not responding" };
  }
}

/** Open or close a pairing window on the running sidecar. */
export async function companionPairing(open) {
  if (!proc) return companionState();
  await control(open ? "POST" : "DELETE", "/pairing").catch(() => {});
  return companionState();
}

/** Unpair one device. Ignores an id the renderer should not have sent. */
export async function companionRevoke(deviceId) {
  if (!proc) return companionState();
  // the id came from the renderer, so it does not get to shape a path
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control("DELETE", `/devices/${deviceId}`).catch(() => {});
  return companionState();
}

/** Enable or remove interactive cloud-desktop access for one paired phone. */
export async function companionCloudDesktopAccess(deviceId, allowed) {
  if (!proc) return companionState();
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control(allowed ? "POST" : "DELETE", `/devices/${deviceId}/cloud-desktop`).catch(() => {});
  return companionState();
}
