// A saved app opened from its launcher on this computer (openmausbot://app/<id>?window=1, by open-url on macOS or as an
// argument of a first or second launch elsewhere): held until the app and its server are up, then opened in the app's
// own window, never in the main one.
import { parseAppLink } from "./app-link.mjs";

const RETRY_MS = 500;
const MAX_PENDING = 20;

/** `later(run, ms)`: a timer that keeps nothing alive. */
export function createAppLaunches({ later = (run, ms) => setTimeout(run, ms).unref?.() } = {}) {
  const pending = [];
  let open = null;
  let waiting = false;

  function flush() {
    waiting = false;
    while (open && pending.length) {
      if (!open(pending[0])) {
        if (!waiting) { waiting = true; later(flush, RETRY_MS); }
        return;
      }
      pending.shift();
    }
  }

  /** True when `value` was a launcher's link: it is then this module's, and no chat link. */
  function take(value) {
    const link = parseAppLink(value);
    if (!link?.window) return false;
    if (!pending.includes(link.id) && pending.length < MAX_PENDING) pending.push(link.id);
    flush();
    return true;
  }

  return {
    fromUrl: take,
    fromArgs(argv) {
      let taken = false;
      for (const value of Array.isArray(argv) ? argv : []) taken = take(value) || taken;
      return taken;
    },
    /** `opener(id)`: opens the app's window and says true, or false while it can't yet (tried again shortly). */
    attach(opener) {
      open = opener;
      flush();
    },
    pending: () => [...pending],
  };
}
