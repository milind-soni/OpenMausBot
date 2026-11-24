import { sameFields, sameItems } from "@/state/store-select";
import type { AppState, Bot } from "@/state/store";

const NO_QUEUED: AppState["pendingQueued"] = {};
const NO_RUNS: NonNullable<AppState["routineRuns"]> = [];

/** What the sidebar list draws: a change anywhere else in the store leaves it alone. */
export const sidebarState = (s: AppState) => ({
  bots: s.bots, groups: s.groups, sections: s.sections, pendingQueued: s.pendingQueued, instances: s.instances, config: s.config, selectedId: s.selectedId, newChat: s.newChat,
  activeView: s.activeView, computerOpen: s.computerOpen, inspectorOpen: s.inspectorOpen, deletingBots: s.deletingBots, revealThread: s.revealThread,
  liveCall: s.liveCall, cloudHowTo: s.cloudHowTo, routineRuns: s.routineRuns, mascotMotion: s.activeView === "chat" && s.mascotMotion?.botId === s.selectedId ? s.mascotMotion : null,
});

export function botPendingQueued(bot: Pick<Bot, "threadId" | "tasks">, pendingQueued: AppState["pendingQueued"]): AppState["pendingQueued"] {
  let scoped: Record<string, AppState["pendingQueued"][string]> | null = null;
  const include = (threadId: string) => {
    const entries = pendingQueued[threadId];
    if (!entries?.length) return;
    (scoped ??= {})[threadId] = entries;
  };
  include(bot.threadId);
  for (const task of bot.tasks ?? []) include(task.threadId);
  return scoped ?? NO_QUEUED;
}

export function botRoutineRuns(bot: Pick<Bot, "id" | "threadId" | "tasks">, routineRuns: AppState["routineRuns"]): AppState["routineRuns"] {
  if (!routineRuns?.length) return NO_RUNS;
  const threadIds = new Set<string>([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
  const runs = routineRuns.filter((run) => run.botId === bot.id || (run.threadId !== undefined && threadIds.has(run.threadId)));
  return runs.length ? runs : NO_RUNS;
}

export function sameBotRowProps<T extends { pendingQueued: AppState["pendingQueued"]; routineRuns?: AppState["routineRuns"] }>(previous: T, next: T): boolean {
  const { pendingQueued: prevQueued, routineRuns: prevRuns = NO_RUNS, ...prevRest } = previous;
  const { pendingQueued: nextQueued, routineRuns: nextRuns = NO_RUNS, ...nextRest } = next;
  return sameFields(prevRest, nextRest) && sameFields(prevQueued, nextQueued) && sameItems(prevRuns, nextRuns);
}
