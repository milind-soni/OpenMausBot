import { t } from "@/lib/i18n";
import { UNREAD_DIVIDER_FADE_MS } from "@/lib/unread-divider";
import { cn } from "@/lib/cn";

/** The line above the first message that came in while the person was away.
 * Fading, it folds its height and the transcript gap with it, so the rows
 * around it close up without a jump. */
export function NewMessagesDivider({ fading }: { fading: boolean }) {
  return (
    <div
      role="separator"
      aria-label={t("chat.newMessagesAria")}
      data-unread-divider
      className={cn(
        "grid ease-out transition-[grid-template-rows,opacity,margin-bottom] motion-reduce:transition-none",
        fading ? "-mb-3 grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
      )}
      style={{ transitionDuration: `${UNREAD_DIVIDER_FADE_MS}ms` }}
    >
      <div className="min-h-0 overflow-hidden">
        <div aria-hidden="true" className="animate-msg-in flex items-center gap-3 py-0.5">
          <span className="h-px flex-1 bg-linear-to-r from-transparent to-accent/60 rtl:bg-linear-to-l" />
          <span className="text-[11px] font-semibold uppercase leading-4 tracking-[0.08em] text-accent-text">
            {t("chat.newMessages")}
          </span>
          <span className="h-px flex-1 bg-linear-to-l from-transparent to-accent/60 rtl:bg-linear-to-r" />
        </div>
      </div>
    </div>
  );
}
