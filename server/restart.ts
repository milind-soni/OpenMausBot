// The exit code a server uses to ask its launcher for a fresh start (after a restore commits).
export const RESTART_EXIT_CODE = 75;
export const MAX_RESTARTS = 5;
export const STABLE_RUN_MS = 60_000;

export function restartPolicy(now: () => number = Date.now) {
  let restarts = 0, startedAt = now();
  return {
    again(code: number | null, stopping = false): boolean {
      if (now() - startedAt >= STABLE_RUN_MS) restarts = 0;
      if (stopping || code !== RESTART_EXIT_CODE || restarts >= MAX_RESTARTS) return false;
      restarts++;
      startedAt = now();
      return true;
    },
  };
}
