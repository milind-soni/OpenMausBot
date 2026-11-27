import { useRef, useState, type Dispatch, type DragEvent } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { BOTS_SECTION_ID, userSectionName } from "@/lib/sidebar-layout";
import { BOT_ROW_DRAG_TYPE, botDropPlace, botListOf, planBotDrop, sameBotDrop, savedPlacement, stepBot, unusedName, type BotDrop, type BotDropPlace, type BotMove } from "@/lib/sidebar-bot-drop";
import type { Action, Bot } from "@/state/store";
import { moveBotsToSection, renameDepartment, saveBotOrder, useMayMoveBots } from "./bot-sections";
import type { OneListRoute } from "./one-list-sidebar";

/** The department being named, before it exists. The server trims names and never keeps a control character. */
export const NEW_DEPARTMENT = "\u0000new";

type DropHandlers = { onDragOver: (event: DragEvent<HTMLElement>) => void; onDrop: (event: DragEvent<HTMLElement>) => void };

export type BotRowDrag = {
  row(botId: string): DropHandlers & { draggable: true; onDragStart: (event: DragEvent<HTMLElement>) => void; onDragEnd: () => void };
  step(botId: string, direction: -1 | 1): void;
};

export type SectionNaming = { value: string; label: string; onCommit: (name: string) => void; onCancel: () => void };

type Naming = { kind: "new"; botIds: string[]; name: string } | { kind: "rename"; section: string };

/** `lists` hold each list's saved order, `shown` the order drawn (working or waiting bots, `floating`, first). */
type Arranged = { enabled: boolean; lists: Map<string, string[]>; shown: Map<string, string[]>; floating: Set<string>; bots: Bot[]; taken: string[]; withinList: boolean; route?: OneListRoute };

/** A list as the sidebar draws it: working or waiting bots first, each part in its saved order. */
const drawnOrder = (ids: readonly string[], floating: ReadonlySet<string>) => [...ids.filter((id) => floating.has(id)), ...ids.filter((id) => !floating.has(id))];
const carries = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(BOT_ROW_DRAG_TYPE);
const failure = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function botRowDropClass(drop: BotDropPlace | null | undefined, dragging: boolean | undefined): string {
  return cn(dragging && "opacity-40", drop === "group" && "rounded-[8px] bg-accent/10 outline outline-2 -outline-offset-2 outline-accent/70");
}

export function BotDropLine({ place }: { place: BotDropPlace | null | undefined }) {
  if (place !== "before" && place !== "after") return null;
  return <span aria-hidden="true" className={cn("pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent", place === "before" ? "-top-[2px]" : "-bottom-[2px]")} />;
}

/** Dragging bots between the rows outside any department and each department's, onto a bot to start a department,
 * Alt+Up/Down, and the name field a new or renamed department shows in its heading. With `withinList` a drop may only
 * reorder the bot inside the list it already belongs to: the icons-only rail draws no department heading, so it shows
 * neither the department a bot would join nor the field that names a new one. */
export function useSidebarBotDrag({ dispatch, announce, onNamed, onRenamed, onError, onCancelled }: {
  dispatch: Dispatch<Action>;
  announce: (text: string) => void;
  onNamed: (name: string) => void;
  onRenamed: (from: string, to: string) => void;
  onError: (message: string) => void;
  onCancelled: () => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<BotDrop | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const mayMove = useMayMoveBots();
  const latest = useRef<Arranged>({ enabled: false, lists: new Map(), shown: new Map(), floating: new Set(), bots: [], taken: [], withinList: false });
  const moving = useRef<{ botId: string | null; drop: BotDrop | null }>({ botId: null, drop: null });
  const controller = useRef<BotRowDrag | null>(null);
  const actions = useRef({ dispatch, announce });
  actions.current = { dispatch, announce };

  const show = (next: BotDrop | null) => {
    if (sameBotDrop(moving.current.drop, next)) return;
    moving.current.drop = next;
    setDrop(next);
  };
  const end = () => {
    moving.current = { botId: null, drop: null };
    setDragging(null);
    setDrop(null);
  };
  const startNew = (botIds: string[]) => setNaming({ kind: "new", botIds, name: unusedName(t("sidebar.section.newName"), latest.current.taken) });
  const apply = (botId: string, move: BotMove, keyboard: boolean) => {
    if (move.kind === "group") return startNew(move.botIds);
    const { lists, shown, bots, floating, route } = latest.current;
    const order = savedPlacement(lists.get(move.section) ?? [], move.order, botId, (id) => floating.has(id)), after = drawnOrder(order, floating);
    const from = botListOf(lists, botId), across = from !== move.section;
    // Alt+Up/Down past a bot that floats otherwise changes nothing drawn: no move, so nothing to say.
    if (keyboard && !across && after.every((id, index) => id === shown.get(move.section)?.[index])) return;
    // With the one list on, this page's server hears only of its own bots; main keeps where the other place's go, and
    // each list a bot left or joined is written again there, so no bot is kept under one that moved away.
    if (across && (!route || route.server(botId))) moveBotsToSection(actions.current.dispatch, [botId], move.section);
    saveBotOrder(actions.current.dispatch, bots, route ? order.filter((id) => route.server(id)) : order);
    if (route) {
      if (across && from !== undefined) route.place(from, (lists.get(from) ?? []).filter((id) => id !== botId), botId);
      route.place(move.section, order, botId);
    }
    if (!keyboard) return;
    const name = bots.find((bot) => bot.id === botId)?.name ?? "";
    actions.current.announce(t("sidebar.section.moved", { name, position: after.indexOf(botId) + 1, count: after.length }));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-sidebar-bot-row="${CSS.escape(botId)}"]`)?.focus());
  };
  const allowed = (botId: string, move: BotMove | null): BotMove | null => {
    if (!move) return null;
    if (!latest.current.withinList) return move;
    const from = botListOf(latest.current.lists, botId);
    if (move.kind !== "move" || move.section !== from) return null;
    return move;
  };
  const finish = (target: BotDrop | null) => {
    const botId = moving.current.botId;
    end();
    const move = botId && target && latest.current.enabled ? planBotDrop(latest.current.shown, botId, target) : null;
    if (botId && move) {
      const next = allowed(botId, move);
      if (next) apply(botId, next, false);
    }
  };
  const rowDrop = (event: DragEvent<HTMLElement>, botId: string): BotDrop => {
    const box = event.currentTarget.getBoundingClientRect();
    const canGroup = !latest.current.withinList && botListOf(latest.current.lists, botId) === "" && latest.current.route?.group !== false;
    return { kind: "row", botId, place: botDropPlace(event.clientY - box.top, box.height, canGroup) };
  };

  controller.current ??= {
    row: (botId) => ({
      draggable: true,
      onDragStart: (event) => {
        if (!latest.current.enabled || botListOf(latest.current.lists, botId) === undefined) return;
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(BOT_ROW_DRAG_TYPE, botId);
        moving.current = { botId, drop: null };
        setDragging(botId);
      },
      onDragEnd: end,
      onDragOver: (event) => {
        if (!carries(event) || !moving.current.botId) return;
        // Within one list only (the collapsed rail): another list's row shows no drop line, since the drop is refused.
        if (latest.current.withinList && botListOf(latest.current.lists, botId) !== botListOf(latest.current.lists, moving.current.botId)) return show(null);
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        show(botId === moving.current.botId ? null : rowDrop(event, botId));
      },
      onDrop: (event) => {
        if (!carries(event)) return;
        event.preventDefault();
        event.stopPropagation();
        finish(botId === moving.current.botId ? null : rowDrop(event, botId));
      },
    }),
    step: (botId, direction) => {
      const move = latest.current.enabled ? stepBot(latest.current.shown, botId, direction) : null;
      if (move) apply(botId, move, true);
    },
  };

  const finishNaming = (current: Naming, draft: string) => {
    setNaming(null);
    if (current.kind === "new") {
      const name = draft.trim() || current.name, route = latest.current.route;
      moveBotsToSection(dispatch, current.botIds.filter((id) => (!route || route.server(id)) && latest.current.bots.some((bot) => bot.id === id && !bot.hidden)), name);
      route?.place(name, current.botIds.filter((id) => route.kept(id)));
      onNamed(name);
      return;
    }
    const to = nextRename(current.section, draft);
    const route = latest.current.route, from = current.section;
    if (to) (route ? route.rename(from, to, () => renameDepartment(dispatch, from, to)) : renameDepartment(dispatch, from, to)).then(() => onRenamed(from, to), (cause) => onError(failure(cause)));
  };

  return {
    pending: naming?.kind === "new" ? [NEW_DEPARTMENT] : [],
    preview: <T extends Bot>(bots: T[]): T[] => naming?.kind === "new" ? bots.map((bot) => (naming.botIds.includes(bot.id) ? { ...bot, section: NEW_DEPARTMENT } : bot)) : bots,
    startNew: (botIds: string[]) => startNew(botIds),
    startRename: (section: string) => setNaming({ kind: "rename", section }),
    /** `main` and `sectioned` in their saved order; `floats` says which bots the sidebar draws first in their list. A drop
     * or Alt+Up/Down moves a bot among the rows as drawn, and is saved into the saved order (savedPlacement). */
    arrange({ enabled, withinList = false, main, sectioned, departments, bots, taken, floats, route }: {
      enabled: boolean; withinList?: boolean; main: Bot[]; sectioned: Bot[]; departments: string[]; bots: Bot[]; taken: string[]; floats?: (bot: Bot) => boolean;
      /** With the one list on: which bots this page's server arranges, which main keeps, and which stay put here. */
      route?: OneListRoute;
    }) {
      const movable = enabled && mayMove;
      const lists = new Map<string, string[]>([["", main.map((bot) => bot.id)]]);
      for (const name of departments) if (name !== NEW_DEPARTMENT) lists.set(name, sectioned.filter((bot) => bot.section === name).map((bot) => bot.id));
      const floating = new Set(floats ? [...main, ...sectioned].filter(floats).map((bot) => bot.id) : []);
      const drawn = new Map([...lists].map(([name, ids]) => [name, drawnOrder(ids, floating)]));
      latest.current = { enabled: movable, lists, shown: drawn, floating, bots, taken, withinList, route };
      const listOf = new Map<string, string>();
      for (const [list, ids] of lists) for (const id of ids) listOf.set(id, list);
      const active = movable && dragging !== null && listOf.has(dragging) ? dragging : null;
      const shown = active ? drop : null;
      const mainIds = drawn.get("")!.filter((id) => id !== active);
      const listFor = (sectionId: string) => (sectionId === BOTS_SECTION_ID ? "" : userSectionName(sectionId));
      // Between rows, or under the last one, the nearest row places the bot; a department's heading takes it in.
      const zoneDrop = (event: DragEvent<HTMLElement>, list: string): BotDrop => {
        const ids = lists.get(list)!;
        const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-sidebar-bot-row]")]
          .filter((element) => ids.includes(element.dataset.sidebarBotRow ?? "")).map((element) => ({ botId: element.dataset.sidebarBotRow!, box: element.getBoundingClientRect() }));
        if (!rows.length || (list !== "" && event.clientY < rows[0]!.box.top)) return { kind: "end", list };
        const row = rows.find(({ box }) => event.clientY < box.bottom) ?? rows.at(-1)!;
        return { kind: "row", botId: row.botId, place: event.clientY < row.box.top + row.box.height / 2 ? "before" : "after" };
      };
      return {
        row: (botId: string): { botDrag?: BotRowDrag; botDrop?: BotDropPlace | null; botDragging?: boolean } => {
          if (!movable || !listOf.has(botId) || (route && !route.movable(botId))) return {};
          const place = shown?.kind === "row" && shown.botId === botId ? shown.place
            : shown?.kind === "end" && shown.list === "" && botId === mainIds.at(-1) ? "after" : null;
          return { botDrag: controller.current!, botDrop: place, botDragging: active === botId };
        },
        into: (name: string | null) => shown?.kind === "end" && name !== null && name !== "" && shown.list === name,
        zone: (sectionId: string, fallback: DropHandlers): DropHandlers => ({
          onDragOver: (event) => {
            if (!carries(event)) return fallback.onDragOver(event);
            const list = listFor(sectionId);
            const dragged = moving.current.botId;
            if (!dragged || list === null || !lists.has(list)) return show(null);
            if (withinList && list !== listOf.get(dragged)) return show(null);
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const target = zoneDrop(event, list);
            show(target.kind === "row" && target.botId === moving.current.botId ? null : target);
          },
          onDrop: (event) => {
            if (!carries(event)) return fallback.onDrop(event);
            event.preventDefault();
            const list = listFor(sectionId);
            finish(list !== null && lists.has(list) ? zoneDrop(event, list) : null);
          },
        }),
        slot: active !== null && mainIds.length === 0 && listOf.get(active) !== ""
          ? <div data-bot-drop-slot="" className={cn("mx-2 flex h-10 items-center justify-center rounded-[8px] border border-dashed text-[13px] leading-[18px]",
            shown?.kind === "end" && shown.list === "" ? "border-accent bg-accent/10 text-ink" : "border-ink/20 text-ink-secondary")}>{t("sidebar.section.removeFromDepartment")}</div>
          : null,
        naming: (name: string | null): SectionNaming | undefined => {
          if (!naming || name === null) return undefined;
          const value = naming.kind === "new" ? (name === NEW_DEPARTMENT ? naming.name : null) : (name === naming.section ? naming.section : null);
          if (value === null) return undefined;
          return {
            value,
            label: naming.kind === "new" ? t("sidebar.section.newContextAria") : t("team.renameAria", { name }),
            onCommit: (draft) => finishNaming(naming, draft),
            onCancel: () => { setNaming(null); onCancelled(); },
          };
        },
      };
    },
  };
}
