// Teardown primitives for suites that spawn a real process against a throwaway home.
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

export interface WaitForExitOptions {
  /** Sent immediately. Omit for a child the caller has already signalled. */
  signal?: NodeJS.Signals;
  /** How long the polite signal gets before SIGKILL. */
  graceMs?: number;
}

/** End a child and wait for `close`: kill() does not wait, and deleting its home mid-write fails on
 * Linux with EACCES/ENOTEMPTY. A SIGKILL after `graceMs` is not an exit either. */
export function waitForExit(
  child: ChildProcess | undefined,
  options: WaitForExitOptions | number = {},
): Promise<void> {
  const { signal, graceMs = 5_000 } = typeof options === "number" ? { graceMs: options } : options;

  return new Promise<void>((resolve) => {
    // A process killed by a signal reports it in signalCode and leaves exitCode null.
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.on("close", done);

    if (signal) {
      try {
        child.kill(signal);
      } catch {}
    }

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      timer = setTimeout(done, 2_000);
      timer.unref?.();
    }, graceMs);
    timer.unref?.();
  });
}

/** A just-killed child lets go of its files a beat later, and rmSync's maxRetries misses EACCES/EPERM on
 * the directory itself: retry briefly, then warn and leave it. */
export async function removeTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.warn(
    `test cleanup could not remove ${dir}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
