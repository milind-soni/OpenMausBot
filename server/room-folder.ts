import { existsSync } from "node:fs";

/** A room keeps the folder it started in. Only that pinned folder can be gone, and the engine would otherwise blame the
 * bot's own folder, so say so before the turn launches. */
export function assertRoomFolder(cwd: string | undefined | null): void {
  if (cwd && !existsSync(cwd)) {
    throw new Error(`This room's working folder no longer exists: ${cwd}. Create that folder again: a room keeps the folder it started in.`);
  }
}
