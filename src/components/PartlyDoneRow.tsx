import { CircleAlert, RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";

/** A turn whose reply came back but a step it ran failed or wasn't allowed: done in part, not broken. The step's
 * own row still shows its error; the cause stays one click away. */
export function PartlyDoneRow({ cause, onRetry }: { cause: string; onRetry?: () => void }) {
  return (
    <div className="flex justify-start">
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-xl border border-warning/25 bg-warning/10 px-3.5 py-2.5 text-[14px] text-warning">
        <div className="flex items-start gap-2">
          <CircleAlert size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{t("chat.error.partial")}</span>
        </div>
        <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("chat.error.details")}</summary><p className="mt-1 break-words">{cause}</p></details>
        {onRetry && (
          <button onClick={onRetry} className="ui-button ui-button-md mt-1.5 rounded-full border-warning/30 bg-transparent text-warning hover:bg-warning/15">
            <RefreshCw size={12} /> {t("chat.retry")}
          </button>
        )}
      </div>
    </div>
  );
}
