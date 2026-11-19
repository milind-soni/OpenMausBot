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
  const read = useCallback(async (before?: string) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const suffix = before ? "&before=" + encodeURIComponent(before) : "";
      const result = await api<Page>(`/api/threads/${threadId}/messages?view=chat&limit=${MESSAGE_PAGE_SIZE}${suffix}`, { signal: controller.signal });
      if (!controller.signal.aborted) setLoaded(previous => {
        const current = previous?.generation === generation && previous.threadId === threadId ? previous.page : seed;
        const messages = before ? [...result.messages, ...(current?.messages ?? [])] : result.messages;
        return { generation, threadId, page: { ...result, messages } };
      });
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: "error", message: String(error) });
    } finally {
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  }, [threadId, dispatch, generation, seed]);
  useEffect(() => {
    if (!seed) void read();
    return () => { request.current?.abort(); request.current = null; };
  }, [read, seed]);
  const raw = useMemo(() => bot.activeLeafId && !bot.messages.some(m => m.id === bot.activeLeafId)
    ? [] : visibleMessages(bot), [bot.messages, bot.activeLeafId]);
  const history = useMemo(() => {
    const workingFrom = bot.busy ? raw.findLastIndex(m => m.role === "user") : raw.length;
    const local = raw.filter((m, index) => inChatHistory(m) || m.id === focusId || index >= workingFrom);
    if (!page) return local;
    const merged = new Map(page.messages.map(message => [message.id, bot.chatPatches?.get(message.id) ?? message]));
    for (const message of local) merged.set(message.id, message);
    return [...merged.values()].sort((a, b) => a.at - b.at);
  }, [raw, page, bot.busy, bot.chatPatches, focusId]);
  const load = useCallback(() => void read(page?.messages[0]?.id), [read, page]);
  return { history, pending, load, hasMore: page?.hasMore ?? false };
}
