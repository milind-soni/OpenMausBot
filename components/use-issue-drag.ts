"use client";

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";

/** Where a card sits or will land: a column and an index among that column's other visible cards. */
export type DragSlot = { columnId: string; index: number };
export type IssueDrag = { taskId: string; mode: "pointer" | "keyboard"; origin: DragSlot; target: DragSlot; settling: boolean };

const LONG_PRESS_MS = 350;
const TOUCH_SLOP = 8;
const MOUSE_THRESHOLD = 5;
const SETTLE_MS = 180;
const FLIP_MS = 180;
const EASE = "cubic-bezier(.2, .8, .2, 1)";
const MAX_SCROLL_STEP = 18;

type Session = {
  taskId: string;
  pointerId: number;
  touch: boolean;
  card: HTMLElement;
  startX: number; startY: number; x: number; y: number;
  grabX: number; grabY: number; width: number; height: number;
  active: boolean;
  /** Touch only: the finger moved after the long-press lifted the card (a drag, not a press-and-release). */
  moved: boolean;
  /** The pointer went up; later pointer events (a click while the card settles) belong to someone else. */
  released: boolean;
  timer: number; frame: number; settleTimer: number;
  layer?: HTMLDivElement; ghost?: HTMLElement;
  pageScroller: HTMLElement | null;
  cleanup: (() => void)[];
};

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const cardSelector = (taskId: string) => `[data-task-id="${CSS.escape(taskId)}"]`;
const columnsOf = (board: HTMLElement) => [...board.querySelectorAll<HTMLElement>("[data-column-id]")];
const laneOf = (column: Element) => column.querySelector<HTMLElement>(".task-list");
const cardsOf = (lane: Element | null) => lane ? [...lane.children].filter((child): child is HTMLElement => child instanceof HTMLElement && Boolean(child.dataset.taskId)) : [];
const sameSlot = (a: DragSlot, b: DragSlot) => a.columnId === b.columnId && a.index === b.index;

function slotOf(board: HTMLElement, taskId: string): DragSlot | null {
  const card = board.querySelector<HTMLElement>(cardSelector(taskId));
  const column = card?.closest<HTMLElement>("[data-column-id]");
  if (!card || !column) return null;
  return { columnId: column.dataset.columnId!, index: cardsOf(card.parentElement).indexOf(card) };
}

function otherCount(board: HTMLElement, columnId: string, taskId: string) {
  const column = columnsOf(board).find(item => item.dataset.columnId === columnId);
  return column ? cardsOf(laneOf(column)).filter(card => card.dataset.taskId !== taskId).length : 0;
}

function columnTitle(board: HTMLElement, columnId: string) {
  return columnsOf(board).find(item => item.dataset.columnId === columnId)?.dataset.columnTitle || "column";
}

/** Scroll step for a pointer near (or past) the start/end edge of a scroll area. */
function edgeStep(position: number, start: number, end: number, zone: number) {
  const strength = (depth: number) => Math.ceil(Math.min(1, depth / zone) ** 2 * MAX_SCROLL_STEP);
  if (position < start + zone) return -strength(start + zone - position);
  if (position > end - zone) return strength(position - (end - zone));
  return 0;
}

function verticalScroller(from: HTMLElement) {
  for (let element = from.parentElement; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight) return element;
  }
  const root = document.scrollingElement as HTMLElement | null;
  return root && root.scrollHeight > root.clientHeight ? root : null;
}

/** Index in `lane` (among its cards other than the dragged one) whose slot centre is closest to the ghost's centre. */
function insertionIndex(lane: HTMLElement, session: Session) {
  const cards = cardsOf(lane);
  const gap = parseFloat(getComputedStyle(lane).rowGap) || 0;
  const shift = session.height + gap;
  // Measure the other cards as if the placeholder were not in this lane, so the result never depends on itself.
  const others: { top: number; height: number }[] = [];
  let afterPlaceholder = false;
  for (const card of cards) {
    if (card.dataset.taskId === session.taskId) { afterPlaceholder = true; continue; }
    others.push({ top: card.offsetTop - (afterPlaceholder ? shift : 0), height: card.offsetHeight });
  }
  if (!others.length) return 0;
  const box = lane.getBoundingClientRect();
  const centre = session.y - session.grabY + session.height / 2 - box.top - lane.clientTop + lane.scrollTop;
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index <= others.length; index += 1) {
    const last = others[others.length - 1]!;
    const top = index < others.length ? others[index]!.top : last.top + last.height + gap;
    const distance = Math.abs(centre - (top + session.height / 2));
    if (distance < bestDistance) { best = index; bestDistance = distance; }
  }
  return best;
}

/** `EASE` as a function of time (0..1), for movement driven from script. */
function ease(t: number) {
  const [x1, y1, x2, y2] = [0.2, 0.8, 0.2, 1];
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let s = t;
  for (let step = 0; step < 8; step += 1) {
    const dx = 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s;
    if (Math.abs(dx) < 1e-6) break;
    s = Math.min(1, Math.max(0, s - (at(x1, x2, s) - t) / dx));
  }
  return at(y1, y2, s);
}

/** How far the board must scroll so the lane holding `card` sits on its snap position (0 where lanes do not snap). */
function snapShift(root: HTMLElement | null, card: HTMLElement) {
  const column = card.closest<HTMLElement>("[data-column-id]");
  if (!root || !column || !getComputedStyle(column).scrollSnapAlign.includes("start")) return 0;
  const padding = parseFloat(getComputedStyle(root).scrollPaddingLeft) || 0;
  const wanted = root.scrollLeft + column.getBoundingClientRect().left - root.getBoundingClientRect().left - padding;
  const shift = Math.round(Math.max(0, Math.min(root.scrollWidth - root.clientWidth, wanted)) - root.scrollLeft);
  return Math.abs(shift) >= 1 ? shift : 0;
}

/** Scrolls the board by `shift` over the settle glide, on the ghost's curve. */
function glideScroll(root: HTMLElement, shift: number, active: Session) {
  const from = root.scrollLeft;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / SETTLE_MS);
    root.scrollLeft = from + shift * ease(t);
    if (t < 1) active.frame = requestAnimationFrame(step);
  };
  active.frame = requestAnimationFrame(step);
}

/**
 * Swallows the click the browser sends right after a drag ends, so dropping a card does not open it. Only that click
 * is eaten: it follows the pointerup within the same input event, while a real click needs a fresh pointerdown first.
 */
export function swallowNextClick(upTime: number) {
  const block = (event: MouseEvent) => {
    remove();
    if (event.timeStamp - upTime > 120) return;
    event.preventDefault(); event.stopPropagation();
  };
  const remove = () => {
    window.removeEventListener("click", block, { capture: true });
    window.removeEventListener("pointerdown", remove, { capture: true });
  };
  window.addEventListener("click", block, { capture: true });
  window.addEventListener("pointerdown", remove, { capture: true });
  window.setTimeout(remove, 400);
}

/**
 * Pointer (mouse, pen, touch long-press) and keyboard dragging of board cards.
 * The board renders `drag.target` as a placeholder slot; `onMove` persists the final slot.
 */
export function useIssueDrag({ rootRef, enabled, onMove, onPressMenu }: {
  rootRef: RefObject<HTMLElement | null>; enabled: boolean; onMove: (taskId: string, target: DragSlot) => void;
  /** Touch long-press released without moving: the card's menu opens instead of a drag. */
  onPressMenu?: (taskId: string, card: HTMLElement) => void;
}) {
  const [drag, setDrag] = useState<IssueDrag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dragRef = useRef<IssueDrag | null>(null);
  const session = useRef<Session | null>(null);
  const onMoveRef = useRef(onMove);
  const onPressMenuRef = useRef(onPressMenu);
  const keyHandledAt = useRef(0);
  useLayoutEffect(() => { onMoveRef.current = onMove; onPressMenuRef.current = onPressMenu; });

  const board = useCallback(() => rootRef.current?.querySelector<HTMLElement>(".kanban-scroll") ?? null, [rootRef]);
  const update = useCallback((next: IssueDrag | null) => { dragRef.current = next; setDrag(next); }, []);

  const end = useCallback((current: Session | null) => {
    if (!current) return;
    window.clearTimeout(current.timer);
    window.clearTimeout(current.settleTimer);
    cancelAnimationFrame(current.frame);
    current.cleanup.forEach(run => run());
    current.layer?.remove();
    document.documentElement.classList.remove("issue-dragging");
    if (session.current === current) session.current = null;
  }, []);

  /** Ends a settled drag: persists the move (optimistically) and swaps the ghost for the real card in one frame. */
  const finish = useCallback(() => {
    const current = dragRef.current;
    if (current) {
      flushSync(() => {
        if (!sameSlot(current.target, current.origin)) onMoveRef.current(current.taskId, current.target);
        update(null);
      });
      // The landed card stays exactly where the ghost put it: no hover lift under the pointer until it leaves.
      const card = board()?.querySelector<HTMLElement>(cardSelector(current.taskId));
      if (card && session.current && !session.current.touch) {
        card.setAttribute("data-landed", "");
        const leave = (event: PointerEvent) => {
          if (card.isConnected && card.contains(event.target as Node)) return;
          card.removeAttribute("data-landed");
          window.removeEventListener("pointermove", leave, true);
        };
        window.addEventListener("pointermove", leave, true);
      }
    }
    end(session.current);
  }, [board, end, update]);

  const settle = useCallback((cancel: boolean) => {
    const current = dragRef.current;
    const active = session.current;
    if (!current || current.settling) return;
    if (active) cancelAnimationFrame(active.frame);
    update({ ...current, target: cancel ? current.origin : current.target, settling: true });
  }, [update]);

  const hitTest = useCallback((active: Session) => {
    const root = board();
    const current = dragRef.current;
    if (!root || !current || current.settling) return;
    const columns = columnsOf(root);
    if (!columns.length) return;
    const boxes = columns.map(column => column.getBoundingClientRect());
    let index = boxes.findIndex(box => active.x >= box.left && active.x <= box.right);
    if (index < 0 && active.x < boxes[0]!.left) index = 0;
    if (index < 0 && active.x > boxes[boxes.length - 1]!.right) index = columns.length - 1;
    if (index < 0) index = columns.findIndex(column => column.dataset.columnId === current.target.columnId);
    const column = columns[index];
    if (!column) return;
    const lane = laneOf(column);
    const target = { columnId: column.dataset.columnId!, index: lane ? insertionIndex(lane, active) : 0 };
    if (!sameSlot(target, current.target)) update({ ...current, target });
  }, [board, update]);

  const autoScroll = useCallback((active: Session) => {
    const root = board();
    const current = dragRef.current;
    if (!root || !current) return;
    const box = root.getBoundingClientRect();
    const dx = root.scrollWidth > root.clientWidth ? edgeStep(active.x, box.left, box.right, Math.min(72, box.width * 0.15)) : 0;
    if (dx) root.scrollLeft += dx;
    const column = columnsOf(root).find(item => item.dataset.columnId === current.target.columnId);
    const lane = column && laneOf(column);
    if (lane && lane.scrollHeight > lane.clientHeight) {
      const laneBox = lane.getBoundingClientRect();
      if (active.x >= laneBox.left && active.x <= laneBox.right) {
        const dy = edgeStep(active.y, laneBox.top, laneBox.bottom, Math.min(56, laneBox.height * 0.2));
        if (dy) lane.scrollTop += dy;
      }
    }
    const page = active.pageScroller;
    if (page) {
      const pageBox = page === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : page.getBoundingClientRect();
      const top = Math.max(0, pageBox.top);
      const bottom = Math.min(window.innerHeight, pageBox.bottom);
      const dy = edgeStep(active.y, top, bottom, Math.min(56, (bottom - top) * 0.12));
      if (dy) page.scrollTop += dy;
    }
  }, [board]);

  const activate = useCallback((active: Session) => {
    const root = board();
    const slot = root && slotOf(root, active.taskId);
    if (!root || !slot || dragRef.current) { end(active); return; }
    window.clearTimeout(active.timer);
    active.active = true;
    const box = active.card.getBoundingClientRect();
    Object.assign(active, { grabX: active.startX - box.left, grabY: active.startY - box.top, width: box.width, height: box.height, pageScroller: verticalScroller(root) });

    const layer = document.createElement("div");
    layer.className = "task-drag-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    Object.assign(layer.style, { width: `${box.width}px`, transform: `translate3d(${active.x - active.grabX}px, ${active.y - active.grabY}px, 0)` });
    const ghost = active.card.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-task-id");
    ghost.removeAttribute("tabindex");
    ghost.classList.add("task-ghost");
    ghost.style.height = `${box.height}px`;
    layer.appendChild(ghost);
    (active.card.closest(".workspace-app") ?? document.body).appendChild(layer);
    active.layer = layer;
    active.ghost = ghost;

    document.documentElement.classList.add("issue-dragging");
    window.getSelection()?.removeAllRanges();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      settle(true);
    };
    window.addEventListener("keydown", escape, true);
    const blur = () => settle(true);
    window.addEventListener("blur", blur);
    active.cleanup.push(() => { window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", blur); });
    if (active.touch) navigator.vibrate?.(8);
    update({ taskId: active.taskId, mode: "pointer", origin: slot, target: slot, settling: false });
    const frame = () => {
      if (session.current !== active || dragRef.current?.settling) return;
      autoScroll(active);
      layer.style.transform = `translate3d(${active.x - active.grabX}px, ${active.y - active.grabY}px, 0)`;
      hitTest(active);
      active.frame = requestAnimationFrame(frame);
    };
    active.frame = requestAnimationFrame(frame);
  }, [autoScroll, board, end, hitTest, settle, update]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, taskId: string) => {
    if (!enabled || dragRef.current || session.current || !event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as Element).closest("button:not(.drag-handle), a, input, textarea, select, .task-actions")) return;
    const touch = event.pointerType === "touch";
    const active: Session = {
      taskId, pointerId: event.pointerId, touch, card: event.currentTarget,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      grabX: 0, grabY: 0, width: 0, height: 0, active: false, moved: false, released: false, timer: 0, frame: 0, settleTimer: 0, pageScroller: null, cleanup: [],
    };
    session.current = active;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId || active.released) return;
      active.x = pointer.clientX;
      active.y = pointer.clientY;
      if (active.active) {
        if (touch && !active.moved && Math.hypot(active.x - active.startX, active.y - active.startY) > TOUCH_SLOP * 1.5) active.moved = true;
        return;
      }
      const distance = Math.hypot(active.x - active.startX, active.y - active.startY);
      // Touch lifts only after a still long-press; moving first means the finger is scrolling.
      if (touch) { if (distance > TOUCH_SLOP) end(active); return; }
      if (distance >= MOUSE_THRESHOLD) activate(active);
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId || active.released) return;
      active.released = true;
      if (!active.active) { end(active); return; }
      swallowNextClick(pointer.timeStamp);
      if (touch && !active.moved && onPressMenuRef.current) {
        // Long-press and release in place: put the card back and open its menu.
        const card = active.card;
        settle(true);
        onPressMenuRef.current(active.taskId, card);
        return;
      }
      hitTest(active);
      settle(false);
    };
    const cancel = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId || active.released) return;
      if (active.active) settle(true); else end(active);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    active.cleanup.push(() => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    });
    if (touch) {
      // Once the long-press lifts the card, the finger drags it instead of scrolling the page.
      // Touch events keep targeting the pressed card even after the board re-renders it into another lane and the
      // original node is detached, so the card itself must cancel them too (a detached node's events never reach document).
      const blockScroll = (touchEvent: TouchEvent) => { if (active.active && touchEvent.cancelable) touchEvent.preventDefault(); };
      const blockMenu = (menuEvent: Event) => menuEvent.preventDefault();
      const card = active.card;
      document.addEventListener("touchmove", blockScroll, { passive: false });
      card.addEventListener("touchmove", blockScroll, { passive: false });
      window.addEventListener("contextmenu", blockMenu);
      card.addEventListener("contextmenu", blockMenu);
      active.cleanup.push(() => {
        document.removeEventListener("touchmove", blockScroll);
        card.removeEventListener("touchmove", blockScroll);
        window.removeEventListener("contextmenu", blockMenu);
        card.removeEventListener("contextmenu", blockMenu);
      });
      active.timer = window.setTimeout(() => activate(active), LONG_PRESS_MS);
    }
  }, [activate, enabled, end, hitTest, settle]);

  // Glide the ghost into its slot once the slot has rendered, then commit.
  useLayoutEffect(() => {
    const active = session.current;
    if (!drag?.settling || drag.mode !== "pointer" || !active?.layer || active.settleTimer) return;
    const placeholder = board()?.querySelector<HTMLElement>(cardSelector(drag.taskId));
    if (!placeholder || reducedMotion()) { active.settleTimer = window.setTimeout(finish, 0); return; }
    placeholder.getAnimations().forEach(animation => animation.finish());
    const box = placeholder.getBoundingClientRect();
    // Where lanes snap (phones), bring the lane to its snap position together with the glide, so the board does not
    // snap on its own after the card has landed.
    const shift = snapShift(board(), placeholder);
    if (shift) glideScroll(board()!, shift, active);
    active.layer.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
    active.layer.style.transform = `translate3d(${box.left - shift}px, ${box.top}px, 0)`;
    active.ghost?.classList.add("is-settling");
    active.settleTimer = window.setTimeout(finish, SETTLE_MS + 20);
  }, [board, drag, finish]);

  // Keep keyboard focus on the moving card's handle while it changes lanes, and keep it in view.
  useLayoutEffect(() => {
    if (drag?.mode !== "keyboard") return;
    const card = board()?.querySelector<HTMLElement>(cardSelector(drag.taskId));
    const handle = card?.querySelector<HTMLElement>(".drag-handle");
    if (handle && document.activeElement !== handle) handle.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [board, drag]);

  const describe = useCallback((root: HTMLElement, slot: DragSlot, taskId: string) =>
    `${columnTitle(root, slot.columnId)}, position ${slot.index + 1} of ${otherCount(root, slot.columnId, taskId) + 1}`, []);

  const startKeyboard = useCallback((taskId: string) => {
    const root = board();
    const slot = root && slotOf(root, taskId);
    if (!root || !slot || dragRef.current || session.current) return;
    update({ taskId, mode: "keyboard", origin: slot, target: slot, settling: false });
    setAnnouncement(`Picked up. ${describe(root, slot, taskId)}. Use arrow keys to move, Space to drop, Escape to cancel.`);
  }, [board, describe, update]);

  const stopKeyboard = useCallback((commit: boolean, refocus = true) => {
    const current = dragRef.current;
    const root = board();
    if (!current || current.mode !== "keyboard" || !root) return;
    if (commit && !sameSlot(current.target, current.origin)) onMoveRef.current(current.taskId, current.target);
    const handle = root.querySelector<HTMLElement>(`${cardSelector(current.taskId)} .drag-handle`);
    const hadFocus = refocus && document.activeElement === handle;
    update(null);
    // The handle is only a keyboard target while moving; hand focus back to the card itself.
    if (hadFocus) requestAnimationFrame(() => {
      if (document.activeElement === handle || document.activeElement === document.body) root.querySelector<HTMLElement>(cardSelector(current.taskId))?.focus({ preventScroll: true });
    });
    setAnnouncement(commit ? `Dropped. ${describe(root, current.target, current.taskId)}.` : "Move cancelled.");
  }, [board, describe, update]);

  const onHandleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>, taskId: string) => {
    const current = dragRef.current;
    const root = board();
    if (!enabled || !root) return;
    const activateKey = event.key === " " || event.key === "Enter";
    if (!current) {
      if (!activateKey) return;
      event.preventDefault(); event.stopPropagation();
      keyHandledAt.current = Date.now();
      startKeyboard(taskId);
      return;
    }
    if (current.mode !== "keyboard" || current.taskId !== taskId) return;
    if (event.key === "Tab") { stopKeyboard(false, false); return; }
    const columns = columnsOf(root).map(column => column.dataset.columnId!);
    let target = current.target;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const max = otherCount(root, target.columnId, taskId);
      target = { ...target, index: Math.max(0, Math.min(max, target.index + (event.key === "ArrowUp" ? -1 : 1))) };
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const position = columns.indexOf(target.columnId) + (event.key === "ArrowLeft" ? -1 : 1);
      const columnId = columns[Math.max(0, Math.min(columns.length - 1, position))]!;
      target = { columnId, index: Math.min(target.index, otherCount(root, columnId, taskId)) };
    } else if (activateKey) {
      event.preventDefault(); event.stopPropagation();
      keyHandledAt.current = Date.now();
      stopKeyboard(true);
      return;
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      stopKeyboard(false);
      return;
    } else return;
    event.preventDefault(); event.stopPropagation();
    if (sameSlot(target, current.target)) return;
    update({ ...current, target });
    setAnnouncement(describe(root, target, taskId));
  }, [board, describe, enabled, startKeyboard, stopKeyboard, update]);

  /** Keyboard and assistive-technology activation of the handle (clicks with no pointer) start a keyboard move. */
  const onHandleClick = useCallback((event: ReactMouseEvent<HTMLElement>, taskId: string) => {
    if (event.detail !== 0) return;
    event.preventDefault(); event.stopPropagation();
    if (Date.now() - keyHandledAt.current < 800) return;
    if (!dragRef.current) startKeyboard(taskId);
  }, [startKeyboard]);

  const onHandleBlur = useCallback((taskId: string) => {
    window.setTimeout(() => {
      const current = dragRef.current;
      if (current?.mode !== "keyboard" || current.taskId !== taskId) return;
      const handle = board()?.querySelector(`${cardSelector(taskId)} .drag-handle`);
      if (document.activeElement !== handle) stopKeyboard(false, false);
    }, 0);
  }, [board, stopKeyboard]);

  useLayoutEffect(() => () => end(session.current), [end]);

  /** Starts a keyboard move of a card (Space on a focused card); focus moves to its handle while moving. */
  const pickUp = useCallback((taskId: string) => {
    if (!enabled) return;
    keyHandledAt.current = Date.now();
    startKeyboard(taskId);
  }, [enabled, startKeyboard]);

  return { drag, announcement, onPointerDown, onHandleKeyDown, onHandleClick, onHandleBlur, pickUp };
}

/**
 * FLIP for board cards: whenever a render moves a card (drag preview, drop, remote update, filter), it animates
 * from where it was drawn to its new slot. Positions are layout offsets, so scrolling never animates anything.
 */
export function useCardFlip(rootRef: RefObject<HTMLElement | null>) {
  const positions = useRef(new Map<string, { x: number; y: number; column: string }>());
  const animations = useRef(new WeakMap<HTMLElement, Animation>());
  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>(".kanban-scroll");
    if (!board) { positions.current = new Map(); return; }
    const reduced = reducedMotion();
    const next = new Map<string, { x: number; y: number; column: string }>();
    const moves: { card: HTMLElement; dx: number; dy: number; laneChanged: boolean }[] = [];
    board.querySelectorAll<HTMLElement>("[data-task-id]").forEach(card => {
      const column = card.closest<HTMLElement>("[data-column-id]")?.dataset.columnId ?? "";
      let x = 0;
      let y = 0;
      for (let element: HTMLElement | null = card; element && element !== board; element = element.offsetParent as HTMLElement | null) { x += element.offsetLeft; y += element.offsetTop; }
      const id = card.dataset.taskId!;
      next.set(id, { x, y, column });
      const previous = positions.current.get(id);
      // A lane whose card is collapsing away (completed) already moves its other cards; never animate that twice.
      if (!previous || reduced || card.parentElement?.hasAttribute("data-collapsing")) return;
      const dx = previous.x - x;
      const dy = previous.y - y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      moves.push({ card, dx, dy, laneChanged: previous.column !== column });
    });
    positions.current = next;
    // Read every in-flight offset before starting new animations, so a card that is mid-move continues from where it is drawn.
    const offsets = moves.map(({ card }) => {
      const running = animations.current.get(card);
      if (running?.playState !== "running") return { x: 0, y: 0 };
      const transform = getComputedStyle(card).transform;
      if (!transform || transform === "none") return { x: 0, y: 0 };
      const matrix = new DOMMatrixReadOnly(transform);
      return { x: matrix.m41, y: matrix.m42 };
    });
    moves.forEach(({ card, dx, dy, laneChanged }, index) => {
      animations.current.get(card)?.cancel();
      let animation: Animation;
      if (card.classList.contains("is-placeholder") && laneChanged) {
        animation = card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
      } else if (laneChanged) {
        animation = card.animate([{ opacity: 0.4, transform: `translate3d(${Math.sign(dx) * 28}px, 0, 0)` }, { opacity: 1, transform: "none" }], { duration: FLIP_MS, easing: EASE });
      } else {
        const offset = offsets[index]!;
        animation = card.animate([{ transform: `translate3d(${dx + offset.x}px, ${dy + offset.y}px, 0)` }, { transform: "none" }], { duration: FLIP_MS, easing: EASE });
      }
      animations.current.set(card, animation);
    });
  });
}
