import { useSyncExternalStore } from "react";

const operationCounts = new Map<string, number>();
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

/**
 * Keep browser mutations locked across the compact/expanded React handoff.
 * Both panels are short-lived views over the same native page, so component
 * state alone cannot represent an operation that outlives either panel.
 */
export function beginBrowserPanelOperation(botId: string): () => void {
  operationCounts.set(botId, (operationCounts.get(botId) ?? 0) + 1);
  notifyListeners();

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const remaining = (operationCounts.get(botId) ?? 1) - 1;
    if (remaining > 0) operationCounts.set(botId, remaining);
    else operationCounts.delete(botId);
    notifyListeners();
  };
}

export function browserPanelOperationPending(botId: string): boolean {
  return (operationCounts.get(botId) ?? 0) > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBrowserPanelOperationPending(botId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => browserPanelOperationPending(botId),
    () => false,
  );
}
