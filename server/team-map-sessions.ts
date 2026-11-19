import type { BotActivity, ModelSelection } from "../shared/wire.ts";
import type { TeamMapSession, TeamMapSessionState, TeamMapSessionsSnapshot } from "../shared/team-map-sessions.ts";

export const DEFAULT_STUCK_AFTER_MS = 10 * 60_000;

export interface TeamMapTaskInput {
  threadId: string;
  title: string;
  busy?: boolean;
  activity?: BotActivity;
  turnStartedAt?: number;
  modelSelection?: ModelSelection;
  usage?: { costUsd: number | null };
}

export interface TeamMapBotInput {
  id: string;
  modelSelection: ModelSelection;
  tasks: readonly TeamMapTaskInput[];
}

export interface TeamMapQueuedHandoff {
  targetBotId: string;
  threadId: string;
  groupId?: string;
}

export interface TeamMapSessionsDeps {
  bots: readonly TeamMapBotInput[];
  queued: readonly TeamMapQueuedHandoff[];
  lastOutputAt(threadId: string): number | undefined;
  groupIdOf(threadId: string): string | undefined;
  visibleGroup(groupId: string): boolean;
  createdAt(threadId: string): number | undefined;
  onPlan(instanceId: string): boolean;
  doneLast24h: number;
  stuckAfterMs?: number;
  now?: number;
}

function stateFor(activity: BotActivity | undefined, stale: boolean): TeamMapSessionState | null {
  if (activity === "waiting-on-you") return "waiting";
  if (activity === "no-signal") return "stuck";
  if (activity === "working") return stale ? "stuck" : "running";
  return null;
}

export function teamMapSessions(deps: TeamMapSessionsDeps): TeamMapSessionsSnapshot {
  const now = deps.now ?? Date.now();
  const stuckAfterMs = deps.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const sessions: TeamMapSession[] = [];
  for (const bot of deps.bots) {
    for (const task of bot.tasks) {
      if (!task.busy) continue;
      const groupId = deps.groupIdOf(task.threadId);
      if (groupId !== undefined && !deps.visibleGroup(groupId)) continue;
      const lastOutputAt = deps.lastOutputAt(task.threadId);
      const state = stateFor(task.activity, lastOutputAt !== undefined && now - lastOutputAt > stuckAfterMs);
      if (!state) continue;
      const selection = task.modelSelection ?? bot.modelSelection;
      const usd = task.usage?.costUsd;
      sessions.push({
        botId: bot.id, threadId: task.threadId, title: task.title, state, startedAt: task.turnStartedAt ?? now,
        ...(groupId !== undefined ? { groupId } : {}),
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { effort: selection.effort } : {}),
        ...(lastOutputAt !== undefined ? { lastOutputAt } : {}),
        ...(typeof usd === "number" ? { usd, usdEstimated: deps.onPlan(selection.instanceId) } : {}),
      });
    }
  }
  for (const edge of deps.queued) {
    if (sessions.some((session) => session.threadId === edge.threadId)) continue;
    const task = deps.bots.find((bot) => bot.id === edge.targetBotId)?.tasks.find((candidate) => candidate.threadId === edge.threadId);
    sessions.push({
      botId: edge.targetBotId, threadId: edge.threadId, title: task?.title ?? edge.threadId, state: "queued",
      startedAt: deps.createdAt(edge.threadId) ?? now,
      ...(edge.groupId !== undefined ? { groupId: edge.groupId } : {}),
    });
  }
  return { sessions, doneLast24h: deps.doneLast24h, stuckAfterMs };
}
