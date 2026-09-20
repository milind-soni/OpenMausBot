// Re-checking the promise in cua-connection.json.
//
// startCua() persists a descriptor that makes two different claims: "spawn
// this proxy" and "there is a daemon on the other end of it". The first stays
// true for as long as the file exists. The second is a claim about a process,
// and the process can be gone by the time anyone reads it — an embedded host
// dies with the parent that owns it, a standalone daemon can be stopped by the
// user or the OS, and a machine that slept can wake to a closed pipe. Nothing
// in the app noticed. The panel kept rendering the mode it had been told, and
// every computer tool call failed inside a turn with a spawn error instead of
// an honest "computer use is not running".
//
// So the claim is checked rather than trusted. `socketPathOf` reads the one
// field worth probing: a descriptor that names no socket — unavailable, or a
// mode whose lifetime belongs to another runtime — is not this module's
// business, because a watchdog verifies promises, it does not invent them.
// `createCuaWatchdog` probes that socket on an interval and, when it is gone,
// revives the daemon through the caller's own start path, once no matter how
// many checks overlap (the single-flight discipline cua:linux-retry already
// uses).
//
// Pure and injectable — probe, clock, revive, log — so the whole decision is
// pinned by tests with no daemon, no socket, and no Electron.

"use strict";

/** The modes that own a daemon this process is able to probe. Linux keeps its
 * own runtime with its own retry path, so it is deliberately absent. */
const LIVE_MODES = new Set(["embedded", "standalone"]);

/** The socket a descriptor promises, or null when it promises none. */
function socketPathOf(connection) {
  if (!connection || typeof connection !== "object") return null;
  if (!LIVE_MODES.has(connection.mode)) return null;
  const socketPath = connection.socketPath;
  return typeof socketPath === "string" && socketPath.length > 0 ? socketPath : null;
}

/**
 * Watches the persisted descriptor.
 *
 * `read()` returns the current connection, `isAlive(socketPath)` probes it,
 * and `revive()` starts the daemon again — the caller's own start path, so the
 * lifecycle rules (generation counters, startup aborts) stay in one place
 * instead of being duplicated here.
 */
function createCuaWatchdog({
  read,
  isAlive,
  revive,
  intervalMs = 15_000,
  schedule = setInterval,
  cancel = clearInterval,
  log = () => {},
}) {
  let timer = null;
  let inflight = null;
  let stopped = true;

  async function inspect() {
    const connection = read();
    const socketPath = socketPathOf(connection);
    // Nothing to verify. Note this is also how a failed start settles: it
    // persists `unavailable`, so the next check stops rather than restarting
    // a driver that just refused to come up.
    if (!socketPath) return { status: "untracked" };
    if (await isAlive(socketPath)) return { status: "alive" };
    return { status: "dead", socketPath };
  }

  async function check() {
    const inspected = await inspect();
    if (inspected.status !== "dead") return inspected;
    // One revive at a time. The interval and the panel can both find the same
    // dead socket, and a second start would tear down the replacement the
    // first one just built.
    inflight ??= (async () => {
      log(`[cua] the daemon behind ${inspected.socketPath} is gone; restarting computer use`);
      try {
        const connection = await revive();
        return { status: socketPathOf(connection) ? "revived" : "unavailable", connection };
      } catch (error) {
        // A revive that throws leaves the old descriptor in place, so the next
        // check tries again — this is the retry, not a place to give up.
        log(`[cua] watchdog restart failed: ${error?.message ?? error}`);
        return { status: "failed", error };
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return Object.freeze({
    check,
    /** Idempotent: a second successful start does not arm a second interval. */
    start() {
      if (!stopped) return;
      stopped = false;
      timer = schedule(() => { void check(); }, intervalMs);
      // Never hold a quitting app open on this timer.
      timer?.unref?.();
    },
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
    },
    get running() {
      return !stopped;
    },
  });
}

module.exports = { LIVE_MODES, socketPathOf, createCuaWatchdog };
