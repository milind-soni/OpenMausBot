import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cloudWorkNow, cloudWorkTitle, noteCloudUnanswered, onCloudWork, type CloudWork } from "@/lib/cloud-work";
import { t } from "@/lib/i18n";
import { plainErrorLine } from "@/lib/plain-error";
import type { AppState } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";

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

/** A send that failed because the Cloud didn't answer: while an operation of ours has it down, that is expected, not an error. */
const NOT_ANSWERED = /Failed to fetch|NetworkError|Load failed|fetch failed|ECONN(?:RESET|REFUSED|ABORTED)|socket hang up|\b50[234]\b|bad gateway|service unavailable|timed? ?out/i;

/**
 * What the chat's error line is for `message`: `calm` while an operation of ours has the Cloud down and the send just didn't
 * reach it; `gone` for the same message once that is over (`calmFor`: the message last said calmly), which goes away rather
 * than turn into a red "couldn't reach" now that the Cloud is back; `error` otherwise; `none` with no message.
 */
export function chatErrorShape(message: string | null, work: CloudWork | null, calmFor: string | null): "none" | "calm" | "gone" | "error" {
  if (!message) return "none";
  if (work && NOT_ANSWERED.test(message)) return "calm";
  return message === calmFor ? "gone" : "error";
}

export function ChatErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  const member = useTeamPeople()?.admin === false;
  const [work, setWork] = useState(cloudWorkNow);
  const [calmFor, setCalmFor] = useState<string | null>(null);
  // Follows the window's word on an operation of ours (lib/cloud-work.ts), which lives outside React.
  useEffect(() => onCloudWork(setWork), []);
  const shape = chatErrorShape(message, work, calmFor);
  // A send that didn't reach the Cloud: the page asks what has it down now (once per message, not on every render).
  useEffect(() => {
    if (message && NOT_ANSWERED.test(message)) noteCloudUnanswered();
  }, [message]);
  // Said calmly once: kept so that it goes away, rather than turn red, when the Cloud is back; forgotten once it has gone.
  useEffect(() => {
    if (shape === "calm") setCalmFor(message);
    else if (shape === "gone") onDismiss();
    else if (shape === "none") setCalmFor(null);
  }, [shape, message, onDismiss]);
  if (!message || shape === "none" || shape === "gone") return null;
  if (shape === "calm" && work) {
    return (
      <div className="w-full px-5">
        <div role="status" data-chat-cloud-work className="mb-2 flex items-start gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
          <p className="min-w-0 flex-1 break-words">{`${cloudWorkTitle(work, work.name ?? null)}. ${t("cloudWork.notSent")}`}</p>
          <button type="button" onClick={onDismiss} aria-label={t("chat.error.dismiss")} title={t("chat.error.dismiss")} className="shrink-0 rounded p-0.5 hover:bg-raised">
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }
  const plain = plainErrorLine(message) ?? (member && message.startsWith("forbidden:") ? t("serverError.chat.ownerOrAdmin") : undefined);
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
