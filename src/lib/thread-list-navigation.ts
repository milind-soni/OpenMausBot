import { useSyncExternalStore } from "react";

let request: { botId: string; revision: number } | null = null;
let revision = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function requestThreadList(botId: string): void {
  request = { botId, revision: ++revision };
  notify();
}

export function useThreadListRequest(botId: string): number {
  return useSyncExternalStore(subscribe, () => request?.botId === botId ? request.revision : 0, () => 0);
}

export function consumeThreadListRequest(botId: string, expected: number): void {
  if (request?.botId !== botId || request.revision !== expected) return;
  request = null;
  notify();
}
