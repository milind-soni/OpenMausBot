/** An undefined memberDefault means the engine runs off-host, so it never takes the room's host folder. */
export function groupTurnCwd(
  memberDefault: string | undefined,
  pinRoomCwd: () => string | null,
): string | undefined {
  if (memberDefault === undefined) return undefined;
  return pinRoomCwd() ?? memberDefault;
}
