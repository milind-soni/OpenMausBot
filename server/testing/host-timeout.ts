// Windows CI runners run this suite 1.4-1.5x slower than Linux (docs/ci.md),
// so a timeout with room on Linux is a coin flip there. Every test and hook
// timeout doubles on Windows: vite.config.ts scales the defaults, and a test
// that sets its own timeout wraps the number in hostTimeout(). Linux and macOS
// keep the strict numbers, so a real slowdown still fails there.
export const HOST_TIMEOUT_FACTOR = process.platform === "win32" ? 2 : 1;

export function hostTimeout(ms: number): number {
  return ms * HOST_TIMEOUT_FACTOR;
}
