import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { MESSAGE_PAGE_SIZE } from "./message-history";
import { visibleMessages, type Bot, type Message } from "./store";
import { useStoreDispatch, useStoreSelector } from "./store-select";
import { inChatHistory } from "../../shared/chat-history";

type Page = { messages: Message[]; hasMore: boolean };

// The raw Store remains the source of live messages and patches. Compact pages have their own cursor.
export function useChatHistory(bot: Bot) {
  const dispatch = useStoreDispatch();
  const seed = bot.chatPage?.threadId === bot.threadId ? bot.chatPage : undefined;
  const generation = useStoreSelector(s => s.transcriptGeneration[bot.threadId] ?? 0);
  const focusId = useStoreSelector(s => s.focusMessage?.threadId === bot.threadId ? s.focusMessage.messageId : undefined);
  const [loaded, setLoaded] = useState<{ page: Page; generation: number; threadId: string }>();
  const page = loaded?.generation === generation && loaded.threadId === bot.threadId ? loaded.page : seed;
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const threadId = bot.threadId;
  const read = useCallback(async (before?: string, through?: string) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const pages: Message[][] = [];
      let cursor = before;
      let result: Page;
      let found = false;
      do {
        const suffix = cursor ? "&before=" + encodeURIComponent(cursor) : "";
        result = await api<Page>(`/api/threads/${threadId}/messages?view=chat&limit=${MESSAGE_PAGE_SIZE}${suffix}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        pages.push(result.messages);
        found = Boolean(through && result.messages.some(message => message.id === through));
        const next = result.messages[0]?.id;
        if (!next || next === cursor) break;
        cursor = next;
      } while (through && !found && result.hasMore);
      const incoming = pages.reverse().flat();
      setLoaded(previous => {
        const current = previous?.generation === generation && previous.threadId === threadId ? previous.page : seed;
        const messages = before ? [...incoming, ...(current?.messages ?? [])] : incoming;
        return { generation, threadId, page: { ...result, messages } };
      });
      if (found && through) dispatch({ type: "focusMessage", threadId, messageId: through });
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: "error", message: String(error) });
    } finally {
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  }, [threadId, dispatch, generation, seed]);
  useEffect(() => {
    if (seed) setPending(false);
    else void read();
    return () => { request.current?.abort(); request.current = null; };
  }, [read, seed]);
  const raw = useMemo(() => bot.activeLeafId && !bot.messages.some(m => m.id === bot.activeLeafId)
    ? [] : visibleMessages(bot), [bot.messages, bot.activeLeafId]);
  const history = useMemo(() => {
    const merged = new Map(page?.messages.map(message => [message.id, bot.chatPatches?.get(message.id) ?? message]));
    for (const message of raw) merged.set(message.id, message);
    const messages = page ? [...merged.values()].sort((a, b) => a.at - b.at) : raw;
    const latestRequestIndex = messages.findLastIndex(message => message.role === "user");
    return messages.filter((message, index) => inChatHistory(message, latestRequestIndex === -1 ? Boolean(page || bot.busy) : index > latestRequestIndex) || message.id === focusId);
  }, [raw, page, bot.busy, bot.chatPatches, focusId]);
  const load = useCallback(() => void read(page?.messages[0]?.id), [read, page]);
  const jumpTo = useCallback((messageId: string, loaded: boolean) => {
    if (loaded) dispatch({ type: "focusMessage", threadId, messageId });
    else if (page?.hasMore) void read(page.messages[0]?.id, messageId);
  }, [dispatch, threadId, page, read]);
  return { history, pending, load, jumpTo, hasMore: page?.hasMore ?? false };
}
