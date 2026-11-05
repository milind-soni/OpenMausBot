// Keeps the Bonjour record in step with the network. Polled: Node has no
// portable "interfaces changed" signal. Only the set of addresses matters, so
// re-announcing happens exactly on transitions.
export interface AddressWatchOptions {
  addresses: () => string[];
  /** The advertised name: a rename re-advertises like an address change. */
  name?: () => string;
  /** Resolves false when the responder could not start (port 5353 busy,
   * multicast off): a condition, never an error. */
  advertise: () => Promise<boolean>;
  /** Withdraw the record and close the responder, so caches forget us rather
   * than pointing phones at addresses we no longer hold. */
  withdraw: () => Promise<void>;
  log?: (line: string) => void;
}

export interface AddressWatcher {
  /** One comparison of the address set against what was last acted on. */
  check: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

/** Networks change on the minutes scale, and this is the sidecar's only
 * recurring wakeup. */
const DEFAULT_INTERVAL_MS = 30_000;

export function createAddressWatcher(options: AddressWatchOptions): AddressWatcher {
  // The set last acted on. `null` (never) differs from empty: the first check
  // must act even on a machine with no network yet.
  let known: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight = false;

  const check = async (): Promise<void> => {
    // `advertise` withdraws and rebinds a socket; a tick that lands meanwhile
    // must not start a second.
    if (inflight) return;
    const current = [...options.addresses()].sort();
    const key = `${options.name?.() ?? ""}\n${current.join(",")}`;
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
      // network state, so only the next change retries.
      known = key;
    } catch (error) {
      // A throw is logged and not recorded, and the watcher survives it.
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
