export interface GracefulShutdownOptions {
  cleanup: ReadonlyArray<() => void | Promise<void>>;
  exit: (code: number) => void;
  timeoutMs?: number;
}

/** A wedged provider cannot keep the child alive, and a normal stop clears browser capabilities so no turn bearer outlives it. */
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
