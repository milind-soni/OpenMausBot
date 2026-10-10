import { Reply, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { peerLine } from "@/lib/peer-message";
import { replyAuthor, replySnippet } from "@/lib/replies";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

/** The message a sent message answers, in the same soft strip family as the
 * composer's reply strip: arrow, who, a one-line excerpt. A click jumps to it. */
export function ReplyQuote({
  message,
  fallbackName,
  onJump,
  onClear,
  compact = false,
}: {
  message: Message;
  fallbackName?: string;
  onJump?: () => void;
  onClear?: () => void;
  compact?: boolean;
}) {
  const name = replyAuthor(message, fallbackName);
  const body = (
    <>
      <Reply size={compact ? 14 : 15} strokeWidth={1.5} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
      <span className="sr-only">{t("chat.reply.replyingTo", { name })}: </span>
      <span aria-hidden="true" className="shrink-0 font-medium text-ink">{name}</span>
      <span dir="auto" className="min-w-0 flex-1 truncate">{replySnippet(peerLine(message)?.body ?? message.text ?? "")}</span>
    </>
  );
  return (
    <div className={cn(
      "flex min-w-0 items-center gap-2 rounded-2xl bg-ink/[0.06] text-ink-secondary",
      compact ? "py-1 ps-2.5 pe-2 text-[12.5px] leading-5" : "py-1.5 ps-3 pe-1.5 text-[13px] leading-5",
    )}>
      {onJump ? (
        <button type="button" onClick={onJump} className="flex min-w-0 flex-1 items-center gap-2 rounded-xl text-start hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" title={t("chat.reply.jump")}>
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onClear && (
        <button type="button" onClick={onClear} aria-label={t("chat.reply.cancel")} className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** The message being replied to, as one soft strip at the top of the
 * composer box: the reply arrow, a one-line excerpt and a small x. Who it
 * answers is in its accessible name and tooltip. */
export function ComposerReplyStrip({
  message,
  fallbackName,
  onClear,
}: {
  message: Message;
  fallbackName?: string;
  onClear?: () => void;
}) {
  const who = t("chat.reply.replyingTo", { name: replyAuthor(message, fallbackName) });
  const excerpt = replySnippet(peerLine(message)?.body ?? message.text ?? "");
  return (
    <div
      role="group"
      aria-label={who}
      title={who}
      data-composer-reply=""
      className="mb-1 flex min-w-0 items-center gap-2 rounded-2xl bg-ink/[0.06] py-1.5 ps-3 pe-1.5 text-[13px] leading-5 text-ink-secondary"
    >
      <Reply size={15} strokeWidth={1.5} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
      <span className="sr-only">{who}: </span>
      <span dir="auto" className="min-w-0 flex-1 truncate">{excerpt}</span>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={t("chat.reply.cancel")}
          title={t("chat.reply.cancel")}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
