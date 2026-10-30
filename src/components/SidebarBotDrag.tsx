import { useRef, useState, type Dispatch, type DragEvent } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { BOTS_SECTION_ID, userSectionName } from "@/lib/sidebar-layout";
import { BOT_ROW_DRAG_TYPE, botDropPlace, botListOf, planBotDrop, sameBotDrop, stepBot, unusedName, type BotDrop, type BotDropPlace, type BotMove } from "@/lib/sidebar-bot-drop";
import type { Action, Bot } from "@/state/store";
import { moveBotsToSection, renameDepartment, saveBotOrder, useMayMoveBots } from "./bot-sections";

/** The department being named, before it exists. The server trims names and never keeps a control character. */
export const NEW_DEPARTMENT = "\u0000new";

type DropHandlers = { onDragOver: (event: DragEvent<HTMLElement>) => void; onDrop: (event: DragEvent<HTMLElement>) => void };

export type BotRowDrag = {
  row(botId: string): DropHandlers & { draggable: true; onDragStart: (event: DragEvent<HTMLElement>) => void; onDragEnd: () => void };
  step(botId: string, direction: -1 | 1): void;
};

export type SectionNaming = { value: string; label: string; onCommit: (name: string) => void; onCancel: () => void };

type Naming = { kind: "new"; botIds: string[]; name: string } | { kind: "rename"; section: string };

type Arranged = { enabled: boolean; lists: Map<string, string[]>; bots: Bot[]; taken: string[] };

const carries = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(BOT_ROW_DRAG_TYPE);
const failure = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function botRowDropClass(drop: BotDropPlace | null | undefined, dragging: boolean | undefined): string {
  return cn(dragging && "opacity-40", drop === "group" && "rounded-[10px] bg-accent/10 outline outline-2 -outline-offset-2 outline-accent/70");
}

export function BotDropLine({ place }: { place: BotDropPlace | null | undefined }) {
  if (place !== "before" && place !== "after") return null;
  return <span aria-hidden="true" className={cn("pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent", place === "before" ? "-top-[2px]" : "-bottom-[2px]")} />;
}

/** Dragging bots between the rows outside any department and each department's, onto a bot to start a department,
 * Alt+Up/Down, and the name field a new or renamed department shows in its heading. */
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
  const latest = useRef<Arranged>({ enabled: false, lists: new Map(), bots: [], taken: [] });
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
    const { lists, bots } = latest.current;
    if (botListOf(lists, botId) !== move.section) moveBotsToSection(actions.current.dispatch, [botId], move.section);
    saveBotOrder(actions.current.dispatch, bots, move.order);
    if (!keyboard) return;
    const name = bots.find((bot) => bot.id === botId)?.name ?? "";
    actions.current.announce(t("sidebar.section.moved", { name, position: move.order.indexOf(botId) + 1, count: move.order.length }));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-sidebar-bot-row="${CSS.escape(botId)}"]`)?.focus());
  };
  const finish = (target: BotDrop | null) => {
    const botId = moving.current.botId;
    end();
    const move = botId && target && latest.current.enabled ? planBotDrop(latest.current.lists, botId, target) : null;
    if (botId && move) apply(botId, move, false);
  };
  const rowDrop = (event: DragEvent<HTMLElement>, botId: string): BotDrop => {
    const box = event.currentTarget.getBoundingClientRect();
    return { kind: "row", botId, place: botDropPlace(event.clientY - box.top, box.height, botListOf(latest.current.lists, botId) === "") };
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
      const move = latest.current.enabled ? stepBot(latest.current.lists, botId, direction) : null;
      if (move) apply(botId, move, true);
    },
  };

  const finishNaming = (current: Naming, draft: string) => {
    setNaming(null);
    if (current.kind === "new") {
      const name = draft.trim() || current.name;
      moveBotsToSection(dispatch, current.botIds.filter((id) => latest.current.bots.some((bot) => bot.id === id && !bot.hidden)), name);
      onNamed(name);
      return;
    }
    const to = nextRename(current.section, draft);
    if (to) renameDepartment(dispatch, current.section, to).then(() => onRenamed(current.section, to), (cause) => onError(failure(cause)));
  };

  return {
    pending: naming?.kind === "new" ? [NEW_DEPARTMENT] : [],
    preview: <T extends Bot>(bots: T[]): T[] => naming?.kind === "new" ? bots.map((bot) => (naming.botIds.includes(bot.id) ? { ...bot, section: NEW_DEPARTMENT } : bot)) : bots,
    startNew: (botIds: string[]) => startNew(botIds),
    startRename: (section: string) => setNaming({ kind: "rename", section }),
    arrange({ enabled, main, sectioned, departments, bots, taken }: {
      enabled: boolean; main: Bot[]; sectioned: Bot[]; departments: string[]; bots: Bot[]; taken: string[];
    }) {
      const movable = enabled && mayMove;
      const lists = new Map<string, string[]>([["", main.map((bot) => bot.id)]]);
      for (const name of departments) if (name !== NEW_DEPARTMENT) lists.set(name, sectioned.filter((bot) => bot.section === name).map((bot) => bot.id));
      latest.current = { enabled: movable, lists, bots, taken };
      const active = movable && dragging !== null && botListOf(lists, dragging) !== undefined ? dragging : null;
      const shown = active ? drop : null;
      const mainIds = lists.get("")!.filter((id) => id !== active);
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
          if (!movable || botListOf(lists, botId) === undefined) return {};
          const place = shown?.kind === "row" && shown.botId === botId ? shown.place
            : shown?.kind === "end" && shown.list === "" && botId === mainIds.at(-1) ? "after" : null;
          return { botDrag: controller.current!, botDrop: place, botDragging: active === botId };
        },
        into: (name: string | null) => shown?.kind === "end" && name !== null && name !== "" && shown.list === name,
        zone: (sectionId: string, fallback: DropHandlers): DropHandlers => ({
          onDragOver: (event) => {
            if (!carries(event)) return fallback.onDragOver(event);
            const list = listFor(sectionId);
            if (!moving.current.botId || list === null || !lists.has(list)) return show(null);
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
        slot: active !== null && mainIds.length === 0 && botListOf(lists, active) !== ""
          ? <div data-bot-drop-slot="" className={cn("mx-2 flex h-10 items-center justify-center rounded-[10px] border border-dashed text-[13px] leading-[18px]",
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
