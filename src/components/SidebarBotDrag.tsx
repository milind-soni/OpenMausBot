import { useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { BOTS_SECTION_ID, userSectionName } from "@/lib/sidebar-layout";
import { botDropPlace, botListOf, planBotDrop, sameBotDrop, savedPlacement, stepBot, stepKey, unusedName, type BotDrop, type BotDropPlace, type BotLists, type BotMove } from "@/lib/sidebar-bot-drop";
import type { Action, Bot } from "@/state/store";
import { moveBotsToSection, renameDepartment, saveBotOrder, useMayMoveBots } from "./bot-sections";

/** The department being named, before it exists. The server trims names and never keeps a control character. */
export const NEW_DEPARTMENT = "\u0000new";

const LIFT_DISTANCE = 4;
const SCROLL_EDGE = 40;
const SCROLL_STEP = 12;

export type BotRowDrag = {
  row(botId: string): { "data-bot-drag-row": string; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void };
  step(botId: string, direction: -1 | 1): void;
};

export type SectionNaming = { value: string; label: string; onCommit: (name: string) => void; onCancel: () => void };

type Naming = { kind: "new"; botIds: string[]; name: string } | { kind: "rename"; section: string };

/** `lists` hold each list's saved order, `shown` the order drawn (working or waiting bots, `floating`, first). */
type Arranged = { enabled: boolean; lists: Map<string, string[]>; shown: Map<string, string[]>; floating: Set<string>; bots: Bot[]; taken: string[]; withinList: boolean };

type Press = {
  botId: string; pointerId: number; element: HTMLElement; scroller: HTMLElement | null;
  from: { x: number; y: number; scrollTop: number }; at: { x: number; y: number }; lifted: boolean; frame: number;
};

/** A list as the sidebar draws it: working or waiting bots first, each part in its saved order. */
const drawnOrder = (ids: readonly string[], floating: ReadonlySet<string>) => [...ids.filter((id) => floating.has(id)), ...ids.filter((id) => !floating.has(id))];
const failure = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const listOfSection = (sectionId: string) => (sectionId === BOTS_SECTION_ID ? "" : userSectionName(sectionId));

function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** Between rows, or under the last one, the nearest row places the bot; a department's heading takes it in. */
function zoneDrop(zone: Element, clientY: number, list: string, ids: readonly string[], dragged: string): BotDrop {
  const rows = [...zone.querySelectorAll<HTMLElement>("[data-sidebar-bot-row]")]
    .filter((element) => element.dataset.sidebarBotRow !== dragged && ids.includes(element.dataset.sidebarBotRow ?? ""))
    .map((element) => ({ botId: element.dataset.sidebarBotRow!, box: element.getBoundingClientRect() }));
  if (!rows.length || (list !== "" && clientY < rows[0]!.box.top)) return { kind: "end", list };
  const row = rows.find(({ box }) => clientY < box.bottom) ?? rows.at(-1)!;
  return { kind: "row", botId: row.botId, place: clientY < row.box.top + row.box.height / 2 ? "before" : "after" };
}

function dropAt(x: number, y: number, dragged: string, lists: BotLists, withinList: boolean): BotDrop | null {
  const from = botListOf(lists, dragged);
  const hit = document.elementFromPoint(x, y);
  const rowElement = hit?.closest<HTMLElement>("[data-bot-drag-row]");
  const over = rowElement?.dataset.botDragRow;
  if (rowElement && over !== undefined && botListOf(lists, over) !== undefined) {
    const to = botListOf(lists, over);
    if (over === dragged || (withinList && to !== from)) return null;
    const box = rowElement.getBoundingClientRect();
    return { kind: "row", botId: over, place: botDropPlace(y - box.top, box.height, !withinList && to === "") };
  }
  const zone = hit?.closest<HTMLElement>("[data-sidebar-section-id]");
  const list = zone ? listOfSection(zone.dataset.sidebarSectionId ?? "") : null;
  if (!zone || list === null || !lists.has(list) || (withinList && list !== from)) return null;
  return zoneDrop(zone, y, list, lists.get(list)!, dragged);
}

export function botRowDropClass(drop: BotDropPlace | null | undefined, dragging: boolean | undefined): string {
  return cn(dragging && "opacity-40", drop === "group" && "rounded-[8px] bg-accent/10 outline outline-2 -outline-offset-2 outline-accent/70");
}

export function BotDropLine({ place }: { place: BotDropPlace | null | undefined }) {
  if (place !== "before" && place !== "after") return null;
  return <span aria-hidden="true" className={cn("pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent", place === "before" ? "-top-[2px]" : "-bottom-[2px]")} />;
}

/** Pressing a bot's row and dragging it lifts the row under the pointer and moves the bot between the rows outside any
 * department and each department's, or onto a bot to start a department; Escape puts it back. Alt+Up/Down moves the
 * bot whose row has focus, or else the open bot. With `withinList` a drop may only reorder the bot inside the list it
 * already belongs to: the icons-only rail draws no department heading, so it shows neither the department a bot would
 * join nor the field that names a new one. */
export function useSidebarBotDrag({ dispatch, announce, selected, onNamed, onRenamed, onError, onCancelled }: {
  dispatch: Dispatch<Action>;
  announce: (text: string) => void;
  selected: string | null;
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
    const { lists, shown, bots, floating } = latest.current;
    const order = savedPlacement(lists.get(move.section) ?? [], move.order, botId, (id) => floating.has(id)), after = drawnOrder(order, floating);
    const across = botListOf(lists, botId) !== move.section;
    // Alt+Up/Down past a bot that floats otherwise changes nothing drawn: no move, so nothing to say.
    if (keyboard && !across && after.every((id, index) => id === shown.get(move.section)?.[index])) return;
    if (across) moveBotsToSection(actions.current.dispatch, [botId], move.section);
    saveBotOrder(actions.current.dispatch, bots, order);
    if (!keyboard) return;
    const name = bots.find((bot) => bot.id === botId)?.name ?? "";
    actions.current.announce(t("sidebar.section.moved", { name, position: after.indexOf(botId) + 1, count: after.length }));
    if (document.activeElement?.closest("[data-sidebar-bot-row]")) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-sidebar-bot-row="${CSS.escape(botId)}"]`)?.focus());
    }
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

  if (!controller.current) {
    let press: Press | null = null;
    const follow = (current: Press) => {
      const scrolled = current.scroller ? current.scroller.scrollTop - current.from.scrollTop : 0;
      current.element.style.transform = `translate3d(0, ${current.at.y - current.from.y + scrolled}px, 0)`;
      const target = dropAt(current.at.x, current.at.y, current.botId, latest.current.lists, latest.current.withinList);
      show(target && allowed(current.botId, planBotDrop(latest.current.shown, current.botId, target)) ? target : null);
    };
    const scroll = () => {
      if (!press?.lifted) return;
      const { scroller, at } = press;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        const delta = at.y < box.top + SCROLL_EDGE ? -SCROLL_STEP : at.y > box.bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
        if (delta) {
          scroller.scrollTop += delta;
          follow(press);
        }
      }
      press.frame = requestAnimationFrame(scroll);
    };
    const lift = (current: Press) => {
      current.lifted = true;
      moving.current = { botId: current.botId, drop: null };
      setDragging(current.botId);
      Object.assign(current.element.style, { pointerEvents: "none", zIndex: "20" });
      document.body.style.userSelect = "none";
      getSelection()?.removeAllRanges();
      current.frame = requestAnimationFrame(scroll);
    };
    const swallowClick = () => {
      const swallow = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    };
    const release = (commit: boolean) => {
      const current = press;
      press = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onEscape, true);
      if (!current?.lifted) return;
      cancelAnimationFrame(current.frame);
      Object.assign(current.element.style, { transform: "", pointerEvents: "", zIndex: "" });
      document.body.style.userSelect = "";
      swallowClick();
      if (commit) finish(moving.current.drop);
      else end();
    };
    const onMove = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return;
      press.at = { x: event.clientX, y: event.clientY };
      if (!press.lifted) {
        if (Math.hypot(press.at.x - press.from.x, press.at.y - press.from.y) < LIFT_DISTANCE) return;
        if (!latest.current.enabled) return release(false);
        lift(press);
      }
      follow(press);
    };
    const onUp = (event: PointerEvent) => { if (press && event.pointerId === press.pointerId) release(true); };
    const onCancel = (event: PointerEvent) => { if (press && event.pointerId === press.pointerId) release(false); };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !press?.lifted) return;
      event.preventDefault();
      event.stopPropagation();
      release(false);
    };
    controller.current = {
      row: (botId) => ({
        "data-bot-drag-row": botId,
        onPointerDown: (event) => {
          if (press || event.button !== 0 || event.pointerType === "touch") return;
          if (!latest.current.enabled || botListOf(latest.current.lists, botId) === undefined) return;
          const control = event.target instanceof Element ? event.target.closest("button, a, input, textarea, select") : null;
          if (control && event.currentTarget.contains(control)) return;
          const element = event.currentTarget, scroller = scrollerOf(element);
          press = {
            botId, pointerId: event.pointerId, element, scroller, lifted: false, frame: 0,
            from: { x: event.clientX, y: event.clientY, scrollTop: scroller?.scrollTop ?? 0 }, at: { x: event.clientX, y: event.clientY },
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onCancel);
          window.addEventListener("keydown", onEscape, true);
        },
      }),
      step: (botId, direction) => {
        const move = latest.current.enabled ? stepBot(latest.current.shown, botId, direction) : null;
        if (move) apply(botId, move, true);
      },
    };
  }

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      const direction = stepKey(event);
      if (!direction || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value) return;
      event.preventDefault();
      controller.current!.step(selected, direction);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

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
    /** `main` and `sectioned` in their saved order; `floats` says which bots the sidebar draws first in their list. A drop
     * or Alt+Up/Down moves a bot among the rows as drawn, and is saved into the saved order (savedPlacement). */
    arrange({ enabled, withinList = false, main, sectioned, departments, bots, taken, floats }: {
      enabled: boolean; withinList?: boolean; main: Bot[]; sectioned: Bot[]; departments: string[]; bots: Bot[]; taken: string[]; floats?: (bot: Bot) => boolean;
    }) {
      const movable = enabled && mayMove;
      const lists = new Map<string, string[]>([["", main.map((bot) => bot.id)]]);
      for (const name of departments) if (name !== NEW_DEPARTMENT) lists.set(name, sectioned.filter((bot) => bot.section === name).map((bot) => bot.id));
      const floating = new Set(floats ? [...main, ...sectioned].filter(floats).map((bot) => bot.id) : []);
      const drawn = new Map([...lists].map(([name, ids]) => [name, drawnOrder(ids, floating)]));
      latest.current = { enabled: movable, lists, shown: drawn, floating, bots, taken, withinList };
      const active = movable && dragging !== null && botListOf(lists, dragging) !== undefined ? dragging : null;
      const shown = active ? drop : null;
      const mainIds = drawn.get("")!.filter((id) => id !== active);
      return {
        row: (botId: string): { botDrag?: BotRowDrag; botDrop?: BotDropPlace | null; botDragging?: boolean } => {
          if (!movable || botListOf(lists, botId) === undefined) return {};
          const place = shown?.kind === "row" && shown.botId === botId ? shown.place
            : shown?.kind === "end" && shown.list === "" && botId === mainIds.at(-1) ? "after" : null;
          return { botDrag: controller.current!, botDrop: place, botDragging: active === botId };
        },
        into: (name: string | null) => shown?.kind === "end" && name !== null && name !== "" && shown.list === name,
        slot: active !== null && mainIds.length === 0 && botListOf(lists, active) !== ""
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
