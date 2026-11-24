import { useEffect } from "react";
import { threadCycleStep } from "@/lib/keyboard-shortcuts";
import type { AppState, Bot, Task } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { byPinOrder, ownThread } from "./sidebar-thread-labels";
import { isArchived, isSnoozed, orderedThreadList } from "./SidebarThreadRow";

type CycleBot = Pick<Bot, "threadId" | "switchingTo" | "mainThreadId" | "tasks">;
interface CycleTarget { botId: string; open: string; order: string[] }

export function threadCycleOrder(bot: Pick<CycleBot, "mainThreadId" | "tasks">): string[] {
  const open = (bot.tasks ?? []).filter((task) => !task.routineRunId && !isArchived(task) && !isSnoozed(task)
    && (ownThread(task) || task.pinned === true || task.threadId === bot.mainThreadId));
  const pinned = (task: Task) => task.pinned === true;
  return [...byPinOrder(open.filter(pinned)), ...orderedThreadList(open.filter((task) => !pinned(task)))].map((task) => task.threadId);
}

export function nextCycleThread(order: readonly string[], open: string, step: 1 | -1): string | null {
  const at = order.indexOf(open);
  if (at < 0) return order[step > 0 ? 0 : order.length - 1] ?? null;
  if (order.length < 2) return null;
  return order[(at + step + order.length) % order.length]!;
}

function cycleTarget(state: AppState): CycleTarget | null {
  if (state.activeView !== "chat" || state.shortcutsOpen) return null;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId && !candidate.hidden);
  return bot ? { botId: bot.id, open: bot.switchingTo ?? bot.threadId, order: threadCycleOrder(bot) } : null;
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
