// How a small anchored popover (a dropdown under a header button, the menus at
// the foot of the sidebar) gets out of the way: Escape, or a press anywhere
// outside it. There is deliberately no invisible full-window backdrop — a
// backdrop swallows the very click the user aimed at something else, so the
// first click only closes the menu and a second one is needed.
import { useEffect, useRef, type RefObject } from "react";

/** Escape closes the popover unless something closer to the user already
 * handled it — an editor closing its own suggestion list, an IME composing. */
export function popoverClosesOnKey(event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing">): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !event.isComposing;
}

type Containing = { contains(target: unknown): boolean };

/** A press closes the popover when it lands outside it. The guided tour's
 * card floats outside every menu but is talking about it, so it never counts. */
export function popoverClosesOnPointer(target: EventTarget | null, root: Containing | null): boolean {
  if (!target || !root) return false;
  const closest = (target as Partial<Element>).closest;
  if (typeof closest === "function" && closest.call(target, "[data-tour-card]")) return false;
  return !root.contains(target);
}

/** Bound only while `open`; `rootRef` wraps both the trigger and the popover,
 * so pressing the trigger is left to its own toggle. */
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
