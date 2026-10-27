// What tells a quiet moment for a downloaded update, from Electron and from the servers this app's window talks to.
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";

/** A server's JSON answer; a failure or a server error throws, since nothing can be known from it. */
async function answer(response) {
  const got = await response;
  if (got.status >= 500 || got.status === 0) throw new Error(`answered ${got.status}`);
  return got.ok ? got.json().catch(() => null) : null;
}

/**
 * @param {{
 *   powerMonitor: { getSystemIdleTime(): number, getSystemIdleState(threshold: number): string, on(event: string, listener: () => void): unknown },
 *   window(): null | { isDestroyed(): boolean, isVisible(): boolean, isMinimized(): boolean },
 *   lastInput(): number,
 *   local(route: string, init?: RequestInit): Promise<Response>,
 *   place(): string | null,
 *   cloudFetch(url: string, init?: RequestInit): Promise<Response>,
 *   asleep(origin: string): boolean,
 *   busy(): string | null,
 * }} deps `local`: this computer's server, as its owner. `place`: the origin of My Cloud or a team while the window shows
 * it, where a Live call in this window runs; `asleep`: that Cloud sleeps, so no call runs there, and asking would wake it.
 */
export function quietSignals({ powerMonitor, window, lastInput, local, place, cloudFetch, asleep, busy }) {
  const timeout = () => AbortSignal.timeout(10_000);
  return {
    locked: () => powerMonitor.getSystemIdleState(1) === "locked",
    idleMs: () => powerMonitor.getSystemIdleTime() * 1000,
    typedAt: lastInput,
    shown() {
      const win = window();
      return Boolean(win && !win.isDestroyed() && (win.isVisible() || win.isMinimized()));
    },
    busy,
    /** What runs on this computer's server (what the move waits for: a bot's turn, a routine run, a room, a hand-off, a
     * sign-in), or a Live call here or on the Cloud the window shows. */
    async work() {
      const held = await answer(local("/api/move/freeze", { signal: timeout() }));
      if (!held) throw new Error("This computer's server did not say what it is doing.");
      if (typeof held.busy === "string") return held.what ?? "bot";
      if ((await answer(local("/api/live/call", { signal: timeout() })))?.call) return "call";
      const origin = place();
      if (origin && !asleep(origin)) {
        const there = await answer(cloudFetch(`${origin}/api/live/call`, { headers: BACKGROUND_HEADERS, credentials: "include", cache: "no-store", redirect: "error", signal: timeout() }));
        if (there?.call) return "call";
      }
      return null;
    },
    /** Looks at once when the screen locks: a laptop may sleep soon after. */
    watch(look) {
      powerMonitor.on("lock-screen", () => void look());
    },
  };
}
