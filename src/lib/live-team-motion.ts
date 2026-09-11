import type { StudioSnapshot } from "../../shared/live-team";
export interface StudioMotion { id: string; kind: "handoff" | "result"; sourceBotId?: string; targetBotId: string }
export interface StudioMotionState { scope: string; since: number; seen: ReadonlySet<string> }
export function studioMotions(previous: StudioMotionState | null, snapshot: StudioSnapshot, reset = false): { state: StudioMotionState; motions: StudioMotion[]; overflow: number } {
  const scope = JSON.stringify([snapshot.workspaceId, snapshot.room, snapshot.handoffs.offset, snapshot.results.offset]);
  const baseline = reset || previous?.scope !== scope;
  const since = baseline ? snapshot.serverTime : previous!.since;
  const candidates: StudioMotion[] = [
    ...snapshot.handoffs.items.filter((item) => item.state === "running" && item.at >= since).map((item) => ({ id: `handoff:${item.id}`, kind: "handoff" as const, sourceBotId: item.sourceBotId, targetBotId: item.targetBotId })),
    ...snapshot.results.items.filter((item) => item.status === "completed" && item.finishedAt >= since).map((item) => ({ id: `result:${item.id}`, kind: "result" as const, sourceBotId: item.sourceBotId, targetBotId: item.botId })),
  ];
  const unseen = baseline ? [] : candidates.filter((item) => !previous!.seen.has(item.id));
  const seen = new Set([...(baseline ? [] : previous!.seen), ...candidates.map((item) => item.id)]);
  while (seen.size > 2000) seen.delete(seen.values().next().value!);
  return { state: { scope, since, seen }, motions: unseen.slice(0, 2), overflow: Math.max(0, unseen.length - 2) };
}
