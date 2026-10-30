import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { plainErrorLine } from "@/lib/plain-error";
import type { AppState } from "@/state/store";

export function ChatNotice({ notice }: { notice: AppState["notice"] }) {
  if (!notice) return null;
  return (
    <div className="w-full px-5">
      <div role="status" className="mb-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
        {notice.kind === "note"
          ? notice.text
          : notice.kind === "steer-images"
            ? t("composer.queued.steerImagesHeld")
            : notice.kind === "bot-gone"
              ? t("thread.botGone")
              : notice.botName ? t("thread.goneShowing", { name: notice.botName }) : t("thread.gone")}
      </div>
    </div>
  );
}

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
