// Rows are `display: contents` wrappers with no box, so their last child is what gets scrolled and highlighted.
import { useEffect, type RefObject } from "react";
import { api, MESSAGE_PAGE_SIZE, visibleMessages, type Action, type AppState, type Message } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import type { SearchHit } from "@/lib/search-hit";
import { t } from "@/lib/i18n";

const FLASH_CLASSES = ["ring-2", "ring-accent/70", "rounded-2xl", "transition-shadow"];

async function loadThroughMessage(
  owner: { threadId: string; messages: Message[]; hasMore?: boolean; needsHistory?: boolean },
  messageId: string,
  generation: number,
  dispatch: React.Dispatch<Action>,
  signal?: AbortSignal,
): Promise<void> {
  if (owner.messages.some((message) => message.id === messageId)) return;
  const older: Message[] = [];
  const cold = owner.needsHistory === true;
  let before = cold ? undefined : owner.messages[0]?.id;
  let hasMore = cold || Boolean(before && owner.hasMore);
  let activeLeafId: string | null | undefined;
  while (hasMore) {
    const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
    const page = await api<{ messages?: Message[]; hasMore?: boolean; activeLeafId?: string | null }>(
      `/api/threads/${owner.threadId}/messages?limit=${MESSAGE_PAGE_SIZE}${cursor}`,
      signal ? { signal } : undefined,
    );
    signal?.throwIfAborted();
    const messages = page.messages ?? [];
    older.unshift(...messages);
    if (!before) activeLeafId = page.activeLeafId;
    hasMore = Boolean(page.hasMore) && messages.length > 0;
    if (messages.some((message) => message.id === messageId)) break;
    before = messages[0]?.id;
  }
  if (older.length) dispatch({
    type: "olderMessages", threadId: owner.threadId, generation, messages: older, hasMore,
    ...(cold ? { tailLoaded: true, activeLeafId } : {}),
  });
}

export async function landOnSearchHit(
  hit: SearchHit,
  state: Pick<AppState, "bots" | "groups" | "transcriptGeneration">,
  dispatch: React.Dispatch<Action>,
  threadsShown: boolean,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const ownerId = hit.botId ?? hit.groupId;
  const bot = hit.botId ? state.bots.find((candidate) => candidate.id === hit.botId) : undefined;
  const group = hit.groupId ? state.groups.find((candidate) => candidate.id === hit.groupId) : undefined;
  if (!ownerId || (!bot && !group)) throw new Error(t("chat.conversationGone"));

  const switchAlone = bot && bot.threadId !== hit.threadId && !threadsShown ? bot : undefined;
  if (!switchAlone) dispatch({ type: "select", id: ownerId });
  if (bot && bot.threadId !== hit.threadId && !switchAlone) {
    const result = await api(`/api/bots/${bot.id}/tasks/${hit.threadId}`, { method: "POST" });
    signal?.throwIfAborted();
    if (result?.bot) dispatch({ type: "taskSwitched", bot: result.bot });
  }
  if (group && group.threadId !== hit.threadId) {
    const result = await api(`/api/groups/${group.id}/tasks/${hit.threadId}`, { method: "POST" });
    signal?.throwIfAborted();
    if (result?.group) dispatch({ type: "groupPatched", group: result.group });
  }
  const open = bot?.threadId === hit.threadId ? bot : group?.threadId === hit.threadId ? group : undefined;
  if (open) await loadThroughMessage(open, hit.messageId, state.transcriptGeneration[hit.threadId] ?? 0, dispatch, signal);
  const onActivePath = bot?.threadId === hit.threadId && bot.messages.some(message => message.id === hit.messageId)
    ? visibleMessages(bot).some(message => message.id === hit.messageId) : hit.onActivePath;
  if (bot && !onActivePath) {
    const branch = await api(`/api/bots/${bot.id}/active-branch`, {
      method: "POST",
      body: JSON.stringify({ messageId: hit.messageId, threadId: hit.threadId }),
      signal,
    });
    signal?.throwIfAborted();
    if (branch?.activeLeafId) {
      dispatch({ type: "threadActive", threadId: hit.threadId, activeLeafId: branch.activeLeafId });
    }
  }
  signal?.throwIfAborted();
  if (switchAlone) dispatch({ type: "switchTask", botId: switchAlone.id, threadId: hit.threadId, whole: true });
  dispatch({
    type: "focusMessage",
    threadId: hit.threadId,
    messageId: hit.messageId,
    matchText: hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength),
  });
}

function matchRange(root: HTMLElement, text: string): Range | null {
  const needle = text.trim();
  if (!needle) return null;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let rendered = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    nodes.push(node);
    rendered += node.data;
  }
  const pattern = needle.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const match = new RegExp(pattern, "iu").exec(rendered);
  if (!match) return null;
  const range = document.createRange();
  let offset = 0;
  for (const node of nodes) {
    const end = offset + node.length;
    if (match.index >= offset && match.index < end) range.setStart(node, match.index - offset);
    if (match.index + match[0].length <= end) {
      range.setEnd(node, match.index + match[0].length - offset);
      return range;
    }
    offset = end;
  }
  return null;
}

export function useFocusMessage(threadId: string, ready: boolean, rootRef?: RefObject<HTMLElement | null>) {
  const focus = useStoreSelector((state) => state.focusMessage), dispatch = useStoreDispatch();
  useEffect(() => {
    if (!focus || focus.consumed || focus.threadId !== threadId || !ready) return;
    let tries = 0;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollFrame: number | null = null;
    let target: HTMLElement | null = null;
    let highlight: Highlight | null = null;
    const attempt = () => {
      if (cancelled) return;
      const wrapper = (rootRef ? rootRef.current : document)?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(focus.messageId)}"]`);
      const row = wrapper?.lastElementChild as HTMLElement | null;
      target = focus.matchText ? row?.querySelector<HTMLElement>("[data-chat-bubble]") ?? row : row;
      if (!row || !target) {
        if (tries++ < 20) retryTimer = setTimeout(attempt, 100);
        return;
      }
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      target.classList.add(...FLASH_CLASSES);
      // A reply split into bubbles and table cards has several text roots; a quoted reply's text is not the message's.
      const found = row.querySelectorAll<HTMLElement>(".chat-md, .chat-text");
      const textRoots: HTMLElement[] = [];
      for (let index = 0; index < found.length; index++) {
        const root = found.item(index);
        if (root && !root.closest?.("[data-reply-quote]")) textRoots.push(root);
      }
      let range: Range | null = null;
      for (const root of textRoots.length ? textRoots : [target]) if ((range = matchRange(root, focus.matchText ?? ""))) break;
      if (range) {
        if (CSS.highlights && typeof Highlight !== "undefined") {
          highlight = new Highlight(range);
          CSS.highlights.set("search-result-text", highlight);
        }
        scrollFrame = requestAnimationFrame(() => {
          const scroller = rootRef?.current ?? target?.closest<HTMLElement>(".overflow-y-auto");
          if (!scroller) { target?.scrollIntoView({ block: "center", behavior: "instant" }); return; }
          const match = range.getBoundingClientRect();
          const viewport = scroller.getBoundingClientRect();
          scroller.scrollTo({ top: scroller.scrollTop + match.top + match.height / 2 - viewport.top - viewport.height / 2, behavior: "instant" });
        });
      } else {
        target.scrollIntoView({ block: "center", behavior: focus.matchText?.trim() ? "instant" : reducedMotion ? "auto" : "smooth" });
      }
      // `consumed` is deliberately not a dependency, so this flash survives the bookkeeping update.
      dispatch({ type: "focusMessageConsumed", nonce: focus.nonce });
      flashTimer = setTimeout(() => target?.classList.remove(...FLASH_CLASSES), 1800);
    };
    attempt();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (flashTimer) clearTimeout(flashTimer);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      target?.classList.remove(...FLASH_CLASSES);
      if (highlight && CSS.highlights.get("search-result-text") === highlight) CSS.highlights.delete("search-result-text");
    };
  }, [dispatch, focus?.nonce, focus?.threadId, focus?.messageId, threadId, ready]);
}
