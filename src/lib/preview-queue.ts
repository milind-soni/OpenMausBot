/** Bound file loads and thumbnail parsers; full document rendering has its own lifecycle. */
export function createPreviewQueue(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return (signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const start = () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { abort(); return; }
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        waiting.shift()?.();
      });
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    if (active < limit) start(); else waiting.push(start);
  });
}

export const acquirePreviewSlot = createPreviewQueue(2);
