import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type Position = { left: number; top: number };

export function useRecentChatsPopup() {
  const [popover, setPopover] = useState<Position | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayObserver = useRef<MutationObserver | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef(false);
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); overlayObserver.current?.disconnect(); overlayObserver.current = null; };
  const closeLater = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (document.querySelector("[data-thread-overlay]")) {
        overlayObserver.current = new MutationObserver(() => {
          if (!document.querySelector("[data-thread-overlay]")) closeLater();
        });
        overlayObserver.current.observe(document.body, { childList: true, subtree: true });
        return;
      }
      if (popupRef.current?.contains(document.activeElement)) return;
      setPopover(null);
    }, 250);
  };
  const position = () => {
    if (!rowRef.current) return;
    const rect = rowRef.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    setPopover({ left: Math.max(8, Math.min(rect.right, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 180)) });
  };
  const openPopover = (keyboard = false) => { cancelClose(); keyboardOpen.current = keyboard; position(); };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); overlayObserver.current?.disconnect(); }, []);
  useEffect(() => {
    if (!popover) return;
    if (keyboardOpen.current) { keyboardOpen.current = false; (popupRef.current?.querySelector<HTMLElement>('button:not([disabled])') ?? popupRef.current)?.focus(); }
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") { setPopover(null); rowRef.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus(); } };
    const focus = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && !popupRef.current?.contains(target) && !rowRef.current?.contains(target) && !(target instanceof Element && target.closest('[data-thread-overlay]'))) setPopover(null);
    };
    const click = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !popupRef.current?.contains(target) && !rowRef.current?.contains(target) && !(target instanceof Element && target.closest('[data-thread-overlay]'))) setPopover(null);
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("focusin", focus);
    window.addEventListener("pointerdown", click);
    window.addEventListener("resize", position);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popupRef.current?.contains(event.target)) position(); };
    window.addEventListener("scroll", scroll, true);
    return () => { window.removeEventListener("keydown", dismiss); window.removeEventListener("focusin", focus); window.removeEventListener("pointerdown", click); window.removeEventListener("resize", position); window.removeEventListener("scroll", scroll, true); };
  }, [Boolean(popover)]);
  return { popover, setPopover, rowRef, popupRef, cancelClose, closeLater, openPopover };
}

export function RecentChatsPopup({ popupRef, botId, position, onEnter, onLeave, children }: { popupRef: RefObject<HTMLDivElement | null>; botId: string; position: Position; onEnter: () => void; onLeave: () => void; children: ReactNode }) {
  return createPortal(<div ref={popupRef} tabIndex={-1} data-recent-chats-popup={botId} onMouseEnter={onEnter} onMouseLeave={onLeave}
    style={{ position: "fixed", left: position.left, top: position.top, width: "min(320px, calc(100vw - 16px))", maxHeight: `min(70vh, ${window.innerHeight - position.top - 8}px)`, zIndex: 45 }}
    className="overflow-y-auto rounded-xl border border-edge bg-panel p-2 shadow-xl">{children}</div>, document.body);
}
