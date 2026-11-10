// A Mac driver that hangs without exiting, or a standalone one whose exit nothing sees, would leave computer control broken:
// its socket stops answering, and every MCP bridge exits as soon as it connects. This asks the socket every so often and
// calls `restart` once when it has stopped answering; cua.mjs hands that to the helper's bounded restarts (cua-restart.mjs).

export const WATCH_EVERY_MS = 15_000;
export const MISSES_BEFORE_RESTART = 2;
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
