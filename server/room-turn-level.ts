// A Chief's delegated level rides the room handoff, never the shared room thread, so permission requests read it here.
import type { ApprovalMode } from "../shared/approval-mode.ts";

export type RoomTurnLevels = ReturnType<typeof createRoomTurnLevels>;

export function createRoomTurnLevels() {
  const levels = new Map<string, { level: ApprovalMode }>();
  const key = (threadId: string, botId: string) => `${threadId}\u0000${botId}`;
  return {
    /** The release clears it when the turn ends, unless a newer turn replaced it. */
    dispatched(threadId: string, botId: string, level: ApprovalMode): () => void {
      const entry = { level };
      levels.set(key(threadId, botId), entry);
      return () => {
        if (levels.get(key(threadId, botId)) === entry) levels.delete(key(threadId, botId));
      };
    },
    forRequest(threadId: string, botId: string, own: () => ApprovalMode): ApprovalMode {
      return levels.get(key(threadId, botId))?.level ?? own();
    },
  };
}
