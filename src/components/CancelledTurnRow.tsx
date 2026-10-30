import { RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { PERSON_STOPPED_TURN_NAME } from "../../shared/client-cancel";

/** A stopped turn, never an error. `name` is the row's tool name: a turn the person stopped says so. */
export function CancelledTurnRow({ onRetry, name }: { onRetry?: () => void; name?: string }) {
  return (
    <div role="status" className="flex w-fit max-w-full flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
      <span>{t(name === PERSON_STOPPED_TURN_NAME ? "chat.turnStoppedByYou" : "chat.turnStopped")}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-full border border-hairline/40 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <RefreshCw size={12} /> {t("chat.retry")}
        </button>
      )}
    </div>
  );
}
