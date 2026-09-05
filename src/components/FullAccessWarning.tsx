import { useEffect, useRef } from "react";
import { ShieldAlert } from "lucide-react";

export const FULL_ACCESS_WARNING =
  "This bot can read, edit, delete files, use the internet, and control its selected computer without asking—even for potentially destructive or sensitive actions. Some providers may still require approval. Requests that come from another bot still get the usual checks. Questions and separate OpenMausBot confirmations still wait for you. This does not grant operating-system permissions or access to accounts you have not connected.";

export function FullAccessWarning({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="full-access-warning-title"
        aria-describedby="full-access-warning-body"
        className="w-full max-w-[440px] rounded-2xl border border-danger/30 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert size={19} className="mt-0.5 shrink-0 text-danger" />
          <div>
            <h2 id="full-access-warning-title" className="text-[15px] font-semibold text-ink">
              Enable Full access?
            </h2>
            <p id="full-access-warning-body" className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {FULL_ACCESS_WARNING}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-danger px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            Enable full access
          </button>
        </div>
      </div>
    </div>
  );
}
