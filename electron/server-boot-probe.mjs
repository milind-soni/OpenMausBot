// Kernel of the packaged-server boot wait (see issue #506): poll a freshly
// forked child's /api/health until it either proves its identity, we learn
// some other process owns the port, or the wall-clock budget runs out.
//
// Extracted from electron/main.mjs so the failure modes below can carry
// regression tests without booting Electron (main.mjs is not importable in a
// bare node test — importing it starts the whole app bootstrap).
//
// - The budget is wall-clock and shared by every step: each in-flight probe is
//   aborted at the remaining deadline, so a server that accepts connections
//   but never answers cannot wedge the launcher past its own timeout.
// - ANY HTTP answer on the port proves somebody owns it. Only our own child's
//   identity payload counts as ready; everything else (a 404/503 from an
//   unrelated app, wrong pid, non-JSON body) is reported as a foreign owner
//   immediately instead of burning the rest of the budget re-polling a port
//   we will never win.
// - The expected pid must be read as a GETTER at response time, not captured
//   when the caller forks: Electron's utilityProcess assigns proc.pid on the
//   async `spawn` event, so a value grabbed right after fork() is still
//   undefined and our own freshly-bound child would fail the identity match
//   and be reaped as a "foreign owner" on its very first health answer.

export const BOOT_PROBE_INTERVAL_MS = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   port: number,
 *   pid: () => number | undefined,
 *   bootTimeoutMs: number,
 *   isExited?: () => boolean,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   fetchImpl?: typeof fetch,
 *   restoreProgress?: () => { phase: string, at: number } | undefined,
 *   restoreStallTimeoutMs?: number,
 * }} options
 * @returns {Promise<{ outcome: "ready" | "foreign-owner" | "timeout" | "exited" }>}
*/
export async function pollServerIdentity({
  port,
  pid,
  bootTimeoutMs,
  isExited = () => false,
  now = Date.now,
  sleep = defaultSleep,
  fetchImpl = globalThis.fetch,
  restoreProgress = () => undefined,
  restoreStallTimeoutMs = 5 * 60_000,
}) {
  const startedAt = now();
  const deadline = () => {
    const restore = restoreProgress();
    return restore ? restore.at + (restore.phase === "done" ? bootTimeoutMs : restoreStallTimeoutMs) : startedAt + bootTimeoutMs;
  };
  for (;;) {
    if (isExited()) return { outcome: "exited" };
    const remainingMs = Math.max(0, deadline() - now());
    if (remainingMs <= 0) return { outcome: "timeout" };

    let res;
    const signal = AbortSignal.timeout(Math.min(remainingMs, 1_000));
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
        // Poll frequently enough to notice progress even when a socket hangs.
        signal,
      });
    } catch {
      // Not up yet, or this probe ran into the wall-clock budget — either way
      // back off to the poll interval, then let the loop condition decide.
      await sleep(Math.min(BOOT_PROBE_INTERVAL_MS, Math.max(1, deadline() - now())));
      continue;
    }
    const body = await res.json().catch(() => null);
    if (signal.aborted && now() < deadline()) continue;
    // Body consumption is covered by the same abort signal as fetch. If it
    // reaches the deadline, a null body means the probe timed out—not that a
    // different process answered on the port.
    if (now() >= deadline()) return { outcome: "timeout" };
    // Read the expected pid NOW, after the response landed: until the child's
    // `spawn` event fires the getter yields undefined, and a child that has
    // not spawned cannot be the one answering — so an answer during that
    // window is genuinely somebody else's.
    const expectedPid = pid();
    const identified =
      res.ok &&
      expectedPid !== undefined &&
      body?.app === "openmausbot" &&
      body.pid === expectedPid &&
      body.static;
    if (!identified) return { outcome: "foreign-owner" };
    // A response that finishes after the budget must not count as a healthy
    // boot — re-check the clock before declaring victory.
    if (now() >= deadline()) return { outcome: "timeout" };
    return { outcome: "ready", latencyMs: now() - startedAt };
  }
}
