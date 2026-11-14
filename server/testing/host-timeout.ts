// Windows CI runs this suite 1.4-1.5x slower than Linux, and a Linux shard that runs several files at once
// (OMB_VITEST_WORKERS, scripts/ci-scope.mjs) shares its CPU between them, so every test and hook timeout doubles there
// (vite.config.ts scales the defaults; explicit timeouts use hostTimeout()). One file at a time on Linux and macOS
// stays strict.
const sideBySide = Number(process.env.OMB_VITEST_WORKERS) > 1;
export const HOST_TIMEOUT_FACTOR = process.platform === "win32" || sideBySide ? 2 : 1;

export function hostTimeout(ms: number): number {
  return ms * HOST_TIMEOUT_FACTOR;
}
