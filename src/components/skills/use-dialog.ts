import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

/** Focus moves into the dialog and back to where it was; Escape closes it unless a menu inside took that press first
 * (it marks the press handled), and Tab stays inside. Keys from a dialog opened over this one reach it as React events,
 * so the topmost dialog answers first. */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    if (dialog && !dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>("input, textarea") ?? dialog).focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [ref]);
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close.current();
      return;
    }
    if (event.key !== "Tab") return;
    event.stopPropagation();
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return event.preventDefault();
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
