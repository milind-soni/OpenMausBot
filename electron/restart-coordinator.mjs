/**
 * Coordinates an application handoff with work owned by a child process.
 *
 * `prepare` must make new work fail closed, `checkpoint` persists safe
 * restartable state, and `status` reports the work that is still in flight.
 * The installer is called by the owner after this operation resolves. A
 * timeout aborts the drain; callers must not install after a rejected
 * operation because the child may still be working.
 */
export function createRestartCoordinator({
  prepare,
  checkpoint = async () => {},
  status,
  abort = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  pollMs = 250,
  timeoutMs = 30_000,
}) {
  if (!prepare || !status) {
    throw new TypeError("restart coordinator requires prepare and status callbacks");
  }
  let operation = null;

  const isIdle = (snapshot) =>
    snapshot?.idle === true ||
    (Number(snapshot?.activeTurns ?? NaN) === 0 && Number(snapshot?.activeWorkers ?? NaN) === 0);

  function waitForIdle() {
    if (operation) return operation;

    const run = (async () => {
      let prepareAttempted = false;
      try {
        prepareAttempted = true;
        await prepare();
        // Persist any safe, restartable state only after admission is closed.
        // This prevents a checkpoint from racing with a newly accepted job.
        await checkpoint();
        const deadline = now() + Math.max(0, timeoutMs);
        while (true) {
          if (isIdle(await status())) return true;
          if (now() >= deadline) {
            throw new Error("active work did not become idle before restart");
          }
          await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
        }
      } catch (error) {
        if (prepareAttempted) await Promise.resolve(abort()).catch(() => {});
        throw error;
      }
    })();
    const pending = run.finally(() => {
      if (operation === pending) operation = null;
    });
    operation = pending;
    return pending;
  }

  return { waitForIdle };
}
