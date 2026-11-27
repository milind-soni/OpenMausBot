import { useEffect, useRef, type RefObject } from "react";

export function popoverClosesOnKey(event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing">): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !event.isComposing;
}

type Containing = { contains(target: unknown): boolean };

export function popoverClosesOnPointer(target: EventTarget | null, root: Containing | null): boolean {
  if (!target || !root) return false;
  const closest = (target as Partial<Element>).closest;
  if (typeof closest === "function" && closest.call(target, "[data-tour-card]")) return false;
  return !root.contains(target);
}

export function usePopoverDismiss(open: boolean, rootRef: RefObject<Containing | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (!popoverClosesOnKey(event)) return;
      event.preventDefault();
      closeRef.current();
    };
    const onDown = (event: PointerEvent) => {
      if (popoverClosesOnPointer(event.target, rootRef.current)) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, rootRef]);
}
