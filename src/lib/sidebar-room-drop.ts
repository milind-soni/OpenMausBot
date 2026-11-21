export const ROOM_ROW_DRAG_TYPE = "application/x-openmausbot-sidebar-room";

/** Where a dragged room lands against the room row under the pointer. */
export type RoomDropPlace = "before" | "after";

export function roomDropPlace(offset: number, height: number): RoomDropPlace {
  return height > 0 && offset / height >= 0.5 ? "after" : "before";
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** `list` (the rooms one sidebar list shows, in order) with `roomId` dropped before or after `targetId`; null when
 * either is not in the list or nothing would move. A room only moves inside the list it is in. */
export function planRoomDrop(list: readonly string[], roomId: string, targetId: string, place: RoomDropPlace): string[] | null {
  if (roomId === targetId || !list.includes(roomId) || !list.includes(targetId)) return null;
  const rest = list.filter((id) => id !== roomId);
  const at = rest.indexOf(targetId) + (place === "after" ? 1 : 0);
  const next = [...rest.slice(0, at), roomId, ...rest.slice(at)];
  return same(next, list) ? null : next;
}

/** `list` with `roomId` moved one place up (-1) or down (1); null at either end. */
export function stepRoom(list: readonly string[], roomId: string, direction: -1 | 1): string[] | null {
  const index = list.indexOf(roomId);
  const target = index < 0 ? undefined : list[index + direction];
  if (target === undefined) return null;
  return planRoomDrop(list, roomId, target, direction === -1 ? "before" : "after");
}
