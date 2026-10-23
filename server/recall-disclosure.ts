// Each private thread a room answer recalled from is announced once per room thread; in memory, so a restart re-announces (the safe direction).
import { noticeTool } from "./chat-notices.ts";

const announced = new Map<string, Set<string>>();

export interface RecallCrossing {
  threadIds: string[];
  count: number;
}

export function claimRecallCrossings(roomThreadId: string, sources: readonly string[]): RecallCrossing {
  const seen = announced.get(roomThreadId) ?? new Set<string>();
  const threadIds: string[] = [];
  let count = 0;
  for (const threadId of sources) {
    if (seen.has(threadId)) continue;
    if (!threadIds.includes(threadId)) threadIds.push(threadId);
    count += 1;
  }
  if (!threadIds.length) return { threadIds: [], count: 0 };
  for (const threadId of threadIds) seen.add(threadId);
  announced.set(roomThreadId, seen);
  return { threadIds, count };
}

export function recallCrossingTool(botName: string, count: number) {
  return noticeTool(count === 1 ? "chat.notice.recallCrossingOne" : "chat.notice.recallCrossingMany", { name: botName, count }, { ok: true });
}

export function forgetRecallCrossings(roomThreadId?: string): void {
  if (roomThreadId === undefined) announced.clear();
  else announced.delete(roomThreadId);
}

export function briefCrossingTool(botName: string, count: number) {
  return noticeTool(count === 1 ? "chat.notice.briefCrossingOne" : "chat.notice.briefCrossingMany", { name: botName, count }, { ok: true });
}
