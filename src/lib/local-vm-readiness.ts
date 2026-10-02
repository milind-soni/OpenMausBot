/** Keep a user-started action pending until desktop readiness, not merely
 * until the runtime reports that the container process has started. Each
 * status read probes the container runtime, so poll at the panel's 2 s pace. */
export async function waitForLocalVmReady<T extends { ready: boolean; container: string; problem: string | null }>(
  initial: T,
  read: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let status = initial;
  while (!status.ready && status.container === "running" && Date.now() < deadline) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { window.clearTimeout(timer); reject(signal.reason); };
      const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2_000);
      signal.addEventListener("abort", abort, { once: true });
    });
    status = await read();
  }
  signal.throwIfAborted();
  return status;
}
