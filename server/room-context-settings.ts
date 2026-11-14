import { z } from "zod";

export const roomContextSettings = {
  /** Start a fresh session before a room turn once context reaches this (fraction or tokens); default 0.9. */
  roomCompactAt: z.number().positive().max(10_000_000).optional(),
  /** Send a Claude Code room member whose session already holds the room only the lines it has not seen. Off unless true. */
  roomSessions: z.boolean().optional(),
};

/** OMB_ROOM_SESSIONS "1" or "0" overrides `context.roomSessions`; any other value leaves the file to decide. */
export function roomSessionsEnabled(
  settings: { roomSessions?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = env.OMB_ROOM_SESSIONS?.trim();
  if (override === "1") return true;
  if (override === "0") return false;
  return settings?.roomSessions === true;
}
