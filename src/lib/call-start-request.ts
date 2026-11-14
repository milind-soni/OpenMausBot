import type { CallMode } from "./call-mode";

// The Simple composer picks a call mode from its + menu, away from the call button that owns the start logic
// (voice set-up, Live key and Pro prompts, the unavailable help). The button listens here and starts the call
// exactly as its own call-mode menu would.
const listeners = new Map<string, Set<(mode: CallMode) => void>>();

export function requestCallStart(targetId: string, mode: CallMode): void {
  for (const listener of Array.from(listeners.get(targetId) ?? [])) listener(mode);
}

export function onCallStartRequest(targetId: string, listener: (mode: CallMode) => void): () => void {
  const set = listeners.get(targetId) ?? new Set();
  set.add(listener);
  listeners.set(targetId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(targetId) === set) listeners.delete(targetId);
  };
}
