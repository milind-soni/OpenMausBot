import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";

export type Toast = { text: string; undo: () => void };

const SHOWN_MS = 6000;

/** A toast with Undo, kept for a few seconds; a newer one replaces it. */
export function useUndoToast(): [toast: Toast | null, show: (toast: Toast | null) => void] {
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);
  return [toast, setToast];
}

export function UndoToast({ toast, onDone }: { toast: Toast | null; onDone: () => void }) {
  if (!toast) return null;
  return createPortal(
    <div role="status" className="fixed bottom-4 start-[calc(var(--rail-beside,0px)_+_1rem)] z-[60] flex max-w-[340px] items-center gap-3 rounded-xl border border-hairline/50 bg-card px-3.5 py-2.5 text-[13px] text-ink shadow-xl animate-fade-in motion-reduce:animate-none">
      <span className="min-w-0 line-clamp-2">{toast.text}</span>
      <button type="button" onClick={() => { toast.undo(); onDone(); }} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-text hover:bg-ink/[0.06]">{t("common.undo")}</button>
    </div>,
    document.body,
  );
}
