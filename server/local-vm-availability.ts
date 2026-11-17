// Whether this server can give a bot a Local VM: a supported container runtime is installed on the host
// and its daemon answers. The answer is read once and kept, so the tools a conversation is listed do
// not change from turn to turn.
export interface LocalVmRuntimeStatus {
  available?: readonly string[];
  daemonUp?: boolean;
}

export function createLocalVmAvailability(probe: () => Promise<LocalVmRuntimeStatus>) {
  let usable = true;
  void probe()
    .then((status) => {
      const available = Array.isArray(status?.available) ? status.available : null;
      if (available) usable = available.length > 0 && status.daemonUp === true;
    })
    .catch(() => {});
  return { available: () => usable };
}
