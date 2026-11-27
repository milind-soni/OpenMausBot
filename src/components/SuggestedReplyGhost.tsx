import { t } from "@/lib/i18n";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";

export const SUGGESTION_HINT_ID = "composer-suggested-reply-hint";
const TAPPED = `(hover: none) and (pointer: coarse), ${PHONE_LAYOUT}`;

/** The faded suggestion drawn where the empty field's placeholder sits: a Tab keycap after it, or on a touch screen a
 * small button that fills the field, also in the phone layout. */
export function SuggestedReplyGhost({ text, onUse }: { text: string; onUse(): void }) {
  const touch = useMediaQuery(TAPPED);
  return (
    <div data-suggested-reply className="flex min-w-0 items-center gap-2 text-ink-tertiary">
      <span aria-hidden="true" className="min-w-0 truncate">{text}</span>
      {touch ? (
        <button type="button" onClick={onUse} aria-label={t("composer.suggestion.use")}
          className="pointer-events-auto relative z-[1] shrink-0 rounded-full border border-hairline px-2 text-[12px] leading-5 text-ink-secondary transition-colors duration-[120ms] hover:bg-raised-hover motion-reduce:transition-none">
          {t("composer.suggestion.useShort")}
        </button>
      ) : (
        <kbd aria-hidden="true" className="shrink-0 rounded border border-hairline/50 px-1.5 py-0.5 font-sans text-[11px] leading-none text-ink-tertiary">
          {t("composer.suggestion.key")}
        </kbd>
      )}
      <span id={SUGGESTION_HINT_ID} className="sr-only">{touch ? t("composer.suggestion.hintTouch") : t("composer.suggestion.hint")}</span>
    </div>
  );
}
