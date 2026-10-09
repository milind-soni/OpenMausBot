import { RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";

/** A turn the person or the client stopped. A muted line, not an error,
 * with the same Retry a failed turn already offers. */
export function CancelledTurnRow({ onRetry }: { onRetry?: () => void }) {
  return (
    <div role="status" className="flex w-fit max-w-full flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
      <span>{t("chat.turnStopped")}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <RefreshCw size={12} /> {t("chat.retry")}
        </button>
      )}
    </div>
  );
}
