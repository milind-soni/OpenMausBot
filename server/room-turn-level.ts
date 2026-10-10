// The level a room turn was dispatched at, for the permission requests that
// turn raises. A Chief's delegated level rides the room handoff and is never
// stored on the shared room thread, so a request must read it from here, not
// from the bot's own level. Without this, a turn the Chief ran on Full still
// asked on engines that leave permission requests to the app (ACP).
import type { ApprovalMode } from "../shared/approval-mode.ts";

export type RoomTurnLevels = ReturnType<typeof createRoomTurnLevels>;

export function createRoomTurnLevels() {
  const levels = new Map<string, { level: ApprovalMode }>();
  const key = (threadId: string, botId: string) => `${threadId}\u0000${botId}`;
  return {
    /** Record the level a room turn was sent with; returns a release that
     * clears it when that turn ends, unless a newer turn replaced it. */
    dispatched(threadId: string, botId: string, level: ApprovalMode): () => void {
      const entry = { level };
      levels.set(key(threadId, botId), entry);
      return () => {
        if (levels.get(key(threadId, botId)) === entry) levels.delete(key(threadId, botId));
      };
    },
    /** The running room turn's level, or the bot's own when none is running. */
    forRequest(threadId: string, botId: string, own: () => ApprovalMode): ApprovalMode {
      return levels.get(key(threadId, botId))?.level ?? own();
    },
  };
}
