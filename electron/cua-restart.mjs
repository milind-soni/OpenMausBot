// Computer control's helper can die while the app runs. It is started again by itself a bounded number of times, and
// what is true meanwhile is what readiness says.
export const HELPER_RESTARTING = "Computer control stopped because its helper crashed. OpenMausBot is restarting it.";
export const HELPER_KEEPS_CRASHING =
  "Computer control's helper keeps crashing, so OpenMausBot stopped restarting it. Quit and reopen OpenMausBot to try again.";

export const RESTART_WAITS_MS = [1_000, 5_000, 15_000];
/** A helper that ran this long was fine: the next crash starts a new count. */
export const STABLE_AFTER_MS = 120_000;

/**
 * `restart()` resolves true when a working helper is back, false when it is not, and "needs-person" when only the person
 * can fix why (the reason already published stays). `report(reason)` publishes why computer control is down.
 * `started()` after any start that gave a working helper; `exited(detail)` when a working one died; `reset()` when the
 * person restarts it or the app stops it, which cancels a waiting restart and forgets the count.
 */
export function createHelperRestarts({
  restart,
  report,
  log = () => {},
  now = Date.now,
  waitsMs = RESTART_WAITS_MS,
  stableAfterMs = STABLE_AFTER_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let failures = 0;
  let startedAt = null;
  let timer = null;
  let epoch = 0;

  const tryAgain = () => {
    if (failures >= waitsMs.length) {
      log(`helper kept crashing; stopped after ${failures} restarts`);
      report(HELPER_KEEPS_CRASHING);
      return;
    }
    const wait = waitsMs[failures++];
    const run = ++epoch;
    report(HELPER_RESTARTING);
    timer = setTimer(async () => {
      timer = null;
      let back = false;
      try {
        back = await restart();
      } catch (error) {
        log(`helper restart failed: ${error?.message ?? error}`);
      }
      if (run !== epoch || back === "needs-person") return;
      if (back) startedAt = now();
      else tryAgain();
    }, wait);
    timer.unref?.();
  };

  return {
    started() {
      startedAt = now();
    },
    exited(detail) {
      if (startedAt !== null && now() - startedAt >= stableAfterMs) failures = 0;
      startedAt = null;
      log(`helper exited: ${detail}`);
      tryAgain();
    },
    reset() {
      epoch++;
      if (timer !== null) clearTimer(timer);
      timer = null;
      failures = 0;
      startedAt = null;
    },
  };
}

/** The Linux runtime publishes its own connection records; a died daemon and a ready one are what restarts need from them. */
export function followLinuxConnection(restarts, connection) {
  if (connection?.status === "ready") restarts.started();
  else if (connection?.reasonCode === "daemon-exited") restarts.exited(`exit ${connection.exitCode ?? connection.exitSignal ?? "unknown"}`);
}
