// Webhook and app-event automations that keep one conversation (sameConversation): each run continues the conversation
// its trigger's run before worked in. Runs of such a trigger take turns in it (sameRoutineWorking in routines.ts).
import type { RoutineRun } from "./routines.ts";

/** The conversation the same trigger's latest earlier run for this bot worked in; null for its first run. `runs` newest first (listRuns). */
export function previousEventThread(runs: readonly RoutineRun[], run: Pick<RoutineRun, "id" | "webhookId" | "botId">): string | null {
  if (!run.webhookId) return null;
  return runs.find((other) => other.id !== run.id && other.webhookId === run.webhookId && other.botId === run.botId && other.threadId)?.threadId ?? null;
}

/** The conversation a run that keeps one conversation joins. Gone (deleted) or never there: null, so this run starts a
 *  new conversation and the next run continues that one. */
export function continuedConversation(runs: readonly RoutineRun[], run: RoutineRun, exists: (threadId: string) => boolean): string | null {
  const previous = run.target === "bot" ? previousEventThread(runs, run) : null;
  return previous && exists(previous) ? previous : null;
}
