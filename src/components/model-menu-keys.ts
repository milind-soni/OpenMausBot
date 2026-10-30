import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { isTypeaheadKey, TYPEAHEAD_RESET_MS, typeaheadMatch, typeaheadText, type Typeahead } from "@/lib/menu-keys";
import { nextMenuIndex } from "./SidebarPopoverMenu";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]";
const FORWARD_ROWS = "[data-simple-set-up], [data-simple-sign-in], [data-simple-manage], [data-model-local-entry]";

/** A model menu's keys other than Escape: Tab past its last stop closes it; the arrows, Home and End move between its
 * rows, its search box and its thinking pills; Enter picks; typing jumps to a row, or into the search box. */
export function modelMenuKey(event: ReactKeyboardEvent<HTMLElement>, { query, typed, close }: {
  query: string;
  typed: { current: Typeahead | null };
  close: () => void;
}): void {
  if (!(event.target instanceof HTMLElement)) return;
  const menu = event.currentTarget;
  const target = event.target;
  const handled = () => {
    event.preventDefault();
    event.stopPropagation();
  };
  if (event.key === "Tab") {
    const stops = [...menu.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element !== target && element.tabIndex >= 0);
    const follows = (first: Node, second: Node) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!stops.some((stop) => (event.shiftKey ? follows(stop, target) : follows(target, stop)))) {
      handled();
      close();
    }
    return;
  }
  if (target instanceof HTMLSelectElement) return;
  const rtl = getComputedStyle(menu).direction === "rtl";
  const pills = target.closest("[data-simple-effort]");
  if (pills) {
    const buttons = [...pills.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    const step = { ArrowRight: rtl ? "ArrowUp" : "ArrowDown", ArrowLeft: rtl ? "ArrowDown" : "ArrowUp", Home: "Home", End: "End" }[event.key];
    const next = step ? nextMenuIndex(step, buttons.indexOf(target), buttons.length) : null;
    if (next !== null) {
      handled();
      buttons[next]?.focus();
    }
    return;
  }
  const search = menu.querySelector<HTMLInputElement>("[data-menu-search]");
  if (target instanceof HTMLInputElement && target !== search) return;
  const rows = [...menu.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)")];
  const below = search ? rows.filter((row) => search.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) : [];
  const above = search ? rows.filter((row) => !below.includes(row)) : [];
  const goTo = (row: HTMLElement | undefined) => {
    handled();
    row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
  };
  if (target === search) {
    if (event.key === "ArrowDown") goTo(below[0]);
    else if (event.key === "ArrowUp" && above.length > 0) goTo(above.at(-1));
    else if (event.key === "Enter") {
      handled();
      if (query.trim()) rows.find((row) => row.hasAttribute("aria-pressed") && !row.hasAttribute("data-follow-bot-model"))?.click();
    }
    return;
  }
  const index = rows.indexOf(target);
  if (index < 0 && target !== menu) return;
  if (event.key === "Enter" && index >= 0) {
    handled();
    target.click();
    return;
  }
  if (search && ((event.key === "ArrowUp" && target === below[0]) || (event.key === "ArrowDown" && target === above.at(-1)))) return goTo(search);
  const next = nextMenuIndex(event.key, index, rows.length);
  if (next !== null) return goTo(rows[next]);
  if (event.key === (rtl ? "ArrowLeft" : "ArrowRight") && index >= 0 && rows[index]!.matches(FORWARD_ROWS)) {
    handled();
    rows[index]!.click();
    return;
  }
  const continuing = event.key === " " && typed.current !== null && event.timeStamp - typed.current.at < TYPEAHEAD_RESET_MS;
  if (!isTypeaheadKey(event) && !continuing) return;
  if (search) {
    search.focus();
    return;
  }
  if (continuing) handled();
  typed.current = typeaheadText(typed.current, event.key, event.timeStamp);
  const match = typeaheadMatch(rows.map((row) => row.textContent ?? ""), index, typed.current.text);
  if (match !== null) goTo(rows[match]);
}

/** A mouse moving over a model menu's rows takes keyboard focus with it, once a row already has it. */
export function modelMenuPointerMove(event: ReactPointerEvent<HTMLElement>): void {
  if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
  const row = event.target.closest<HTMLElement>("[data-menu-row]");
  const focused = document.activeElement;
  if (!row || row === focused || row.matches(":disabled") || !(focused instanceof HTMLElement)) return;
  if (focused.matches("[data-menu-row]") && event.currentTarget.contains(focused)) row.focus({ preventScroll: true });
}
