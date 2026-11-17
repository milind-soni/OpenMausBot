// Owns one child, including while its health probe is pending; recovery retries the established port. `keepTrying()`:
// the computer is an always-on home, so a spent budget waits `longRetryMs` and starts over instead of giving up.
export function createServerSupervisor({
  restart,
  stop,
  onReady,
  onUnavailable,
  onExhausted,
  log = () => {},
  retryDelaysMs = [1_000, 2_000, 4_000],
  stableUptimeMs = 60_000,
  keepTrying = () => false,
  longRetryMs = 5 * 60_000,
  now = () => performance.now(),
}) {
  let current = null;
  let readySince = null;
  let stopped = false;
  let paused = false;
  let attempts = 0;
  let timer = null;
  let shutdownPromise = null;

  const isCurrent = (proc) => !stopped && current === proc;

  function ready(proc) {
    if (!isCurrent(proc)) return false;
    readySince = now();
    onReady(proc);
    return true;
  }

  function schedule() {
    if (stopped || paused) return;
    let delay;
    if (attempts < retryDelaysMs.length) {
      delay = retryDelaysMs[attempts++];
      log(`server recovery attempt ${attempts}/${retryDelaysMs.length} in ${delay}ms`);
    } else if (keepTrying()) {
      attempts = 0;
      delay = longRetryMs;
      log(`server recovery: always-on home, trying again in ${delay}ms`);
    } else {
      onExhausted();
      return;
    }
    timer = setTimeout(async () => {
      timer = null;
      if (paused) return;
      let result;
      try {
        result = await restart();
      } catch (error) {
        log(`server recovery failed: ${error?.message ?? error}`);
        // A thrown start with a still-owned child is not permission to fork a sibling.
        result = { abort: current !== null };
      }
      if (stopped || paused) return;
      if (result?.proc && ready(result.proc)) return;
      if (result?.abort) onExhausted();
      else schedule();
    }, delay);
    timer.unref?.();
  }

  function watch(proc) {
    if (stopped || current) throw new Error("Cannot replace an owned server child");
    current = proc;
    proc.once("exit", () => {
      // Late exits from a failed boot must not clear a replacement's state.
      if (current !== proc) return;
      const wasReady = readySince !== null;
      if (wasReady && now() - readySince >= stableUptimeMs) attempts = 0;
      current = null;
      readySince = null;
      onUnavailable();
      if (wasReady) schedule();
    });
  }

  // Pause drops any queued retry and holds recovery until resume(); exits and onUnavailable still publish.
  function pause() {
    if (stopped) return;
    paused = true;
    clearTimeout(timer);
    timer = null;
  }

  function resume() {
    paused = false;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    clearTimeout(timer);
    timer = null;
    const proc = current;
    current = null;
    readySince = null;
    onUnavailable();
    shutdownPromise = Promise.resolve(stop(proc));
    return shutdownPromise;
  }

  return { watch, ready, isCurrent, pause, resume, shutdown };
}
