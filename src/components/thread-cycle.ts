import { useCallback, useEffect } from "react";
import { useAdvancedMode } from "@/lib/interface-mode";
import { threadCycleStep } from "@/lib/keyboard-shortcuts";
import { newChatThreadId } from "@/state/new-chat";
import type { AppState } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { mainThreadFirst } from "./SidebarThreadRow";
import { openTabId, threadTabs, type TabsBot } from "./thread-tabs";

interface CycleTarget { botId: string; open: string; order: string[] }

/** The order the person sees: the header tabs', or in Simple mode the thread pill's and the sidebar's, main thread first. */
export const threadCycleOrder = (bot: TabsBot, mainFirst = false): string[] => {
  const tabs = threadTabs(bot).filter((tab) => !tab.draft);
  return (mainFirst ? mainThreadFirst(tabs, bot.mainThreadId) : tabs).map((tab) => tab.threadId);
};

export function nextCycleThread(order: readonly string[], open: string, step: 1 | -1): string | null {
  const at = order.indexOf(open);
  if (at < 0) return order[step > 0 ? 0 : order.length - 1] ?? null;
  if (order.length < 2) return null;
  return order[(at + step + order.length) % order.length]!;
}

function cycleTarget(state: AppState, mainFirst: boolean): CycleTarget | null {
  if (state.activeView !== "chat" || state.shortcutsOpen) return null;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId && !candidate.hidden);
  if (!bot) return null;
  const open = state.newChat?.botId === bot.id ? newChatThreadId(bot.id) : openTabId(bot);
  return { botId: bot.id, open, order: threadCycleOrder(bot, mainFirst) };
}

const sameTarget = (a: CycleTarget | null, b: CycleTarget | null) =>
  a === b || (a !== null && b !== null && a.botId === b.botId && a.open === b.open && a.order.join("\n") === b.order.join("\n"));

export function useThreadCycleKeys(): void {
  const dispatch = useStoreDispatch();
  const simple = !useAdvancedMode();
  const target = useStoreSelector(useCallback((state: AppState) => cycleTarget(state, simple), [simple]), sameTarget);
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      const step = threadCycleStep(event);
      if (step === null) return;
      event.preventDefault();
      if (event.repeat) return;
      const next = nextCycleThread(target.order, target.open, step);
      if (next && next !== target.open) dispatch({ type: "switchTask", botId: target.botId, threadId: next });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, dispatch]);
}
