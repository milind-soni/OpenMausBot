// Whether this server can give a bot a Local VM: a supported container runtime is installed on the host. A runtime
// whose daemon is down still counts, since a turn that needs the VM starts a stopped Podman machine itself. The answer
// is kept, so the tools a conversation is listed do not change from turn to turn; while it is "no" it is read again at
// most once a minute, so a runtime installed later shows up without a restart.
export interface LocalVmRuntimeStatus {
  available?: readonly string[];
  daemonUp?: boolean;
}

const RECHECK_MS = 60_000;

export function createLocalVmAvailability(probe: () => Promise<LocalVmRuntimeStatus>, now: () => number = Date.now) {
  let usable = true;
  let checkedAt = 0;
  let checking = false;
  const check = () => {
    if (checking) return;
    checking = true;
    checkedAt = now();
    void probe()
      .then((status) => {
        const available = Array.isArray(status?.available) ? status.available : null;
        if (available) usable = available.length > 0;
      })
      .catch(() => {})
      .finally(() => { checking = false; });
  };
  check();
  return {
    available: () => {
      if (!usable && now() - checkedAt >= RECHECK_MS) check();
      return usable;
    },
  };
}
