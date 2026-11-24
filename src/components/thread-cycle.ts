import { useEffect } from "react";
import { threadCycleStep } from "@/lib/keyboard-shortcuts";
import { newChatThreadId } from "@/state/new-chat";
import type { AppState } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { openTabId, threadTabs, type TabsBot } from "./thread-tabs";

interface CycleTarget { botId: string; open: string; order: string[] }

export const threadCycleOrder = (bot: TabsBot): string[] => threadTabs(bot).filter((tab) => !tab.draft).map((tab) => tab.threadId);

export function nextCycleThread(order: readonly string[], open: string, step: 1 | -1): string | null {
  const at = order.indexOf(open);
  if (at < 0) return order[step > 0 ? 0 : order.length - 1] ?? null;
  if (order.length < 2) return null;
  return order[(at + step + order.length) % order.length]!;
}

function cycleTarget(state: AppState): CycleTarget | null {
  if (state.activeView !== "chat" || state.shortcutsOpen) return null;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId && !candidate.hidden);
  if (!bot) return null;
  const open = state.newChat?.botId === bot.id ? newChatThreadId(bot.id) : openTabId(bot);
  return { botId: bot.id, open, order: threadCycleOrder(bot) };
}

const sameTarget = (a: CycleTarget | null, b: CycleTarget | null) =>
  a === b || (a !== null && b !== null && a.botId === b.botId && a.open === b.open && a.order.join("\n") === b.order.join("\n"));

export function useThreadCycleKeys(): void {
  const dispatch = useStoreDispatch();
  const target = useStoreSelector(cycleTarget, sameTarget);
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
