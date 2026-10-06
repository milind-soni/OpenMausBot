/** Keep a user-started action pending until desktop readiness, not merely
 * until the runtime reports that the desktop process has started. Poll at
 * the panel's 2 s pace; a slow status read must not outlive the deadline.
 * Return the last status on timeout so the caller can show its problem. */
export async function waitForLocalVmReady<T extends {
  ready: boolean;
  container: string;
  problem: string | null;
  backend?: string;
  os?: string;
}>(
  initial: T,
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = initial.backend === "cua-spaces" ? initial.os === "macos" ? 300_000 : 90_000 : 60_000,
): Promise<T> {
  signal.throwIfAborted();
  if (initial.ready || initial.container !== "running") return initial;
  let status = initial;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let deadlineTimer: number | undefined;
  const timeout = new Promise<T>((resolve) => {
    deadlineTimer = window.setTimeout(() => {
      resolve(status);
      controller.abort();
    }, timeoutMs);
  });
  const poll = async (): Promise<T> => {
    while (!status.ready && status.container === "running") {
      controller.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { window.clearTimeout(timer); reject(controller.signal.reason); };
        const timer = window.setTimeout(() => { controller.signal.removeEventListener("abort", cancel); resolve(); }, 2_000);
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
      const next = await read(controller.signal);
      controller.signal.throwIfAborted();
      status = next;
    }
    return status;
  };
  try {
    // Cancellation must also settle a read that does not honour its signal.
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    return await Promise.race([poll(), timeout, cancelled]);
  } finally {
    window.clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
