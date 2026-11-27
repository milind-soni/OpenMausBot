import { useEffect } from "react";
import { X } from "lucide-react";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MausAvatar } from "./Avatar";
import { GrokBotMark } from "./GrokBotMark";
import { NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

export const GROK_MOVE_POPUP = "[data-grok-move-popup]";
const TITLE = "grok-move-popup-title";
const BODY = "grok-move-popup-body";

export type GrokMovePopupAction = "start" | "not_now" | "close";

export function reportGrokMovePopup(action: GrokMovePopupAction | "shown"): void {
  track("grok_move_popup", { action });
}

/** Once per person (AppNotices): the two marks and one way in. Not now, × and Escape close it for good; the dialog stays in
 * Settings → Import. */
export function GrokMovePopup({ onDone }: { onDone: (action: GrokMovePopupAction) => void }) {
  useEffect(() => {
    document.querySelector<HTMLElement>(`${GROK_MOVE_POPUP} [data-primary]`)?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = document.querySelector<HTMLElement>(GROK_MOVE_POPUP);
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDone("close");
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>("button")];
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement), step = event.shiftKey ? -1 : 1;
      controls[at === -1 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length]?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="ui-scrim fixed inset-0 z-50 flex items-center justify-center p-4 motion-reduce:animate-none">
      <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby={BODY} data-grok-move-popup=""
        className="ui-modal animate-pop-in relative flex w-[min(380px,calc(100vw-32px))] flex-col items-center border-0 px-6 pb-3 pt-8 text-center text-ink motion-reduce:animate-none">
        <div aria-hidden="true" className="flex items-center gap-5">
          <GrokBotMark size={44} />
          <MausAvatar color="chrome" size={52} state="idle" animated={false} />
        </div>
        <h2 id={TITLE} className="mt-5 text-[19px] font-semibold leading-6 tracking-[-0.012em]">{t("settings.import.grokTitle")}</h2>
        <p id={BODY} className="mt-1.5 text-[14px] leading-5 text-ink-secondary [text-wrap:pretty]">{t("grokMove.popup.body")}</p>
        <button type="button" data-primary="" onClick={() => onDone("start")} className={cn(PRIMARY_BUTTON, "mt-5 w-full")}>{t("grokMove.popup.start")}</button>
        <div className="mt-1"><NotNowButton onClick={() => onDone("not_now")} /></div>
        <button type="button" onClick={() => onDone("close")} aria-label={t("common.close")} className="ui-icon-button absolute end-3 top-3"><X size={16} /></button>
      </div>
    </div>
  );
}
