import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChatCacheScope, clearChatCache, readChatCache, writeChatCache, type HistoryPage as Page } from "../lib/chat-cache";
import { api, ApiError } from "./api";
import { optimisticMessageId } from "./optimistic-send";
import { MESSAGE_PAGE_SIZE } from "./message-history";
import { visibleMessages, type Bot } from "./store";
import { useStoreDispatch, useStoreSelector } from "./store-select";
import { inChatHistory } from "../../shared/chat-history";

// The raw Store remains the source of live messages and patches. Compact pages have their own cursor.
export function useChatHistory(bot: Bot) {
  const dispatch = useStoreDispatch();
  const generation = useStoreSelector(s => s.transcriptGeneration[bot.threadId] ?? 0);
  const focusId = useStoreSelector(s => s.focusMessage?.threadId === bot.threadId ? s.focusMessage.messageId : undefined);
  const threadId = bot.threadId;
  const switching = Boolean(bot.awaitingThreadSnapshot && bot.switchingTo);
  const scope = useContext(ChatCacheScope);
  // Live tokens advance the leaf. Only a navigation/branch change starts a new history read.
  const visit = useMemo(() => ({ scope, threadId, leaf: bot.activeLeafId, baseline: new Set(bot.messages), patches: bot.chatPatches }),
    [scope, threadId, generation, switching]);
  const [loaded, setLoaded] = useState<{ visit: typeof visit; pages: Map<string, Page>; refused?: boolean }>();
  const pages = loaded?.visit === visit ? loaded.pages : undefined;
  const page = pages?.get("");
  const [pending, setPending] = useState(false);
  const requests = useRef(new Map<string, AbortController>());
  const read = useCallback(async (before = "", through?: string) => {
    if (requests.current.has(before)) return;
    const controller = new AbortController();
    requests.current.set(before, controller);
    if (before) setPending(true);
    let stored: Promise<Page | undefined> = Promise.resolve(undefined);
    let cursor = before;
    const seen = new Set<string>();
    try {
      do {
        seen.add(cursor);
        const slot = cursor;
        const key = JSON.stringify([threadId, slot ? visit.leaf : "latest", slot]);
        let answered = false;
        const apply = (result: Page) => {
          if (controller.signal.aborted) return;
          setLoaded(previous => {
            const current = previous?.visit === visit ? previous : undefined;
            const same = JSON.stringify(current?.pages.get(slot)) === JSON.stringify(result);
            if (same || current?.refused) return previous;
            const pages = new Map(current?.pages);
            if (!slot && !result.hasMore) pages.clear();
            if (!slot && result.hasMore && pages.size > 1) {
              const oldHead = pages.get("")?.messages ?? [];
              const overlap = oldHead.findIndex(message => message.id === result.messages[0]?.id);
              const olderKey = oldHead[0]?.id;
              const older = pages.get(olderKey);
              if (older && overlap > 0) {
                pages.delete(olderKey);
                pages.set(result.messages[0].id, { ...older, messages: [...older.messages, ...oldHead.slice(0, overlap)] });
              }
            }
            pages.set(slot, result);
            return { visit, pages };
          });
        };
        stored = scope ? readChatCache("pages", scope, key) : Promise.resolve(undefined);
        void stored.then(cached => {
          if (!answered && cached && (switching || !visit.leaf || !cached.activeLeafId || cached.activeLeafId === visit.leaf)) apply(cached);
        });
        if (switching) { await stored; return; }
        const suffix = slot ? "&before=" + encodeURIComponent(slot) : "";
        const result = await api<Page>(`/api/threads/${threadId}/messages?view=chat&limit=${MESSAGE_PAGE_SIZE}${suffix}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!Array.isArray(result.messages) || (result.hasMore !== undefined && typeof result.hasMore !== "boolean")) throw new Error("Invalid chat history");
        result.hasMore = Boolean(result.hasMore);
        answered = true;
        apply(result);
        if (scope) void stored.then(cached => {
          if (!controller.signal.aborted && JSON.stringify(cached) !== JSON.stringify(result)) {
            return writeChatCache("pages", scope, key, result);
          }
        });
        if (!through) break;
        if (result.messages.some(message => message.id === through)) {
          dispatch({ type: "focusMessage", threadId, messageId: through });
          break;
        }
        cursor = result.messages[0]?.id ?? "";
        if (!cursor || !result.hasMore) break;
      } while (!seen.has(cursor));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status) && !before) {
        setLoaded({ visit, pages: new Map(), refused: true });
        if (scope && [401, 403].includes(error.status)) void clearChatCache();
        if (scope && [404, 410].includes(error.status)) void writeChatCache("pages", scope,
          JSON.stringify([threadId, "latest", ""]), { messages: [], hasMore: false });
      } else if (await stored) return;
      if (!controller.signal.aborted) dispatch({ type: "error", message: String(error) });
    } finally {
      if (requests.current.get(before) === controller) {
        requests.current.delete(before);
        if (before) setPending(false);
      }
    }
  }, [threadId, dispatch, scope, visit, switching]);
  useEffect(() => {
    setPending(false);
    void read();
    const active = requests.current;
    return () => { for (const controller of active.values()) controller.abort(); active.clear(); };
  }, [read]);
  const combined = useMemo(() => {
    const older: Page[] = [];
    const seen = new Set<string>();
    let cursor = page?.messages[0]?.id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const previous = pages?.get(cursor);
      if (!previous) break;
      older.unshift(previous);
      cursor = previous.messages[0]?.id;
    }
    return { messages: [...older.flatMap(entry => entry.messages), ...(page?.messages ?? [])],
      hasMore: (older[0] ?? page)?.hasMore ?? false };
  }, [pages, page]);
  const raw = useMemo(() => bot.activeLeafId && !bot.messages.some(m => m.id === bot.activeLeafId)
    ? [] : visibleMessages(bot), [bot.messages, bot.activeLeafId]);
  const history = useMemo(() => {
    if (loaded?.visit === visit && loaded.refused) return [];
    const merged = new Map(combined.messages.map(message => {
      const patch = bot.chatPatches?.get(message.id);
      return [message.id, patch && patch !== visit.patches?.get(message.id) ? patch : message];
    }));
    for (const message of raw) {
      const optimistic = message.sendId && message.id === optimisticMessageId(message.sendId);
      if (!page || message.id === focusId || optimistic || !visit.baseline.has(message) || (bot.busy && message.id === bot.activeLeafId)) {
        merged.set(message.id, message);
      }
    }
    const messages = page ? [...merged.values()].sort((a, b) => a.at - b.at) : raw;
    const latestRequestIndex = messages.findLastIndex(message => message.role === "user");
    return messages.filter((message, index) => inChatHistory(message, latestRequestIndex === -1 ? Boolean(page || bot.busy) : index > latestRequestIndex) || message.id === focusId);
  }, [raw, page, combined, loaded, visit, bot.busy, bot.activeLeafId, bot.chatPatches, focusId]);
  const load = useCallback(() => void read(combined.messages[0]?.id), [read, combined]);
  const jumpTo = useCallback((messageId: string, loaded: boolean) => {
    if (loaded) dispatch({ type: "focusMessage", threadId, messageId });
    else if (combined.hasMore) void read(combined.messages[0]?.id, messageId);
  }, [dispatch, threadId, combined, read]);
  return { history, pending, load, jumpTo, hasMore: combined.hasMore };
}
