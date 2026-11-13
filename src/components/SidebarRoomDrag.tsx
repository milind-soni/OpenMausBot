import { useRef, useState, type Dispatch, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { stepKey } from "@/lib/sidebar-bot-drop";
import { planRoomDrop, ROOM_ROW_DRAG_TYPE, roomDropPlace, stepRoom, type RoomDropPlace } from "@/lib/sidebar-room-drop";
import { api, type Action, type Group } from "@/state/store";
import { useMayMoveBots } from "./bot-sections";
import { BotDropLine, botRowDropClass } from "./SidebarBotDrag";

const failure = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Saves the rooms' new order: shown at once, then stored on the server (every client gets it); put back on failure. */
export function saveRoomOrder(dispatch: Dispatch<Action>, groups: readonly Pick<Group, "id">[], groupIds: string[]): void {
  const before = groups.filter((group) => groupIds.includes(group.id)).map((group) => group.id);
  if (before.length === groupIds.length && before.every((id, index) => id === groupIds[index])) return;
  dispatch({ type: "groupsOrdered", groupIds });
  void api("/api/groups/order", { method: "PUT", body: JSON.stringify({ groupIds }) }).catch((cause) => {
    dispatch({ type: "groupsOrdered", groupIds: before });
    dispatch({ type: "error", message: failure(cause) });
  });
}

type RowHandlers = {
  draggable: true;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

/** True when the event comes from this room's own row button, not its thread list or another control. */
const onRoomRow = (target: EventTarget, groupId: string) =>
  target instanceof Element && target.closest("[data-sidebar-group-row]")?.getAttribute("data-sidebar-group-row") === groupId;

/** Dragging a room up or down inside the sidebar list it is in (a department, Rooms, Bot chats), and Alt+Up/Down on
 * its row. Owners and admins only, and not while a search hides some rooms. Call it once per draw, before `list`
 * names the rooms each list shows (in order) and `wrap` puts each room's row in its drop target. */
export function useSidebarRoomDrag({ dispatch, announce, enabled, groups }: {
  dispatch: Dispatch<Action>;
  announce: (text: string) => void;
  enabled: boolean;
  groups: Group[];
}) {
  const mayMove = useMayMoveBots();
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ groupId: string; place: RoomDropPlace } | null>(null);
  const latest = useRef<{ enabled: boolean; lists: string[][]; groups: Group[] }>({ enabled: false, lists: [], groups: [] });
  latest.current = { enabled: enabled && mayMove, lists: [], groups };
  const actions = useRef({ dispatch, announce });
  actions.current = { dispatch, announce };
  const controller = useRef<{ row(groupId: string): RowHandlers; listOf(groupId: string): string[] | undefined } | null>(null);

  if (!controller.current) {
    const rows = new Map<string, RowHandlers>();
    const moving = { from: null as string | null, grabbed: null as string | null };
    const listOf = (groupId: string) => latest.current.lists.find((ids) => ids.includes(groupId));
    const end = () => {
      moving.from = null;
      setDragging(null);
      setDrop(null);
    };
    const apply = (groupId: string, order: string[] | null, keyboard: boolean) => {
      if (!order || !latest.current.enabled) return;
      saveRoomOrder(actions.current.dispatch, latest.current.groups, order);
      if (!keyboard) return;
      const name = latest.current.groups.find((group) => group.id === groupId)?.name ?? "";
      actions.current.announce(t("sidebar.section.moved", { name, position: order.indexOf(groupId) + 1, count: order.length }));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-sidebar-group-row="${CSS.escape(groupId)}"]`)?.focus());
    };
    // Only a room from the same list may land on a row; any other drag (a bot, a thread, a file) is left alone.
    const placeOver = (event: DragEvent<HTMLElement>, groupId: string): RoomDropPlace | null => {
      const from = moving.from;
      if (!from || !event.dataTransfer.types.includes(ROOM_ROW_DRAG_TYPE) || !listOf(groupId)?.includes(from)) return null;
      const box = event.currentTarget.getBoundingClientRect();
      return roomDropPlace(event.clientY - box.top, box.height);
    };
    const row = (groupId: string): RowHandlers => ({
      draggable: true,
      onPointerDown: (event) => { moving.grabbed = onRoomRow(event.target, groupId) ? groupId : null; },
      onDragStart: (event) => {
        if (event.target !== event.currentTarget) return; // a thread row or an image inside drags itself
        // The room moves only when it is picked up by its own row, not by its open thread list.
        if (!latest.current.enabled || moving.grabbed !== groupId || !listOf(groupId)) return event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(ROOM_ROW_DRAG_TYPE, groupId);
        moving.from = groupId;
        setDragging(groupId);
      },
      onDragEnd: end,
      onDragOver: (event) => {
        const place = placeOver(event, groupId);
        if (!place) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDrop((shown) => (shown?.groupId === groupId && shown.place === place ? shown : { groupId, place }));
      },
      onDrop: (event) => {
        const place = placeOver(event, groupId), from = moving.from, list = listOf(groupId);
        if (!place || !from || !list) return;
        event.preventDefault();
        event.stopPropagation();
        end();
        apply(from, planRoomDrop(list, from, groupId, place), false);
      },
      onKeyDown: (event) => {
        const step = stepKey(event), list = listOf(groupId);
        if (!step || !list || !onRoomRow(event.target, groupId)) return;
        event.preventDefault();
        apply(groupId, stepRoom(list, groupId, step), true);
      },
    });
    controller.current = {
      row: (groupId) => rows.get(groupId) ?? rows.set(groupId, row(groupId)).get(groupId)!,
      listOf,
    };
  }
  const { row, listOf } = controller.current;

  return {
    /** Names the rooms one list shows, in the order shown; returns them unchanged. */
    list<T extends Pick<Group, "id">>(items: T[]): T[] {
      if (items.length > 1) latest.current.lists.push(items.map((item) => item.id));
      return items;
    },
    /** A room's row (and its open thread list) inside its drop target while rooms may move; the row alone otherwise.
     * The target lays its children out like the sidebar list around it, so nothing moves on screen. */
    wrap(groupId: string, item: ReactElement): ReactElement {
      if (!latest.current.enabled || !listOf(groupId)) return item;
      const place = drop?.groupId === groupId ? drop.place : null;
      return (
        <div key={groupId} className={cn("relative flex flex-col [gap:inherit]", botRowDropClass(place, dragging === groupId))} {...row(groupId)}>
          <BotDropLine place={place} />
          {item}
        </div>
      );
    },
  };
}
