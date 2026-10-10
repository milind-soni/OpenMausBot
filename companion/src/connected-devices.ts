/** Count live authenticated event streams per device. A phone may briefly
 * overlap old and replacement streams while changing routes, so presence is a
 * reference count rather than a boolean. */
export function createConnectedDeviceTracker() {
  interface ConnectedStream {
    closed: boolean;
    terminate: () => void;
  }

  const streams = new Map<string, Set<ConnectedStream>>();

  const open = (deviceId: string, terminate: () => void = () => {}): (() => void) => {
    const active = streams.get(deviceId) ?? new Set<ConnectedStream>();
    const stream = { closed: false, terminate };
    active.add(stream);
    streams.set(deviceId, active);
    return () => {
      if (stream.closed) return;
      stream.closed = true;
      const current = streams.get(deviceId);
      current?.delete(stream);
      if (current?.size === 0) streams.delete(deviceId);
    };
  };

  const ids = (): string[] => [...streams.keys()];

  const disconnect = (deviceId: string): boolean => {
    const active = streams.get(deviceId);
    if (!active) return false;
    // Remove presence before terminating sockets. Their close handlers call
    // the per-stream cleanup again, which must be an idempotent no-op.
    streams.delete(deviceId);
    for (const stream of active) {
      if (stream.closed) continue;
      stream.closed = true;
      try {
        stream.terminate();
      } catch {
        // One broken socket must not keep the other revoked streams alive.
      }
    }
    return true;
  };

  return Object.freeze({ open, ids, disconnect });
}
