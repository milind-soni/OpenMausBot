import { t } from "@/lib/i18n";

export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;

export type RoomTurnTimeoutInput =
  | { ok: true; minutes: number }
  | { ok: false; error: string };

export function parseRoomTurnTimeoutMinutes(value: string): RoomTurnTimeoutInput {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: t("rooms.turnTimeoutError") };
  const minutes = Number(trimmed);
  if (minutes < MIN_ROOM_TURN_TIMEOUT_MINUTES || minutes > MAX_ROOM_TURN_TIMEOUT_MINUTES) {
    return { ok: false, error: t("rooms.turnTimeoutError") };
  }
  return { ok: true, minutes };
}
