import { useCallback, useSyncExternalStore } from "react";
import { selectedOwner, shortHeld } from "./message-history";
import type { Action, AppState, Message } from "./store";

/** The conversations the last snapshot sent as a short tail, by the first row it sent, until the page before the tail
 * is asked for. */
const tails = new Map<string, string>();

export function noteSnapshotTails(owners: Iterable<{ threadId: string; messages: readonly { id: string }[] }>): void {
  tails.clear();
  for (const owner of owners) if (owner.messages[0]) tails.set(owner.threadId, owner.messages[0].id);
}

/**
 * Asks for the page before a snapshot's tail once the conversation is selected however that happens (a click, the team
 * map's computer, a bot's settings, a deletion moving the selection), or once its branch moves anywhere but onto a new
 * newest row (another client switching branches), since the rest of that branch may lie before the tail. Every request
 * goes through `loadOlderMessages`.
 */
export function followHeldTails(store: { getState(): AppState; subscribe(listener: () => void): () => void }, dispatch: (action: Action) => void): () => void {
  const leaves = new Map<string, string | null | undefined>();
  const check = () => {
    if (!tails.size) return;
    const state = store.getState();
    const selected = selectedOwner(state);
    for (const owner of [...state.bots, ...state.groups]) {
      if (tails.get(owner.threadId) !== owner.messages[0]?.id || !shortHeld(owner)) continue;
      const leaf = "activeLeafId" in owner ? owner.activeLeafId : undefined;
      const moved = leaves.has(owner.threadId) && leaves.get(owner.threadId) !== leaf;
      leaves.set(owner.threadId, leaf);
      if (state.loadingOlder[owner.threadId] || (owner !== selected && !(moved && leaf !== owner.messages.at(-1)?.id))) continue;
      tails.delete(owner.threadId);
      queueMicrotask(() => dispatch({ type: "loadOlderMessages", threadId: owner.threadId }));
    }
  };
  check();
  return store.subscribe(check);
}

/** Each pinnable page's newest version as live frames carry it, whether or not its row is held. */
const pageVersions = new Map<string, string>();
const pageListeners = new Set<() => void>();
const pageKey = (threadId: string, messageId: string) => `${threadId}:${messageId}`;

export function noteAppPagePatch(threadId: string, message: Pick<Message, "id" | "app">): void {
  if (!message.app) return;
  const version = `${message.app.doc}:${message.app.rev ?? 0}`;
  const key = pageKey(threadId, message.id);
  if (pageVersions.get(key) === version) return;
  pageVersions.delete(key);
  pageVersions.set(key, version);
  if (pageVersions.size > 100) pageVersions.delete(pageVersions.keys().next().value!);
  for (const listener of pageListeners) listener();
}

/** The version the newest frame gave a page in a chat, "" before any frame named it. */
export function useAppPagePatch(threadId: string, messageId: string): string {
  const subscribe = useCallback((listener: () => void) => {
    pageListeners.add(listener);
    return () => { pageListeners.delete(listener); };
  }, []);
  return useSyncExternalStore(subscribe, () => pageVersions.get(pageKey(threadId, messageId)) ?? "", () => "");
}
