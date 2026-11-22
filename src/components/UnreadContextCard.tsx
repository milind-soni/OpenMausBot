import type { Message } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/relative-time";
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
    <div className="w-full px-5" data-unread-context-card data-testid="unread-context-card">
      <div className="mb-2 rounded-lg border border-hairline/40 bg-inset/60 px-3 py-2">
        <div data-unread-context-header className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[12px] font-medium text-ink-secondary">{t("chat.unreadContext.title")}</span>
          <span className="shrink-0 text-[11px] text-ink-tertiary">{localizedRelativeTime(message.at, activeLocale())}</span>
        </div>
        {/* Each part carries its own line limit, so the card grows to fit them instead of cutting a citation in half. */}
        <div className="mt-1" data-unread-context-body>
          {content.text && (
            <div dir="auto" data-unread-context-text className="line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-relaxed text-ink">
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
          <div className="mt-1 text-[11px] text-ink-tertiary">{t("chat.unreadContext.moreCitations", { count: hiddenCitations })}</div>
        )}
        <div data-unread-context-actions className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onJump}
            className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] hover:bg-raised"
          >
            {t("chat.citation.goToSource")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-white"
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
