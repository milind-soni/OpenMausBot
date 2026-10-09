import { X } from "lucide-react";
import { t } from "@/lib/i18n";

/** The chat and room error line. Callers pass the store error; dismissing
 * clears it, and the store clears it on its own after a few seconds. */
export function ChatErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="w-full px-5">
      <div role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
        <p className="min-w-0 flex-1">{message}</p>
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
