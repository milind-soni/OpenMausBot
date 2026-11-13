import { useEffect, useRef } from "react";

export const DEFAULT_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function resolveDialogInvoker(
  triggerRef?: React.RefObject<HTMLElement | null> | HTMLElement | null,
  activeElement?: HTMLElement | null,
): HTMLElement | null {
  if (triggerRef && "current" in triggerRef) {
    if (triggerRef.current) return triggerRef.current;
  } else if (triggerRef) {
    return triggerRef;
  }
  if (
    activeElement &&
    activeElement !== (typeof document !== "undefined" ? document.body : null)
  ) {
    return activeElement;
  }
  return null;
}

export function restoreDialogFocus(invoker: HTMLElement | null): boolean {
  if (!invoker || typeof invoker.focus !== "function" || invoker.isConnected === false) {
    return false;
  }
  try {
    invoker.focus();
  } catch {
    return false;
  }

  // If the browser resets focus to document.body during unmount DOM mutations,
  // ensure focus is returned to the invoker on the next frame.
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      if (
        invoker &&
        typeof invoker.focus === "function" &&
        invoker.isConnected !== false &&
        typeof document !== "undefined" &&
        document.activeElement === document.body
      ) {
        try {
          invoker.focus();
        } catch {
          // ignore
        }
      }
    });
  }
  return true;
}

export function trapDialogFocus(
  e: KeyboardEvent,
  container: HTMLElement | null,
  focusableSelector = DEFAULT_FOCUSABLE_SELECTOR,
): boolean {
  if (e.key !== "Tab" || !container) return false;
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  );
  if (focusables.length === 0) return false;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  if (e.shiftKey) {
    if (!active || active === first || !container.contains(active)) {
      e.preventDefault();
      last.focus();
      return true;
    }
  } else if (!active || active === last || !container.contains(active)) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export interface UseDialogFocusOptions {
  open: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  entryFocusRef?: React.RefObject<HTMLElement | null>;
  triggerRef?: React.RefObject<HTMLElement | null> | HTMLElement | null;
  onClose: () => void;
  focusableSelector?: string;
}

export function useDialogFocus({
  open,
  containerRef,
  entryFocusRef,
  triggerRef,
  onClose,
  focusableSelector = DEFAULT_FOCUSABLE_SELECTOR,
}: UseDialogFocusOptions) {
  const invokerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    // 1. Record invoker before entry focus moves focus to a modal child
    const invoker = resolveDialogInvoker(
      triggerRef,
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null,
    );
    invokerRef.current = invoker;

    // 2. Set entry focus inside the dialog
    entryFocusRef?.current?.focus();

    // 3. Handle Escape dismissal and Tab trap
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab") {
        trapDialogFocus(e, containerRef.current, focusableSelector);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);

    // 4. On close/unmount: return focus to the recorded invoker
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      restoreDialogFocus(invokerRef.current);
    };
  }, [open, triggerRef, containerRef, entryFocusRef, focusableSelector]);
}
