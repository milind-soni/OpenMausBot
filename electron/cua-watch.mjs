// Nothing else notices when the computer-control driver dies after it started: its socket stops answering, every MCP bridge
// exits as soon as it connects, and computer control stays broken until the app restarts. This asks the socket every so
// often and calls `restart` once when it has stopped answering.

export const WATCH_EVERY_MS = 15_000;
export const MISSES_BEFORE_RESTART = 2;
/** Between further tries when a restart didn't bring the driver back; then it waits for the person. */
export const DEAD_DRIVER_RETRY_MS = [5_000, 30_000, 120_000, 600_000];

/** A failure more tries won't fix: the person has to act, and each try may ask macOS for the permission again. */
export function restartWorthTrying(message) {
  return !/grant access|permission|restart cancelled/i.test(String(message ?? ""));
}

/** `restart` runs at most once per watch: a successful restart starts a new one. */
export function watchDriver({ alive, restart, everyMs = WATCH_EVERY_MS, misses = MISSES_BEFORE_RESTART, log = console.warn }) {
  let timer = null, stopped = false, missed = 0;
  const arm = () => {
    timer = setTimeout(tick, everyMs);
    timer.unref?.();
  };
  async function tick() {
    timer = null;
    const up = await Promise.resolve().then(alive).catch(() => false);
    if (stopped) return;
    missed = up ? 0 : missed + 1;
    if (missed < misses) return arm();
    stopped = true;
    log(`[cua] the driver stopped answering after ${missed} checks; starting it again`);
    await Promise.resolve().then(restart).catch((error) => log(`[cua] could not start the driver again: ${error?.message ?? error}`));
  }
  arm();
  return { stop() { stopped = true; clearTimeout(timer); timer = null; } };
}
