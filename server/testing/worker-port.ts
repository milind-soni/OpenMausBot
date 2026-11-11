// CI runs test files side by side on vitest's workers, and a suite's ports are only probed, never reserved. So a port's
// low bits name the worker that may use it: two workers never pick the same port, whatever range each asks for. Two
// slots each, because a harness also listens one above its own port. Outside a worker a port stays as it was picked.
const SLOTS = 32;

export function forWorker(port: number, poolId: string | undefined = process.env.VITEST_POOL_ID): number {
  const id = Number(poolId);
  if (!Number.isSafeInteger(id) || id < 1) return port;
  return port - (port % SLOTS) + ((id - 1) % (SLOTS / 2)) * 2;
}

/** A random port of this worker in `from`..`from + span`, for a suite that has no time to probe. */
export function workerPort(from: number, span: number): number {
  return forWorker(from + Math.floor(Math.random() * span));
}
