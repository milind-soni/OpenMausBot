export interface GracefulShutdownOptions {
  cleanup: ReadonlyArray<() => void | Promise<void>>;
  exit: (code: number) => void;
  timeoutMs?: number;
}

/** Build one idempotent shutdown callback for process signals. Cleanup jobs
 * run together, but a wedged provider cannot keep the desktop child alive
 * forever. The browser capability clear is one of these jobs, so a normal
 * server stop does not leave a turn bearer usable until its absolute TTL. */
export function createGracefulShutdown({
  cleanup,
  exit,
  timeoutMs = 6_000,
}: GracefulShutdownOptions): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.allSettled(cleanup.map((job) => Promise.resolve().then(job)))
      .then(() => undefined);

    void Promise.race([settled, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
      exit(0);
    });
  };
}
