import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";

export const addressPreview = (value: string): string => {
  if (value.length <= 3) return "…";
  if (value.length < 10) return `${value.slice(0, 3)}…`;
  if (value.length < 17) return `${value.slice(0, 4)}…${value.slice(-3)}`;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
};

/** Routes are operational details, not credentials. They stay compact until
 * explicitly revealed so the normal setup UI never leads with network noise. */
export function ConnectionDetail({ label, value }: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false);
  // Clipboard access is best effort; the Reveal action remains available.
  const { state: copyState, copy } = useCopyFeedback(value);

  return (
    <div className="flex items-center gap-3 rounded-lg bg-inset px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{label}</div>
        <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink">
          {revealed ? value : addressPreview(value)}
        </div>
      </div>
      <button
        onClick={() => setRevealed((current) => !current)}
        className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-secondary hover:bg-control hover:text-ink"
      >
        {revealed ? "Hide" : "Reveal"}
      </button>
      <button
        onClick={copy}
        aria-label={copyState === "failed" ? t("common.copyFailed") : `Copy ${label}`}
        className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control hover:text-ink"
      >
        {copyState === "copied" ? <Check size={13} className="text-success" /> : copyState === "failed" ? <X size={13} className="text-danger" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
