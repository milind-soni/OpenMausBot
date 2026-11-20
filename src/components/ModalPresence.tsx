import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useHeldMenuMotion } from "./MenuMotion";

const OverlayPhase = createContext<"in" | "out" | null>(null);

export function OverlaySurface({ children }: { children: ReactNode }) {
  const phase = useContext(OverlayPhase);
  if (!phase) return children;
  return <div className="contents" data-modal-motion={phase} inert={phase === "out"} aria-hidden={phase === "out" || undefined}>{children}</div>;
}

export function overlayPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null) {
  return createPortal(<OverlaySurface>{children}</OverlaySurface>, container, key);
}

export function ModalPresence({ open, children }: { open: boolean; children: ReactNode }) {
  const motion = useHeldMenuMotion(open ? children : null);
  if (!motion.shown) return null;
  return <OverlayPhase.Provider value={motion.closing ? "out" : "in"}><OverlaySurface>{motion.value}</OverlaySurface></OverlayPhase.Provider>;
}

export function OverlayPresence({ children }: { children: ReactNode }) {
  return <ModalPresence open={Boolean(children)}>{children}</ModalPresence>;
}
