// Keeps the Bonjour record in step with the network this machine is on.
//
// Advertising used to happen once, at startup, and that failed in both
// directions: a laptop opened before wifi associates has no addresses yet, so
// `advertise` returned false and the sidecar silently never advertised; and a
// DHCP move or network change left the A records pointing at addresses the
// machine no longer holds, so the phone found a computer it could not reach.
// Either way `discovery.advertising` told the panel a story that had stopped
// being true.
//
// The cure is a watcher, not an event: Node has no portable "interfaces
// changed" signal, and a poll every few seconds against the interface table
// costs nothing. Only the *set* of addresses matters — a tick that sees the
// same set does nothing, so re-announcing (which resets caches network-wide)
// happens exactly on transitions.

/** What the watcher needs: the current addresses, and the two moves it can
 * make. It never touches a socket itself, which is what makes it testable. */
export interface AddressWatchOptions {
  /** The addresses worth advertising right now. */
  addresses: () => string[];
  /** Rebuild and announce the service record from the current addresses.
   * Resolves false when the responder could not start (port 5353 busy,
   * multicast off) — a condition, never an error. */
  advertise: () => Promise<boolean>;
  /** Withdraw the record and close the responder, so caches forget us rather
   * than pointing phones at addresses we no longer hold. */
  withdraw: () => Promise<void>;
  log?: (line: string) => void;
}

export interface AddressWatcher {
  /** One comparison of the address set against what was last acted on,
   * re-advertising or withdrawing on a change. Exposed for the first run and
   * for tests; the interval calls the same code. */
  check: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

/** How often the interface table is consulted. Reading it is a syscall, not
 * a packet — nothing goes on the wire unless something changed. Networks
 * change on the minutes scale (sleep/wake, wifi hop); this is the sidecar's
 * only recurring wakeup, so it earns a lazy cadence. */
const DEFAULT_INTERVAL_MS = 30_000;

export function createAddressWatcher(options: AddressWatchOptions): AddressWatcher {
  // The set last *acted on*, as a canonical key. `null` means "never", which
  // is distinct from "empty": the first check must act — and say so — even on
  // a machine with no network yet, because silence there was the original bug.
  let known: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight = false;

  const check = async (): Promise<void> => {
    // `advertise` withdraws and rebinds a socket; a tick that lands while one
    // is still doing that must not start a second. The skipped tick loses
    // nothing — the next one sees the same table and acts then.
    if (inflight) return;
    const current = [...options.addresses()].sort();
    const key = current.join(",");
    if (key === known) return;
    inflight = true;
    try {
      if (current.length === 0) {
        options.log?.("no LAN addresses — advertising paused until a network appears");
        await options.withdraw();
      } else {
        const ok = await options.advertise();
        options.log?.(
          ok
            ? `advertising on ${current.join(", ")}`
            : "could not advertise — pairing by typed address still works",
        );
      }
      // Recorded even when advertising failed: the failure is tied to this
      // network state (port 5353 taken, multicast off), so retrying every
      // five seconds would log the same sentence forever. The next *change*
      // tries again, which is also what heals a responder freed later.
      known = key;
    } catch (error) {
      // An advertise that throws (a malformed record) is logged and not
      // recorded, so it does not read as "advertising" to anyone — but the
      // watcher itself must survive it, or one bad tick ends discovery.
      options.log?.(`advertise failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inflight = false;
    }
  };

  return {
    check,
    start: (intervalMs = DEFAULT_INTERVAL_MS) => {
      if (timer) return;
      timer = setInterval(() => void check(), intervalMs);
      // discovery upkeep must never be what keeps the process alive
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
