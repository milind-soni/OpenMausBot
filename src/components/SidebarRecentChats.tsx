import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Position = { left: number; top: number };

export function useRecentChatsPopup() {
  const [popover, setPopover] = useState<Position | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const closeLater = () => { cancelClose(); closeTimer.current = setTimeout(() => setPopover(null), 250); };
  const openPopover = () => {
    if (!rowRef.current) return;
    cancelClose();
    const rect = rowRef.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    setPopover({ left: Math.max(8, Math.min(rect.right, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 180)) });
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!popover) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setPopover(null); };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [popover]);
  return { popover, setPopover, rowRef, cancelClose, closeLater, openPopover };
}

export function RecentChatsPopup({ botId, position, onEnter, onLeave, children }: { botId: string; position: Position; onEnter: () => void; onLeave: () => void; children: ReactNode }) {
  return createPortal(<div data-recent-chats-popup={botId} onMouseEnter={onEnter} onMouseLeave={onLeave}
    style={{ position: "fixed", left: position.left, top: position.top, width: "min(320px, calc(100vw - 16px))", maxHeight: `min(70vh, ${window.innerHeight - position.top - 8}px)`, zIndex: 100 }}
    className="overflow-y-auto rounded-xl border border-edge bg-panel p-2 shadow-xl">{children}</div>, document.body);
}
