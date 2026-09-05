import { useEffect, useRef } from "react";

import { cn } from "@/lib/cn";
import type { Toast } from "./spaces-toasts";

/** A bot you are not watching just finished something. Suppressed in grid
 * view, where the card itself is already visible. */
export function SpacesToasts({ toasts, onPick }: { toasts: Toast[]; onPick: (subjectId: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute right-6 top-6 z-20 flex w-[22rem] max-w-[calc(100vw-3rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onPick={() => onPick(toast.subjectId)} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onPick }: { toast: Toast; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [
        { opacity: 0, transform: "translateX(12px) scale(0.98)" },
        { opacity: 1, transform: "translateX(0) scale(1)" },
      ],
      { duration: 220, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
    );
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onPick}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-hairline/40 bg-panel/95 px-3 py-2.5 text-left shadow-xl backdrop-blur",
        "hover:border-accent/40",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{toast.name}</span>
        <span className="mt-0.5 block truncate text-[12px] text-ink-secondary">{toast.text}</span>
      </span>
    </button>
  );
}
