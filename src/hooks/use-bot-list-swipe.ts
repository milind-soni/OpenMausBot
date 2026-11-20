import { useRef, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";

type StagePointer = PointerEvent<HTMLDivElement>;
type Swipe = {
  id: number;
  chat: HTMLElement;
  x: number;
  y: number;
  direction: number;
  width: number;
  position: number;
  origin: number;
  sampleX: number;
  sampleAt: number;
  velocity: number;
  dragging: boolean;
};

const EDGE = 24;
const SLOP = 10;
const FLICK_DISTANCE = 24;
const FLICK_SPEED = 0.45;
const FLICK_AGE = 90;

export function useBotListSwipe(enabled: boolean, open: boolean, show: () => void, hide: () => void) {
  const swipe = useRef<Swipe | null>(null);
  const suppressClick = useRef(false);

  function track(event: StagePointer, drag: Swipe) {
    const x = event.clientX;
    if (x !== drag.sampleX && event.timeStamp > drag.sampleAt) {
      drag.velocity = (x - drag.sampleX) * drag.direction / (event.timeStamp - drag.sampleAt);
      drag.sampleAt = event.timeStamp;
      drag.sampleX = x;
    }
    drag.position = Math.min(drag.width, Math.max(0, drag.origin + (x - drag.x) * drag.direction));
    event.currentTarget.style.setProperty("--drawer-progress", String(drag.position / drag.width));
  }

  function finish(event: StagePointer, commit: boolean) {
    const drag = swipe.current;
    swipe.current = null;
    if (!drag?.dragging) return;

    const stage = event.currentTarget;
    if (commit) {
      track(event, drag);
      const distance = (event.clientX - drag.x) * drag.direction;
      const flick = Math.abs(distance) >= FLICK_DISTANCE &&
        event.timeStamp - drag.sampleAt <= FLICK_AGE && Math.abs(drag.velocity) >= FLICK_SPEED;
      const next = flick ? drag.velocity > 0 : drag.position > drag.width / 2;
      if (next !== open) flushSync(next ? show : hide);
    }
    drag.chat.getBoundingClientRect();
    stage.removeAttribute("data-drawer-dragging");
    stage.style.removeProperty("--drawer-progress");
    if (stage.hasPointerCapture(drag.id)) stage.releasePointerCapture(drag.id);
  }

  return {
    onPointerDown(event: StagePointer) {
      const { currentTarget: stage, target } = event;
      if (!(target instanceof Element) || !stage.contains(target)) return;
      if (!event.isPrimary) { finish(event, false); return; }
      suppressClick.current = false;
      finish(event, false);
      if (!enabled || event.button !== 0) return;
      const chat = stage.querySelector<HTMLElement>("[data-bot-list-chat]");
      if (!chat || !target.closest(open ? '[data-look="sidebar"]' : "[data-bot-list-chat], [data-bot-list-trigger]")) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.pointerType === "mouse" && target.closest('[draggable="true"]')) return;
      const bounds = stage.getBoundingClientRect();
      if (!bounds.width) return;
      const direction = getComputedStyle(stage).direction === "rtl" ? -1 : 1;
      const leading = direction === 1 ? event.clientX - bounds.left : bounds.right - event.clientX;
      if (!open && (leading < 0 || leading > EDGE)) return;
      swipe.current = {
        id: event.pointerId, chat, x: event.clientX, y: event.clientY, direction,
        width: bounds.width, position: 0, origin: 0,
        sampleX: event.clientX, sampleAt: event.timeStamp, velocity: 0, dragging: false,
      };
    },
    onPointerMove(event: StagePointer) {
      const drag = swipe.current;
      if (!drag || drag.id !== event.pointerId) return;
      if (!drag.dragging) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= SLOP) return;
        const stage = event.currentTarget;
        if (Math.abs(dx) <= Math.abs(dy) || (dx * drag.direction > 0) === open) {
          swipe.current = null;
          return;
        }
        drag.origin = (drag.chat.getBoundingClientRect().left - stage.getBoundingClientRect().left) * drag.direction;
        drag.dragging = true;
        suppressClick.current = true;
        stage.setPointerCapture(event.pointerId);
        stage.setAttribute("data-drawer-dragging", "");
      }
      track(event, drag);
    },
    onPointerUp(event: StagePointer) {
      if (swipe.current?.id === event.pointerId) finish(event, true);
    },
    onPointerLeave(event: StagePointer) {
      if (swipe.current?.id === event.pointerId && !swipe.current.dragging) finish(event, false);
    },
    onPointerCancel(event: StagePointer) {
      if (swipe.current?.id === event.pointerId) finish(event, false);
    },
    onLostPointerCapture(event: StagePointer) {
      if (event.target === event.currentTarget && swipe.current?.id === event.pointerId) finish(event, false);
    },
    onDragStart(event: DragEvent<HTMLDivElement>) {
      if (swipe.current) event.preventDefault();
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (!suppressClick.current || event.detail === 0 || !event.currentTarget.contains(event.target as Node)) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
