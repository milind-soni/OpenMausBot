import { X } from "lucide-react";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/relative-time";
import { ELEVATED_FLOAT } from "./elevated";
import { hasUnreadContextContent, unreadContextCitations, unreadContextContent, type UnreadContextAttachment } from "@/lib/unread-context";

function attachmentLabel(kind: UnreadContextAttachment): string {
  if (kind === "images") return t("chat.unreadContext.images");
  if (kind === "files") return t("chat.unreadContext.files");
  return `${t("chat.unreadContext.images")} / ${t("chat.unreadContext.files")}`;
}

/** The message that started the turn waiting above the unread divider, shown at the top of the conversation. */
export function UnreadContextCard({
  message,
  onJump,
  onClose,
}: {
  message: Message;
  onJump: () => void;
  onClose: () => void;
}) {
  const content = unreadContextContent(message);
  if (!hasUnreadContextContent(content)) return null;
  const { shown: citations, hidden: hiddenCitations } = unreadContextCitations(content.citations);
  return (
    <div className="w-full bg-app px-4 pb-2" data-unread-context-card data-testid="unread-context-card">
      <div data-unread-context-surface className={cn("chat-column rounded-xl px-3 pt-1.5 pb-2.5", ELEVATED_FLOAT)}>
        <div className="flex min-h-7 items-center gap-2 text-[12px] leading-4 font-medium">
          <div data-unread-context-header className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-ink-secondary">{t("chat.unreadContext.title")}</span>
            <span className="shrink-0 text-ink-tertiary">{localizedRelativeTime(message.at, activeLocale())}</span>
          </div>
          {/* -me-1: the X's glyph, not its hover circle, ends on the card's inset. */}
          <div data-unread-context-actions className="-me-1 flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={onJump} className="ui-button ui-button-sm ui-button-ghost">
              {t("chat.citation.goToSource")}
            </button>
            <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className="ui-icon-button ui-button-ghost size-6 min-h-0 p-0 touch:size-10">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        {/* Each part carries its own line limit, so the card grows to fit them instead of cutting a citation in half. */}
        <div data-unread-context-body>
          {content.text && (
            <div dir="auto" data-unread-context-text className="line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-[18px] text-ink">
              {content.text}
            </div>
          )}
          {citations.map((citation) => (
            <div key={citation.id} className="mt-1.5 rounded-md border border-accent/20 bg-accent/[0.05] px-2.5 py-1.5" data-unread-context-citation>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">{t("chat.citation.quoted")}</div>
              <div dir="auto" data-unread-context-quote className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink">{citation.quote}</div>
              {citation.comment && (
                <div data-unread-context-comment className="mt-1 line-clamp-2 text-[12px] text-ink-secondary">
                  <span className="font-semibold">{t("chat.citation.comment")}</span> {citation.comment}
                </div>
              )}
            </div>
          ))}
          {content.attachment && (
            <div className="mt-1 text-[13px] text-ink-secondary">{attachmentLabel(content.attachment)}</div>
          )}
        </div>
        {hiddenCitations > 0 && (
          <div className="mt-1 text-[12px] leading-4 text-ink-tertiary">{t("chat.unreadContext.moreCitations", { count: hiddenCitations })}</div>
        )}
      </div>
    </div>
  );
}
