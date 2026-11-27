export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
export const ROOM_TURN_TIMEOUT_INPUT_ERROR = "Enter a whole number from 1 to 1,440.";

export type RoomTurnTimeoutInput =
  | { ok: true; minutes: number }
  | { ok: false; error: string };

export function parseRoomTurnTimeoutMinutes(value: string): RoomTurnTimeoutInput {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: ROOM_TURN_TIMEOUT_INPUT_ERROR };
  const minutes = Number(trimmed);
  if (minutes < MIN_ROOM_TURN_TIMEOUT_MINUTES || minutes > MAX_ROOM_TURN_TIMEOUT_MINUTES) {
    return { ok: false, error: ROOM_TURN_TIMEOUT_INPUT_ERROR };
  }
  return { ok: true, minutes };
}
