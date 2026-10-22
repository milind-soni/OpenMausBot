// Rows are `display: contents` wrappers with no box, so their last child is what gets scrolled and highlighted.
import { useEffect } from "react";
import { api, useStore, type Action, type AppState } from "@/state/store";
import type { SearchHit } from "@/lib/search-hit";
import { t } from "@/lib/i18n";

const FLASH_CLASSES = ["ring-2", "ring-accent/70", "rounded-2xl", "transition-shadow"];

export async function landOnSearchHit(
  hit: SearchHit,
  state: Pick<AppState, "bots" | "groups">,
  dispatch: React.Dispatch<Action>,
  threadsShown: boolean,
): Promise<void> {
  const ownerId = hit.botId ?? hit.groupId;
  const bot = hit.botId ? state.bots.find((candidate) => candidate.id === hit.botId) : undefined;
  const group = hit.groupId ? state.groups.find((candidate) => candidate.id === hit.groupId) : undefined;
  if (!ownerId || (!bot && !group)) throw new Error(t("chat.conversationGone"));

  const switchAlone = bot && bot.threadId !== hit.threadId && !threadsShown ? bot : undefined;
  if (!switchAlone) dispatch({ type: "select", id: ownerId });
  if (bot && bot.threadId !== hit.threadId && !switchAlone) {
    const result = await api(`/api/bots/${bot.id}/tasks/${hit.threadId}`, { method: "POST" });
    if (result?.bot) dispatch({ type: "taskSwitched", bot: result.bot });
  }
  if (group && group.threadId !== hit.threadId) {
    const result = await api(`/api/groups/${group.id}/tasks/${hit.threadId}`, { method: "POST" });
    if (result?.group) dispatch({ type: "groupPatched", group: result.group });
  }
  if (bot && !hit.onActivePath) {
    const branch = await api(`/api/bots/${bot.id}/active-branch`, {
      method: "POST",
      body: JSON.stringify({ messageId: hit.messageId, threadId: hit.threadId }),
    });
    if (branch?.activeLeafId) {
      dispatch({ type: "threadActive", threadId: hit.threadId, activeLeafId: branch.activeLeafId });
    }
  }
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

export function useFocusMessage(threadId: string, ready: boolean) {
  const { state, dispatch } = useStore();
  const focus = state.focusMessage;
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
      const wrapper = document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(focus.messageId)}"]`);
      const row = wrapper?.lastElementChild as HTMLElement | null;
      target = focus.matchText ? row?.querySelector<HTMLElement>("[data-chat-bubble]") ?? row : row;
      if (!target) {
        if (tries++ < 20) retryTimer = setTimeout(attempt, 100);
        return;
      }
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      target.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      target.classList.add(...FLASH_CLASSES);
      const textRoots = target.querySelectorAll<HTMLElement>(".chat-md, .chat-text");
      const textRoot = textRoots.item(textRoots.length - 1) ?? target;
      const range = matchRange(textRoot, focus.matchText ?? "");
      if (range && CSS.highlights) {
        highlight = new Highlight(range);
        CSS.highlights.set("search-result-text", highlight);
        scrollFrame = requestAnimationFrame(() => {
          const scroller = target?.closest<HTMLElement>(".overflow-y-auto");
          if (!scroller) return;
          const match = range.getBoundingClientRect();
          const viewport = scroller.getBoundingClientRect();
          scroller.scrollTop += match.top + match.height / 2 - viewport.top - viewport.height / 2;
        });
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
