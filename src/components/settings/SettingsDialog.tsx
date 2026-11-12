import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { Layer } from "../Layer";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A dialog's title and its close button on one line: the 32 px button centred on the 16/22 title. */
export function DialogTitle({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="-my-[5px] -mr-2 flex items-center justify-between gap-2" data-dialog-title="">
      <div className="min-w-0 text-[16px] font-semibold leading-[22px] text-ink">{title}</div>
      <button type="button" onClick={onClose} aria-label={t("common.close")}
        className="ui-icon-button size-8 shrink-0 cursor-pointer rounded-full text-ink-secondary hover:bg-menu-hover hover:text-ink">
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** A small dialog over Settings: 440 wide, a 16/22 title, the 32 px close at 12/12, and its buttons at the bottom
 * right with the one primary last. It keeps Escape and Tab to itself while open. */
export function SettingsDialog({ title, onClose, children, footer, label }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; label?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.querySelector<HTMLElement>("input, textarea, select, button[data-autofocus]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      const box = root.current;
      if (!box || event.defaultPrevented || event.isComposing || (event.key !== "Escape" && event.key !== "Tab")) return;
      event.preventDefault();
      if (event.key === "Escape") { close.current(); return; }
      const controls = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((control) => control.getClientRects().length);
      if (!controls.length) return;
      const at = controls.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (event.shiftKey ? -1 : 0) : at + (event.shiftKey ? -1 : 1);
      controls.at(next % controls.length)!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (before?.isConnected) before.focus(); };
  }, []);
  return (
    <Layer modal>
      <div ref={root} role="dialog" aria-modal="true" aria-label={label ?? title} data-settings-look="simple" data-settings-dialog=""
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <div className="relative flex max-h-full w-full max-w-[440px] flex-col gap-4 overflow-y-auto rounded-2xl border-[0.5px] border-(--settings-edge) bg-app p-6 text-ink shadow-xl">
          <DialogTitle title={title} onClose={onClose} />
          {children}
          {footer && <div className="flex items-center justify-end gap-2">{footer}</div>}
        </div>
      </div>
    </Layer>
  );
}
