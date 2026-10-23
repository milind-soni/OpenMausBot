     import type { ApprovalMode } from "../shared/approval-mode.ts";

export type RoomTurnLevels = ReturnType<typeof createRoomTurnLevels>;

export function createRoomTurnLevels() {
  const levels = new Map<string, { level: ApprovalMode; current?: () => ApprovalMode }>();
  const key = (threadId: string, botId: string) => `${threadId}\u0000${botId}`;
  return {
    /** Native grants can only narrow while running; app-owned gates can read
     * a live selection. Release is scoped to the exact dispatched turn. */
    dispatched(threadId: string, botId: string, level: ApprovalMode, current?: () => ApprovalMode): () => void {
      const entry = { level, current };
      levels.set(key(threadId, botId), entry);
      return () => {
        if (levels.get(key(threadId, botId)) === entry) levels.delete(key(threadId, botId));
      };
    },
    forRequest(threadId: string, botId: string, own: () => ApprovalMode): ApprovalMode {
      const entry = levels.get(key(threadId, botId));
      return entry?.current?.() ?? entry?.level ?? own();
    },
  };
}
