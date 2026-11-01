// The first launch after an update is the slow one on Windows: the new files are scanned and the old companion may
// still hold its ports, so the one start at launch can time out. A paired phone then has no way in until the app is
// restarted by hand, so the launch start tries again a few times, as long as the companion is still wanted.
export const COMPANION_AUTOSTART_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000]);

/**
 * Starts the companion, retrying a failed start after each delay while `wanted()` holds. Resolves with the last state;
 * a thrown error (a policy refusal) is never retried.
 */
export async function startCompanionWithRetries({
  start,
  wanted,
  log = () => {},
  delaysMs = COMPANION_AUTOSTART_RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let state = await start();
  for (const [index, delay] of delaysMs.entries()) {
    if (!state?.error) return state;
    log(`companion start failed: ${state.error}; trying again in ${Math.round(delay / 1000)}s (${index + 1} of ${delaysMs.length})`);
    await sleep(delay);
    if (!wanted()) {
      log("companion start retry skipped: the companion is no longer wanted");
      return state;
    }
    state = await start();
  }
  if (state?.error) log(`companion start failed: ${state.error}; giving up until the app restarts`);
  return state;
}
