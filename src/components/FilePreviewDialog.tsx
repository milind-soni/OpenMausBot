import { useLayoutEffect, useId, useRef, type ReactNode } from "react";
import { overlayPortal as createPortal } from "@/components/ModalPresence";
import { X } from "lucide-react";
import { useDismissMotion } from "./MenuMotion";
import { t } from "@/lib/i18n";

/** The native modal supplies focus containment, Escape, an inert background and focus restoration. */
export function FilePreviewDialog({ title, onClose, children, returnFocus }: { title: string; onClose: () => void; children: ReactNode; returnFocus: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const motion = useDismissMotion(onClose);
  useLayoutEffect(() => {
    if (!motion.open) return;
    const dialog = ref.current!;
    const active = document.activeElement;
    if (!returnFocus && active instanceof HTMLElement && !dialog.contains(active)) active.blur();
    dialog.showModal();
    return () => { dialog.close(); if (returnFocus?.isConnected) returnFocus.focus(); };
  }, [motion.open, returnFocus]);
  if (!motion.shown) return null;
  return createPortal(
    <dialog ref={ref} inert={!motion.open} aria-labelledby={id} onCancel={(event) => { event.preventDefault(); motion.dismiss(); }}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      className="fading-dialog m-auto open:flex max-h-[94dvh] w-[min(96vw,1400px)] max-w-none flex-col overflow-hidden rounded-2xl border border-hairline bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/55">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/40 px-4 py-3">
        <h2 id={id} className="min-w-0 truncate text-sm font-medium">{title}</h2>
        <button type="button" autoFocus onClick={motion.dismiss} className="table-action" aria-label={t("table.close")}><X size={16} /></button>
      </header>
      <div className="min-h-0 overflow-auto p-3 sm:p-5">{children}</div>
    </dialog>, document.body,
  );
}
