import type { ReactNode } from "react";
import { useHeldMenuMotion } from "./MenuMotion";

export function ModalPresence({ open, children }: { open: boolean; children: ReactNode }) {
  const { shown, closing, exitProps, value } = useHeldMenuMotion(open ? children : null);
  if (!shown) return null;
  return <div className="contents" data-modal-motion={closing ? "out" : "in"} {...exitProps}>{value}</div>;
}
