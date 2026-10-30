import { useEffect, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";

// The find bar belongs to ChatView, but the chat's ⋯ menu can sit outside it (the bot panel's top bar in Simple
// mode). A request names its thread, so a menu left over from another chat never opens this one's bar.
const requests = new Set<(threadId: string) => void>();
const watchers = new Set<() => void>();
let openThreadId: string | null = null;

/** Opens the find bar of the chat showing this thread, or closes it when it is already open. */
export function requestChatFind(threadId: string): void {
  for (const request of Array.from(requests)) request(threadId);
}

function publish(next: string | null) {
  if (next === openThreadId) return;
  openThreadId = next;
  for (const watch of Array.from(watchers)) watch();
}

/** ChatView's side: answers requests for its thread and tells menus elsewhere whether its bar is open. */
export function useChatFindRequests(threadId: string, open: boolean, setOpen: Dispatch<SetStateAction<boolean>>): void {
  useEffect(() => {
    const request = (target: string) => {
      if (target === threadId) setOpen((current) => !current);
    };
    requests.add(request);
    return () => {
      requests.delete(request);
    };
  }, [threadId, setOpen]);
  useEffect(() => {
    if (!open) return;
    publish(threadId);
    return () => {
      if (openThreadId === threadId) publish(null);
    };
  }, [threadId, open]);
}

function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/** Whether the find bar is open on this thread, for a menu that shows Find in conversation as on. */
export function useChatFindOpen(threadId: string): boolean {
  return useSyncExternalStore(subscribe, () => openThreadId === threadId, () => false);
}
