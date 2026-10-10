import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { plainErrorLine } from "@/lib/plain-error";

/** The chat and room error line. Callers pass the store error; dismissing
 * clears it, and the store clears it on its own after a few seconds. A
 * machine's words (a bare HTTP status, "Failed to fetch", a JSON body) read
 * as one plain line, with the original under Details. */
export function ChatErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  const plain = plainErrorLine(message);
  return (
    <div className="w-full px-5">
      <div role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
        <div className="min-w-0 flex-1 break-words">
          <p>{plain ?? message}</p>
          {plain && <details className="mt-1 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("chat.error.details")}</summary><p dir="auto" className="mt-1 break-words">{message}</p></details>}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("chat.error.dismiss")}
          title={t("chat.error.dismiss")}
          className="shrink-0 rounded p-0.5 hover:bg-danger/10"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
