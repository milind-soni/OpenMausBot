import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { forgetFailedComposerSend, type FailedComposerSend } from "@/lib/drafts";

/** A row per message that didn't send: its text, Retry, and dismiss. */
export function ComposerFailedSends({ draftId, failedSends, onRetry }: {
  draftId: string;
  failedSends: readonly FailedComposerSend[];
  onRetry: (failed: FailedComposerSend) => void;
}) {
  return failedSends.map((failed) => (
    <div
      key={failed.id}
      className="mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
    >
      <span className="min-w-0 flex-1 truncate">
        {t("composer.failed.notSent", {
          text: failed.text.trim() || t("composer.failed.attachment"),
        })}
      </span>
      <button
        type="button"
        onClick={() => onRetry(failed)}
        className="shrink-0 rounded px-2 py-1 font-medium hover:bg-danger/10"
      >
        {t("chat.retry")}
      </button>
      <button
        type="button"
        onClick={() => forgetFailedComposerSend(draftId, failed.id)}
        aria-label={t("composer.failed.dismissAria")}
        title={t("composer.failed.dismiss")}
        className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
      >
        <X size={13} strokeWidth={2.5} />
      </button>
    </div>
  ));
}
