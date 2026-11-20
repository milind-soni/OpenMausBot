import { useRef, type MouseEvent, type PointerEvent } from "react";

export function useHorizontalDrag(
  canStart: (event: PointerEvent<HTMLDivElement>) => boolean,
  track: (element: HTMLDivElement, dx: number | null) => void,
  release: (dx: number) => void,
) {
  const gesture = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const reset = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.dragging) track(event.currentTarget, null);
    gesture.current = null;
  };

  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (!event.currentTarget.contains(event.target as Node)) return;
      if (!event.isPrimary) { reset(event); return; }
      suppressClick.current = false;
      reset(event);
      if (event.button !== 0 || !canStart(event)) return;
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const start = gesture.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!start.dragging) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= 10) return;
        if (Math.abs(dx) <= Math.abs(dy)) { reset(event); return; }
        start.dragging = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      track(event.currentTarget, dx);
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      const start = gesture.current;
      if (start?.id !== event.pointerId) return;
      reset(event);
      if (start.dragging) release(event.clientX - start.x);
    },
    onPointerLeave(event: PointerEvent<HTMLDivElement>) {
      if (!gesture.current?.dragging) reset(event);
    },
    onPointerCancel: reset,
    onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
      if (event.target === event.currentTarget) reset(event);
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (!suppressClick.current || event.detail === 0 || !event.currentTarget.contains(event.target as Node)) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
