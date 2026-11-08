// Screen Wake Lock: the web form of keeping the screen awake while the mic is
// open. iOS Safari releases the lock when the page hides and rejects a request
// made while hidden, so a visible page re-requests it.
type WakeLockSentinel = {
  release: () => Promise<void> | void;
  addEventListener?: (type: string, cb: () => void) => void;
  onrelease?: (() => void) | null;
};
type WakeLock = { request: (type: "screen") => Promise<WakeLockSentinel> };
type WakeDocument = {
  visibilityState: string;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
};

export type ScreenWake = {
  acquire: () => void;
  release: () => void;
  readonly held: boolean;
};

export function createScreenWake(overrides?: { wakeLock?: WakeLock | null; doc?: WakeDocument | null }): ScreenWake {
  let sentinel: WakeLockSentinel | null = null;
  let watching = false;
  const wakeLock = () =>
    overrides && "wakeLock" in overrides
      ? (overrides.wakeLock ?? null)
      : ((globalThis as { navigator?: { wakeLock?: WakeLock } }).navigator?.wakeLock ?? null);
  const doc = () =>
    overrides && "doc" in overrides
      ? (overrides.doc ?? null)
      : (typeof document === "undefined" ? null : (document as unknown as WakeDocument));

  const onVisible = () => {
    if (doc()?.visibilityState === "visible" && !sentinel) void request();
  };
  const request = async () => {
    const lock = wakeLock();
    if (!lock) return;
    try {
      const next = await lock.request("screen");
      if (next.addEventListener) next.addEventListener("release", () => { if (sentinel === next) sentinel = null; });
      else next.onrelease = () => { if (sentinel === next) sentinel = null; };
      sentinel = next;
    } catch {
      sentinel = null;
    }
  };

  return {
    acquire() {
      if (!wakeLock()) return;
      const target = doc();
      if (target && !watching) {
        watching = true;
        target.addEventListener("visibilitychange", onVisible);
      }
      if (!sentinel) void request();
    },
    release() {
      const target = doc();
      if (target && watching) {
        watching = false;
        target.removeEventListener("visibilitychange", onVisible);
      }
      const held = sentinel;
      sentinel = null;
      if (held) {
        try {
          void Promise.resolve(held.release()).catch(() => {});
        } catch {
          // A failed release leaves nothing held.
        }
      }
    },
    get held() {
      return sentinel !== null;
    },
  };
}
